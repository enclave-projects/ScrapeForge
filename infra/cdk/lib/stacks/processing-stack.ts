import { Stack, type StackProps, Duration, CfnOutput } from "aws-cdk-lib"
import * as ec2 from "aws-cdk-lib/aws-ec2"
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
  jobsTable: dynamodb.ITable
}

/**
 * ARD §2.5 (Processing/LLM-Markdown Tier). TRD §11 open decision #1
 * resolved: zai.glm-4.7-flash on Bedrock, ap-south-1.
 *
 * Bedrock access is a pre-provisioned long-term API key against an
 * OpenAI-compatible gateway ("Bedrock Mantle" in this account) - not
 * the AWS SDK's BedrockRuntimeClient. That path was tried first: an IAM
 * user + service-specific credential (bearer-token auth against the
 * Converse/InvokeModel APIs), which is the standard way to get a
 * long-term Bedrock API key. It hit a real, account-level wall:
 * `aws bedrock get-foundation-model-availability` showed
 * `authorizationStatus: NOT_AUTHORIZED` for this model — Bedrock's
 * per-model access agreement (a EULA) hadn't been accepted for this
 * account, which blocks model invocation regardless of IAM permissions
 * or auth method. Accepting that agreement is a business decision, not
 * something to do silently via CDK. The Mantle gateway sidesteps this
 * requirement entirely and was confirmed working with a real request
 * before being wired in here, using a key already provisioned outside
 * this session.
 *
 * This stack only creates BedrockApiKeySecret, an *empty* Secrets
 * Manager secret as a stable place for that key to live — no IAM user
 * needed for it. Populate it once with:
 *   aws secretsmanager put-secret-value --secret-id <this secret's ARN> \
 *     --secret-string <the Mantle API key>
 * ProcessingFn reads it at runtime (services/processing/src/handler.ts)
 * and passes it to BedrockLLMClient as a bearer token against
 * BEDROCK_BASE_URL — see packages/llm-client's config.
 */
export class ProcessingStack extends Stack {
  public readonly bedrockApiKeySecret: secretsmanager.Secret
  public readonly processingFn: lambdaNode.NodejsFunction

  static readonly BEDROCK_MODEL_ID = "zai.glm-4.7-flash"
  static readonly BEDROCK_BASE_URL =
    "https://bedrock-mantle.ap-south-1.api.aws/v1"

  constructor(scope: Construct, id: string, props: ProcessingStackProps) {
    super(scope, id, props)

    this.bedrockApiKeySecret = new secretsmanager.Secret(
      this,
      "BedrockApiKeySecret",
      {
        description:
          "Long-term Bedrock (Mantle gateway) API key - populate manually, see class doc comment",
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
        JOBS_TABLE_NAME: props.jobsTable.tableName,
        BEDROCK_MODEL_ID: ProcessingStack.BEDROCK_MODEL_ID,
        BEDROCK_BASE_URL: ProcessingStack.BEDROCK_BASE_URL,
        BEDROCK_API_KEY_SECRET_ARN: this.bedrockApiKeySecret.secretArn,
      },
      bundling: {},
      depsLockFilePath: BUN_LOCK_FILE,
      projectRoot: REPO_ROOT,
    })

    props.rawBucket.grantRead(this.processingFn)
    props.markdownBucket.grantWrite(this.processingFn)
    props.pageMetadataTable.grantReadWriteData(this.processingFn)
    props.jobsTable.grantReadWriteData(this.processingFn)
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
    new CfnOutput(this, "BedrockApiKeySecretArn", {
      value: this.bedrockApiKeySecret.secretArn,
    })
  }
}
