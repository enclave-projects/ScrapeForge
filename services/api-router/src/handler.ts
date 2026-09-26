import { Logger } from "@aws-lambda-powertools/logger"
import { Tracer } from "@aws-lambda-powertools/tracer"
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics"
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs"
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb"
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn"
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda"
import { randomUUID } from "node:crypto"
import {
  CrawlRequestSchema,
  ScrapeRequestSchema,
  type ApiEnvelope,
} from "@scrapeforge/shared-types"

const logger = new Logger({ serviceName: "api-router" })
const tracer = new Tracer({ serviceName: "api-router" })
const metrics = new Metrics({
  namespace: "ScrapeForge",
  serviceName: "api-router",
})

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const sqs = new SQSClient({})
const sfn = new SFNClient({})

const JOBS_TABLE = process.env.JOBS_TABLE_NAME ?? ""
const PRIORITY_QUEUE_URL = process.env.PRIORITY_QUEUE_URL ?? ""
const CRAWL_ORCHESTRATOR_STATE_MACHINE_ARN =
  process.env.CRAWL_ORCHESTRATOR_STATE_MACHINE_ARN ?? ""

function envelope<T>(
  requestId: string,
  data: T | null,
  error: { code: string; message: string } | null
): ApiEnvelope<T> {
  return { success: error === null, data, error, requestId }
}

/**
 * ARD §3 step 2-4: validate the incoming request, write the job record,
 * then classify single-URL (priority queue) vs. crawl (Step Functions).
 */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  const requestId = event.requestContext.requestId
  const accountId = event.requestContext.authorizer?.jwt?.claims?.sub as
    string | undefined

  if (!accountId) {
    return {
      statusCode: 401,
      body: JSON.stringify(
        envelope(requestId, null, {
          code: "UNAUTHORIZED",
          message: "Missing account context",
        })
      ),
    }
  }

  const path = event.rawPath
  const body = event.body ? JSON.parse(event.body) : {}
  const jobId = randomUUID()
  const now = new Date().toISOString()

  try {
    if (path.endsWith("/scrape")) {
      const parsed = ScrapeRequestSchema.parse(body)
      await ddb.send(
        new PutCommand({
          TableName: JOBS_TABLE,
          Item: {
            pk: `${accountId}#${jobId}`,
            accountId,
            jobId,
            jobType: "single_url",
            status: "queued",
            createdAt: now,
            updatedAt: now,
          },
        })
      )
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: PRIORITY_QUEUE_URL,
          MessageBody: JSON.stringify({ accountId, jobId, ...parsed }),
        })
      )
      metrics.addMetric("SingleUrlRequestsAccepted", MetricUnit.Count, 1)
      return {
        statusCode: 202,
        body: JSON.stringify(envelope(requestId, { jobId }, null)),
      }
    }

    if (path.endsWith("/crawl")) {
      const parsed = CrawlRequestSchema.parse(body)
      await ddb.send(
        new PutCommand({
          TableName: JOBS_TABLE,
          Item: {
            pk: `${accountId}#${jobId}`,
            accountId,
            jobId,
            jobType: "crawl",
            status: "queued",
            createdAt: now,
            updatedAt: now,
          },
        })
      )
      await sfn.send(
        new StartExecutionCommand({
          stateMachineArn: CRAWL_ORCHESTRATOR_STATE_MACHINE_ARN,
          name: jobId,
          input: JSON.stringify({ accountId, jobId, ...parsed }),
        })
      )
      metrics.addMetric("CrawlRequestsAccepted", MetricUnit.Count, 1)
      return {
        statusCode: 202,
        body: JSON.stringify(envelope(requestId, { jobId }, null)),
      }
    }

    return {
      statusCode: 404,
      body: JSON.stringify(
        envelope(requestId, null, {
          code: "NOT_FOUND",
          message: `Unknown route ${path}`,
        })
      ),
    }
  } catch (err) {
    logger.error("Request validation/routing failed", { error: err as Error })
    return {
      statusCode: 400,
      body: JSON.stringify(
        envelope(requestId, null, {
          code: "VALIDATION_ERROR",
          message: (err as Error).message,
        })
      ),
    }
  } finally {
    metrics.publishStoredMetrics()
  }
}
