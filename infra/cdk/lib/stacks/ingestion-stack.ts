import { Stack, type StackProps, Duration, RemovalPolicy } from "aws-cdk-lib"
import * as dynamodb from "aws-cdk-lib/aws-dynamodb"
import * as sqs from "aws-cdk-lib/aws-sqs"
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs"
import * as lambda from "aws-cdk-lib/aws-lambda"
import * as iam from "aws-cdk-lib/aws-iam"
import * as sfn from "aws-cdk-lib/aws-stepfunctions"
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks"
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2"
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations"
import type * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers"
import type { Construct } from "constructs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../../../..")
// CDK's NodejsFunction only auto-detects pnpm/yarn/npm lockfiles, not
// bun's text-based bun.lock — point it there explicitly.
const BUN_LOCK_FILE = path.join(REPO_ROOT, "bun.lock")

export interface IngestionStackProps extends StackProps {
  httpApi: apigwv2.HttpApi
  jwtAuthorizer: authorizers.HttpUserPoolAuthorizer
}

/**
 * ARD §2.2 (Ingestion/Orchestration): Request Validator + Router Lambda,
 * Crawl Orchestrator Step Functions, Priority/Bulk SQS queues, Jobs +
 * Crawl State DynamoDB table. EventBridge Scheduler (recurring crawls,
 * PRD §4.8) gets only the IAM role it needs to invoke the state machine
 * here — the schedules themselves are created per-account at request
 * time by the Router Lambda, not known at synth time, and that
 * create/delete-schedule handler logic is not yet implemented (follow-up,
 * not guessed at here).
 */
export class IngestionStack extends Stack {
  public readonly jobsTable: dynamodb.Table
  public readonly priorityQueue: sqs.Queue
  public readonly bulkQueue: sqs.Queue
  public readonly stateMachine: sfn.StateMachine

  constructor(scope: Construct, id: string, props: IngestionStackProps) {
    super(scope, id, props)

    // --- DynamoDB: Jobs + Crawl State (ARD §2.2), single-table design ---
    this.jobsTable = new dynamodb.Table(this, "JobsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY, // dev only
    })

    // --- SQS: Priority (single-URL) + Bulk (crawl) queues with DLQs (ARD §2.2, §6) ---
    const priorityDlq = new sqs.Queue(this, "PriorityQueueDLQ", {
      retentionPeriod: Duration.days(14),
    })
    this.priorityQueue = new sqs.Queue(this, "PriorityQueue", {
      visibilityTimeout: Duration.seconds(30),
      deadLetterQueue: { queue: priorityDlq, maxReceiveCount: 5 },
    })

    const bulkDlq = new sqs.Queue(this, "BulkQueueDLQ", {
      retentionPeriod: Duration.days(14),
    })
    this.bulkQueue = new sqs.Queue(this, "BulkQueue", {
      visibilityTimeout: Duration.seconds(30),
      deadLetterQueue: { queue: bulkDlq, maxReceiveCount: 5 },
    })

    // --- Step Functions: Crawl Orchestrator (ARD §2.2) ---
    const sitemapDiscoveryFn = new lambdaNode.NodejsFunction(
      this,
      "SitemapDiscoveryFn",
      {
        entry: path.join(
          REPO_ROOT,
          "services/crawl-orchestrator/src/sitemap-discovery.ts"
        ),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: Duration.seconds(30),
        bundling: {},
        depsLockFilePath: BUN_LOCK_FILE,
        projectRoot: REPO_ROOT,
      }
    )

    const frontierFn = new lambdaNode.NodejsFunction(this, "FrontierFn", {
      entry: path.join(
        REPO_ROOT,
        "services/crawl-orchestrator/src/frontier.ts"
      ),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(60),
      environment: { BULK_QUEUE_URL: this.bulkQueue.queueUrl },
      bundling: {},
      depsLockFilePath: BUN_LOCK_FILE,
      projectRoot: REPO_ROOT,
    })
    this.bulkQueue.grantSendMessages(frontierFn)

    const sitemapDiscoveryTask = new tasks.LambdaInvoke(
      this,
      "SitemapDiscoveryTask",
      {
        lambdaFunction: sitemapDiscoveryFn,
        outputPath: "$.Payload",
      }
    )
    const frontierTask = new tasks.LambdaInvoke(this, "FrontierTask", {
      lambdaFunction: frontierFn,
      // Merge the sitemap-discovery output (urls) back with the original
      // execution input (accountId, jobId, maxDepth, maxPages, ...).
      // States.JsonMerge (not individual "field.$" references) because
      // includePaths/excludePaths are optional — referencing an absent
      // key directly throws States.Runtime and fails the execution.
      payload: sfn.TaskInput.fromJsonPathAt(
        "States.JsonMerge($$.Execution.Input, $, false)"
      ),
      outputPath: "$.Payload",
    })

    const definition = sitemapDiscoveryTask.next(frontierTask)

    this.stateMachine = new sfn.StateMachine(this, "CrawlOrchestrator", {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.minutes(30),
      tracingEnabled: true,
    })

    // IAM role EventBridge Scheduler assumes to start recurring-crawl
    // executions (PRD §4.8). Schedules themselves are created dynamically
    // per account/job — not a CDK resource here.
    const schedulerRole = new iam.Role(this, "SchedulerExecutionRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    })
    this.stateMachine.grantStartExecution(schedulerRole)

    // --- Lambda: Request Validator + Router (ARD §2.2) ---
    const routerFn = new lambdaNode.NodejsFunction(this, "RouterFn", {
      entry: path.join(REPO_ROOT, "services/api-router/src/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(10),
      environment: {
        JOBS_TABLE_NAME: this.jobsTable.tableName,
        PRIORITY_QUEUE_URL: this.priorityQueue.queueUrl,
        CRAWL_ORCHESTRATOR_STATE_MACHINE_ARN: this.stateMachine.stateMachineArn,
      },
      bundling: {},
      depsLockFilePath: BUN_LOCK_FILE,
      projectRoot: REPO_ROOT,
    })
    this.jobsTable.grantWriteData(routerFn)
    this.priorityQueue.grantSendMessages(routerFn)
    this.stateMachine.grantStartExecution(routerFn)
    // The Router will eventually call scheduler:CreateSchedule/DeleteSchedule
    // for PRD §4.8 recurring crawls; not granted yet since that handler
    // logic doesn't exist (avoids granting unused permissions).
    void schedulerRole

    // --- Wire HTTP API routes to the Router Lambda (EdgeStack's httpApi) ---
    const routerIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      "RouterIntegration",
      routerFn
    )
    props.httpApi.addRoutes({
      path: "/v1/scrape",
      methods: [apigwv2.HttpMethod.POST],
      integration: routerIntegration,
      authorizer: props.jwtAuthorizer,
    })
    props.httpApi.addRoutes({
      path: "/v1/crawl",
      methods: [apigwv2.HttpMethod.POST],
      integration: routerIntegration,
      authorizer: props.jwtAuthorizer,
    })
    props.httpApi.addRoutes({
      path: "/v1/jobs/{jobId}",
      methods: [apigwv2.HttpMethod.GET],
      integration: routerIntegration,
      authorizer: props.jwtAuthorizer,
    })
  }
}
