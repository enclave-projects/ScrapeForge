import { Stack, type StackProps, Duration, CfnOutput } from "aws-cdk-lib"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as iam from "aws-cdk-lib/aws-iam"
import * as s3 from "aws-cdk-lib/aws-s3"
import * as dynamodb from "aws-cdk-lib/aws-dynamodb"
import * as events from "aws-cdk-lib/aws-events"
import * as targets from "aws-cdk-lib/aws-events-targets"
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager"
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs"
import * as lambda from "aws-cdk-lib/aws-lambda"
import type { Construct } from "constructs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../../../..")
const BUN_LOCK_FILE = path.join(REPO_ROOT, "bun.lock")

export interface ProcessingStackProps extends StackProps {
  vpc: ec2.IVpc
  rawBucket: s3.Bucket
  markdownBucket: s3.Bucket
  pageMetadataTable: dynamodb.Table
  redisEndpoint: string
  redisPort: string
  jobCompleteBus: events.EventBus
}

/**
 * ARD §2.5 (Processing/LLM-Markdown Tier). TRD §11 open decision #1
 * resolved: zai.glm-4.7-flash on Bedrock, ap-south-1, ON_DEMAND.
 *
 * Bedrock auth is a long-term API key (bearer token), not the Lambda's
 * IAM role — an explicit choice overriding the "never create IAM users"
 * guardrail, made deliberately for this one case. Long-term Bedrock API
 * keys are IAM *service-specific credentials*, which only exist for IAM
 * users, not roles, and CloudFormation has no resource type for them at
 * all. So this stack can only get partway there:
 *   1. Creates BedrockApiKeyUser, an IAM user with an inline policy
 *      scoped to bedrock:InvokeModel/InvokeModelWithResponseStream on
 *      exactly the zai.glm-4.7-flash model ARN in this account/region —
 *      nothing else.
 *   2. Creates BedrockApiKeySecret, an *empty* Secrets Manager secret as
 *      a stable place for the key to live.
 * The credential itself must be generated out-of-band, once, via:
 *   aws iam create-service-specific-credential \
 *     --user-name <BedrockApiKeyUser physical name> \
 *     --service-name bedrock.amazonaws.com
 * then its ServicePassword written into BedrockApiKeySecret with
 * `aws secretsmanager put-secret-value`. ProcessingFn reads the secret
 * at runtime (services/processing/src/handler.ts) and passes it to
 * BedrockLLMClient as a bearer token — see packages/llm-client's
 * `apiKey` config option.
 */
export class ProcessingStack extends Stack {
  public readonly bedrockApiKeyUser: iam.User
  public readonly bedrockApiKeySecret: secretsmanager.Secret
  public readonly processingFn: lambdaNode.NodejsFunction

  static readonly BEDROCK_MODEL_ID = "zai.glm-4.7-flash"

  constructor(scope: Construct, id: string, props: ProcessingStackProps) {
    super(scope, id, props)

    // --- Bedrock long-term API key: scoped IAM user + placeholder secret ---
    this.bedrockApiKeyUser = new iam.User(this, "BedrockApiKeyUser", {
      userName: "scrapeforge-dev-bedrock-processing",
    })
    this.bedrockApiKeyUser.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/${ProcessingStack.BEDROCK_MODEL_ID}`,
        ],
      })
    )

    this.bedrockApiKeySecret = new secretsmanager.Secret(
      this,
      "BedrockApiKeySecret",
      {
        description:
          "Long-term Bedrock API key (service-specific credential) for BedrockApiKeyUser - populate manually, see class doc comment",
      }
    )

    // --- Processing Lambda: readability -> dedup -> markdown -> store -> notify ---
    this.processingFn = new lambdaNode.NodejsFunction(this, "ProcessingFn", {
      entry: path.join(REPO_ROOT, "services/processing/src/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(60),
      memorySize: 1024,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      environment: {
        MARKDOWN_BUCKET_NAME: props.markdownBucket.bucketName,
        PAGE_METADATA_TABLE_NAME: props.pageMetadataTable.tableName,
        REDIS_HOST: props.redisEndpoint,
        REDIS_PORT: props.redisPort,
        JOB_COMPLETE_BUS_NAME: props.jobCompleteBus.eventBusName,
        BEDROCK_MODEL_ID: ProcessingStack.BEDROCK_MODEL_ID,
        BEDROCK_API_KEY_SECRET_ARN: this.bedrockApiKeySecret.secretArn,
      },
      bundling: {},
      depsLockFilePath: BUN_LOCK_FILE,
      projectRoot: REPO_ROOT,
    })

    props.rawBucket.grantRead(this.processingFn)
    props.markdownBucket.grantWrite(this.processingFn)
    props.pageMetadataTable.grantReadWriteData(this.processingFn)
    props.jobCompleteBus.grantPutEventsTo(this.processingFn)
    this.bedrockApiKeySecret.grantRead(this.processingFn)
    // No extra security-group rule needed: CacheStack's Redis SG already
    // allows ingress from the whole VPC CIDR, which covers ProcessingFn.
    // (An explicit rule here would also create a circular stack
    // dependency: it'd live on CacheStack's SG construct but reference
    // ProcessingStack's Lambda SG, while ProcessingStack already depends
    // on CacheStack for the Redis endpoint.)

    // EventBridge, not a direct S3 notification - see StorageStack's
    // RawBucket doc comment for why (avoids a circular stack dependency).
    new events.Rule(this, "RawObjectCreatedRule", {
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created"],
        detail: { bucket: { name: [props.rawBucket.bucketName] } },
      },
      targets: [new targets.LambdaFunction(this.processingFn)],
    })

    new CfnOutput(this, "ProcessingFnName", {
      value: this.processingFn.functionName,
    })
    new CfnOutput(this, "BedrockApiKeyUserName", {
      value: this.bedrockApiKeyUser.userName,
    })
    new CfnOutput(this, "BedrockApiKeySecretArn", {
      value: this.bedrockApiKeySecret.secretArn,
    })
  }
}
