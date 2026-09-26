import { Logger } from "@aws-lambda-powertools/logger"
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics"
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs"
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb"
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn"
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda"
import { randomUUID } from "node:crypto"
import { ZodError } from "zod"
import {
  CrawlRequestSchema,
  ScrapeRequestSchema,
  type ApiEnvelope,
} from "@scrapeforge/shared-types"
import { checkRateLimit, PLAN_RATE_LIMITS, type Plan } from "./rate-limit.js"

const logger = new Logger({ serviceName: "api-router" })
const metrics = new Metrics({
  namespace: "ScrapeForge",
  serviceName: "api-router",
})

// Optional request fields (webhookUrl, ...) are omitted, not stored null.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
})
const sqs = new SQSClient({})
const sfn = new SFNClient({})
const s3 = new S3Client({})

const JOBS_TABLE = process.env.JOBS_TABLE_NAME ?? ""
const PRIORITY_QUEUE_URL = process.env.PRIORITY_QUEUE_URL ?? ""
const CRAWL_ORCHESTRATOR_STATE_MACHINE_ARN =
  process.env.CRAWL_ORCHESTRATOR_STATE_MACHINE_ARN ?? ""
const MARKDOWN_BUCKET_NAME = process.env.MARKDOWN_BUCKET_NAME ?? ""

const RESULT_URL_TTL_SECONDS = 3600
const MAX_LISTED_RESULTS = 100

function respond<T>(
  statusCode: number,
  requestId: string,
  data: T | null,
  error: { code: string; message: string } | null,
  headers: Record<string, string> = {}
): APIGatewayProxyResultV2 {
  const body: ApiEnvelope<T> = {
    success: error === null,
    data,
    error,
    requestId,
  }
  return {
    statusCode,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }
}

/**
 * Plan lives on an account record in the Jobs table (pk "account#<sub>").
 * No record means the default free plan; upgrades are a write to that
 * record (billing integration is out of scope here).
 */
async function getPlan(accountId: string): Promise<Plan> {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: JOBS_TABLE,
      Key: { pk: `account#${accountId}` },
    })
  )
  const plan = Item?.plan as string | undefined
  return plan && plan in PLAN_RATE_LIMITS ? (plan as Plan) : "free"
}

/**
 * ARD §3 step 2-4: rate-limit, validate the incoming request, write the
 * job record, then classify single-URL (priority queue) vs. crawl (Step
 * Functions). Also serves job status + result links.
 */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  const requestId = event.requestContext.requestId
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {}
  const accountId = claims.sub as string | undefined

  if (!accountId) {
    return respond(401, requestId, null, {
      code: "UNAUTHORIZED",
      message: "Missing account context",
    })
  }

  try {
    const plan = await getPlan(accountId)
    try {
      const limit = await checkRateLimit(accountId, plan)
      if (!limit.allowed) {
        metrics.addMetric("RateLimited", MetricUnit.Count, 1)
        return respond(
          429,
          requestId,
          null,
          {
            code: "RATE_LIMITED",
            message: `Plan '${plan}' allows ${limit.limit} requests/second`,
          },
          { "retry-after": String(limit.retryAfterSeconds) }
        )
      }
    } catch (err) {
      // Fail open: a cache outage shouldn't take the whole API down.
      logger.error("Rate limiter unavailable, allowing request", {
        error: err as Error,
      })
      metrics.addMetric("RateLimiterErrors", MetricUnit.Count, 1)
    }

    const route = event.routeKey
    if (route === "GET /v1/jobs/{jobId}") {
      return await getJob(requestId, accountId, event.pathParameters?.jobId)
    }

    const body = event.body ? JSON.parse(event.body) : {}
    const jobId = randomUUID()
    const now = new Date().toISOString()

    if (route === "POST /v1/scrape") {
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
            url: parsed.url,
            webhookUrl: parsed.webhookUrl,
            structuredExtractSchema: parsed.structuredExtractSchema,
            createdAt: now,
            updatedAt: now,
          },
        })
      )
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: PRIORITY_QUEUE_URL,
          MessageBody: JSON.stringify({
            accountId,
            jobId,
            url: parsed.url,
            renderJs: parsed.renderJs,
          }),
        })
      )
      metrics.addMetric("SingleUrlRequestsAccepted", MetricUnit.Count, 1)
      return respond(
        202,
        requestId,
        { jobId, status: "queued", jobType: "single_url" },
        null
      )
    }

    if (route === "POST /v1/crawl") {
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
            url: parsed.rootUrl,
            webhookUrl: parsed.webhookUrl,
            // ID tokens carry the verified sign-in email; crawls are the
            // long-running jobs that get an email on completion (ARD §2.7).
            notifyEmail: claims.email as string | undefined,
            structuredExtractSchema: parsed.structuredExtractSchema,
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
      return respond(
        202,
        requestId,
        { jobId, status: "queued", jobType: "crawl" },
        null
      )
    }

    return respond(404, requestId, null, {
      code: "NOT_FOUND",
      message: `Unknown route ${route}`,
    })
  } catch (err) {
    if (err instanceof ZodError || err instanceof SyntaxError) {
      return respond(400, requestId, null, {
        code: "VALIDATION_ERROR",
        message: err.message,
      })
    }
    logger.error("Request failed", { error: err as Error })
    return respond(500, requestId, null, {
      code: "INTERNAL_ERROR",
      message: "Internal error",
    })
  } finally {
    metrics.publishStoredMetrics()
  }
}

async function getJob(
  requestId: string,
  accountId: string,
  jobId: string | undefined
): Promise<APIGatewayProxyResultV2> {
  // The key embeds the caller's own accountId, so one account can never
  // read another's job even with a guessed jobId.
  const { Item } = jobId
    ? await ddb.send(
        new GetCommand({
          TableName: JOBS_TABLE,
          Key: { pk: `${accountId}#${jobId}` },
        })
      )
    : { Item: undefined }
  if (!Item) {
    return respond(404, requestId, null, {
      code: "NOT_FOUND",
      message: `Job ${jobId} not found`,
    })
  }

  const { pk: _pk, notifyEmail: _email, ...job } = Item
  let results: Array<{ key: string; url: string }> = []
  if (Item.status === "done") {
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: MARKDOWN_BUCKET_NAME,
        Prefix: `${accountId}/${jobId}/`,
        MaxKeys: MAX_LISTED_RESULTS,
      })
    )
    results = await Promise.all(
      (listed.Contents ?? []).map(async ({ Key }) => ({
        key: Key!.split("/").pop()!,
        url: await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: MARKDOWN_BUCKET_NAME, Key: Key! }),
          { expiresIn: RESULT_URL_TTL_SECONDS }
        ),
      }))
    )
  }

  return respond(200, requestId, { ...job, results }, null)
}
