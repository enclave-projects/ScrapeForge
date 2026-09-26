import { Logger } from "@aws-lambda-powertools/logger"
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3"
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager"
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge"
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb"
import type { EventBridgeEvent } from "aws-lambda"
import { BedrockLLMClient } from "@scrapeforge/llm-client"
import { stripBoilerplate } from "./readability-strip.js"
import { convertToMarkdown } from "./markdown-converter.js"
import { checkDedup, recordPageMetadata } from "./dedup.js"
import { structuredExtract } from "./structured-extract.js"

interface S3ObjectCreatedDetail {
  bucket: { name: string }
  object: { key: string }
}

/** The subset of the Jobs table record (ARD §2.2) this Lambda reads. */
interface JobItem {
  jobType: "single_url" | "crawl"
  status: string
  webhookUrl?: string
  notifyEmail?: string
  structuredExtractSchema?: Record<string, string>
  pagesTotal?: number
  pagesCompleted?: number
  pagesFailed?: number
}

const logger = new Logger({ serviceName: "processing" })
const s3 = new S3Client({})
const secretsManager = new SecretsManagerClient({})
const eventBridge = new EventBridgeClient({})
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const MARKDOWN_BUCKET_NAME = process.env.MARKDOWN_BUCKET_NAME ?? ""
const JOB_COMPLETE_BUS_NAME = process.env.JOB_COMPLETE_BUS_NAME ?? ""
const JOBS_TABLE_NAME = process.env.JOBS_TABLE_NAME ?? ""
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? ""
const BEDROCK_BASE_URL = process.env.BEDROCK_BASE_URL ?? ""
const BEDROCK_API_KEY_SECRET_ARN = process.env.BEDROCK_API_KEY_SECRET_ARN ?? ""

let cachedLlmClient: BedrockLLMClient | undefined

/**
 * Lazily builds the Bedrock client using the pre-provisioned long-term
 * API key stored in Secrets Manager (see processing-stack.ts's doc
 * comment for why this gateway, not the AWS SDK's BedrockRuntimeClient).
 */
async function getLlmClient(): Promise<BedrockLLMClient> {
  if (cachedLlmClient) return cachedLlmClient
  const secret = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: BEDROCK_API_KEY_SECRET_ARN })
  )
  const apiKey = secret.SecretString
  if (!apiKey) {
    throw new Error("Bedrock API key secret is empty")
  }
  cachedLlmClient = new BedrockLLMClient({
    modelId: BEDROCK_MODEL_ID,
    baseUrl: BEDROCK_BASE_URL,
    apiKey,
  })
  return cachedLlmClient
}

/**
 * ARD §3 steps 8-13, and the single owner of job state. Triggered by an
 * EventBridge "Object Created" event on the raw bucket (not a direct
 * S3->Lambda notification — see processing-stack.ts for why), one object
 * per invocation. Handles two object kinds written by the fetch tier:
 *   <accountId>/<jobId>/<hash>.html         a fetched page
 *   <accountId>/<jobId>/<hash>.failed.json  a permanent fetch failure
 * Anything else (e.g. headless screenshots) is ignored.
 */
export const handler = async (
  event: EventBridgeEvent<"Object Created", S3ObjectCreatedDetail>
): Promise<void> => {
  const bucket = event.detail.bucket.name
  const key = decodeURIComponent(event.detail.object.key.replace(/\+/g, " "))
  const [accountId, jobId, fileName] = key.split("/")

  if (!accountId || !jobId || !fileName) {
    logger.warn("Skipping object with unexpected key shape", { key })
    return
  }
  const isFailure = fileName.endsWith(".failed.json")
  if (!isFailure && !fileName.endsWith(".html")) return

  const { Item } = await ddb.send(
    new GetCommand({
      TableName: JOBS_TABLE_NAME,
      Key: { pk: `${accountId}#${jobId}` },
    })
  )
  const job = Item as JobItem | undefined
  if (!job) {
    logger.warn("No job record for object, skipping", { key })
    return
  }

  const raw = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const body = (await raw.Body?.transformToString()) ?? ""
  const sourceUrl = raw.Metadata?.["source-url"] ?? ""

  if (isFailure) {
    const failure = JSON.parse(body) as { reason: string }
    logger.info("Recording page failure", { jobId, sourceUrl, ...failure })
    await completePage(accountId, jobId, job, {
      failed: true,
      errorReason: failure.reason,
    })
    return
  }

  const { contentHtml } = stripBoilerplate(
    body,
    sourceUrl || "https://unknown.invalid"
  )
  // Dedup no longer short-circuits: a repeat request for an unchanged
  // page still needs its own result. It only sets `changed` and keeps
  // lastChangedAt stable.
  const dedupResult = await checkDedup(accountId, sourceUrl, contentHtml)

  const scrapedAt = new Date().toISOString()
  const markdown = convertToMarkdown(contentHtml, {
    source_url: sourceUrl,
    scraped_at: scrapedAt,
    content_hash: dedupResult.contentHash,
  })

  const baseKey = `${accountId}/${jobId}/${dedupResult.contentHash.replace("sha256:", "")}`
  const markdownKey = `${baseKey}.md`
  await s3.send(
    new PutObjectCommand({
      Bucket: MARKDOWN_BUCKET_NAME,
      Key: markdownKey,
      Body: markdown,
      ContentType: "text/markdown",
      Metadata: { "source-url": sourceUrl },
    })
  )

  if (job.structuredExtractSchema) {
    const extracted = await structuredExtract(
      body,
      job.structuredExtractSchema,
      await getLlmClient()
    )
    await s3.send(
      new PutObjectCommand({
        Bucket: MARKDOWN_BUCKET_NAME,
        Key: `${baseKey}.json`,
        Body: JSON.stringify({ source_url: sourceUrl, data: extracted }),
        ContentType: "application/json",
        Metadata: { "source-url": sourceUrl },
      })
    )
  }

  await recordPageMetadata({
    accountId,
    url: sourceUrl,
    contentHash: dedupResult.contentHash,
    lastFetchedAt: scrapedAt,
    lastChangedAt: dedupResult.unchanged
      ? (dedupResult.previous?.lastChangedAt ?? scrapedAt)
      : scrapedAt,
    markdownS3Key: markdownKey,
    rawHtmlS3Key: key,
  })

  logger.info("Processed page", {
    sourceUrl,
    jobId,
    markdownKey,
    changed: !dedupResult.unchanged,
  })
  await completePage(accountId, jobId, job, {
    failed: false,
    markdownS3Key: markdownKey,
    changed: !dedupResult.unchanged,
  })
}

