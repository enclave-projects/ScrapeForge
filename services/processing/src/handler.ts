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
import type { EventBridgeEvent } from "aws-lambda"

interface S3ObjectCreatedDetail {
  bucket: { name: string }
  object: { key: string }
}
import { BedrockLLMClient } from "@scrapeforge/llm-client"
import { stripBoilerplate } from "./readability-strip.js"
import { convertToMarkdown } from "./markdown-converter.js"
import { checkDedup, recordPageMetadata } from "./dedup.js"

const logger = new Logger({ serviceName: "processing" })
const s3 = new S3Client({})
const secretsManager = new SecretsManagerClient({})
const eventBridge = new EventBridgeClient({})

const MARKDOWN_BUCKET_NAME = process.env.MARKDOWN_BUCKET_NAME ?? ""
const JOB_COMPLETE_BUS_NAME = process.env.JOB_COMPLETE_BUS_NAME ?? ""
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
 * ARD §3 steps 8-13: triggered by an EventBridge "Object Created" event
 * on the raw HTML bucket (not a direct S3->Lambda notification — see
 * processing-stack.ts's doc comment on RawObjectCreatedRule for why:
 * avoids a circular stack dependency). This is a single-object event,
 * not the classic S3Event's Records[] batch shape. Strips boilerplate,
 * checks dedup (short-circuits if unchanged), converts to Markdown,
 * stores the result, and publishes a job-complete event. Structured
 * extraction / Textract / Rekognition are config-driven branches (PRD
 * §4.4-§4.6) not wired into this initial pass — the pipeline's core
 * path works end-to-end first.
 */
export const handler = async (
  event: EventBridgeEvent<"Object Created", S3ObjectCreatedDetail>
): Promise<void> => {
  const bucket = event.detail.bucket.name
  const key = decodeURIComponent(event.detail.object.key.replace(/\+/g, " "))
  const [accountId, jobId] = key.split("/")

  if (!accountId || !jobId) {
    logger.warn("Skipping object with unexpected key shape", { key })
    return
  }

  const raw = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const html = (await raw.Body?.transformToString()) ?? ""
  const sourceUrl = raw.Metadata?.["source-url"] ?? ""

  const { contentHtml } = stripBoilerplate(
    html,
    sourceUrl || "https://unknown.invalid"
  )
  const dedupResult = await checkDedup(accountId, sourceUrl, contentHtml)

  if (dedupResult.unchanged) {
    logger.info("Content unchanged, skipping reprocessing", {
      sourceUrl,
      jobId,
    })
    return
  }

  const scrapedAt = new Date().toISOString()
  const markdown = convertToMarkdown(contentHtml, {
    source_url: sourceUrl,
    scraped_at: scrapedAt,
    content_hash: dedupResult.contentHash,
  })

  const markdownKey = `${accountId}/${jobId}/${dedupResult.contentHash.replace("sha256:", "")}.md`
  await s3.send(
    new PutObjectCommand({
      Bucket: MARKDOWN_BUCKET_NAME,
      Key: markdownKey,
      Body: markdown,
      ContentType: "text/markdown",
    })
  )

  await recordPageMetadata({
    accountId,
    url: sourceUrl,
    contentHash: dedupResult.contentHash,
    lastFetchedAt: scrapedAt,
    lastChangedAt: scrapedAt,
    markdownS3Key: markdownKey,
    rawHtmlS3Key: key,
  })

  void getLlmClient // wired for structured-extract's Bedrock fallback once that branch is enabled

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
            jobType: "single_url",
            markdownS3Key: markdownKey,
          }),
        },
      ],
    })
  )

  logger.info("Processed page", { sourceUrl, jobId, markdownKey })
}