/**
 * Single-URL jobs finish on their one page. Crawl jobs count pages
 * (succeeded or failed) against the pagesTotal the frontier recorded,
 * and whichever page brings the count to the total finishes the job.
 */
async function completePage(
  accountId: string,
  jobId: string,
  job: JobItem,
  outcome: {
    failed: boolean
    errorReason?: string
    markdownS3Key?: string
    changed?: boolean
  }
): Promise<void> {
  const pk = `${accountId}#${jobId}`
  const now = new Date().toISOString()

  if (job.jobType === "single_url") {
    await ddb.send(
      new UpdateCommand({
        TableName: JOBS_TABLE_NAME,
        Key: { pk },
        UpdateExpression: outcome.failed
          ? "SET #status = :status, errorReason = :reason, updatedAt = :now"
          : "SET #status = :status, markdownS3Key = :md, changed = :changed, updatedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: outcome.failed
          ? { ":status": "failed", ":reason": outcome.errorReason, ":now": now }
          : {
              ":status": "done",
              ":md": outcome.markdownS3Key,
              ":changed": outcome.changed,
              ":now": now,
            },
      })
    )
    await publishJobComplete(accountId, jobId, job, {
      status: outcome.failed ? "failed" : "done",
      errorReason: outcome.errorReason,
      markdownS3Key: outcome.markdownS3Key,
    })
    return
  }

  const { Attributes } = await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE_NAME,
      Key: { pk },
      UpdateExpression: outcome.failed
        ? "ADD pagesCompleted :one, pagesFailed :one SET updatedAt = :now"
        : "ADD pagesCompleted :one SET updatedAt = :now",
      ExpressionAttributeValues: { ":one": 1, ":now": now },
      ReturnValues: "ALL_NEW",
    })
  )
  const updated = Attributes as JobItem
  if (
    updated.pagesTotal === undefined ||
    (updated.pagesCompleted ?? 0) < updated.pagesTotal
  ) {
    return
  }

  // Conditional so a duplicate event can't finish (and notify) twice.
  const allFailed = (updated.pagesFailed ?? 0) >= updated.pagesTotal
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: JOBS_TABLE_NAME,
        Key: { pk },
        UpdateExpression: "SET #status = :status, updatedAt = :now",
        ConditionExpression: "#status <> :done AND #status <> :failed",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": allFailed ? "failed" : "done",
          ":done": "done",
          ":failed": "failed",
          ":now": now,
        },
      })
    )
  } catch (err) {
    if ((err as Error).name === "ConditionalCheckFailedException") return
    throw err
  }
  await publishJobComplete(accountId, jobId, job, {
    status: allFailed ? "failed" : "done",
  })
}

async function publishJobComplete(
  accountId: string,
  jobId: string,
  job: JobItem,
  result: { status: string; errorReason?: string; markdownS3Key?: string }
): Promise<void> {
  await eventBridge.send(
    new PutEventsCommand({
      Entries: [
        {
          Source: "scrapeforge",
          DetailType: "JobComplete",
          EventBusName: JOB_COMPLETE_BUS_NAME,
          Detail: JSON.stringify({
            accountId,
            jobId,
            jobType: job.jobType,
            webhookUrl: job.webhookUrl,
            notifyEmail: job.notifyEmail,
            ...result,
          }),
        },
      ],
    })
  )
}
