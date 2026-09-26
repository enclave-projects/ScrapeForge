import { Logger } from "@aws-lambda-powertools/logger"
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import { Agent, interceptors, request as undiciRequest } from "undici"
import robotsParserModule from "robots-parser"
import { createHash } from "node:crypto"
import { needsJsRender } from "./js-render-heuristic.js"

const logger = new Logger({ serviceName: "fetch-http" })
const sqs = new SQSClient({})
const s3 = new S3Client({})

const QUEUE_URL = process.env.QUEUE_URL ?? ""
const RAW_BUCKET = process.env.RAW_HTML_BUCKET_NAME ?? ""
const HEADLESS_QUEUE_URL = process.env.HEADLESS_QUEUE_URL ?? ""
const USER_AGENT = "ScrapeForgeBot/1.0 (+https://scrapeforge.dev/bot)"
const dispatcher = new Agent().compose(
  interceptors.redirect({ maxRedirections: 5 })
)
// CJS module whose typings declare an ES default export.
const robotsParser =
  robotsParserModule as unknown as typeof robotsParserModule.default

interface FetchMessage {
  accountId: string
  jobId: string
  url: string
  renderJs?: boolean
}

/** A failure retrying won't fix; recorded for the job instead of retried. */
class PermanentFetchError extends Error {
  constructor(
    readonly reason: "robots_disallowed" | "invalid_url" | "anti_bot_block",
    message: string
  ) {
    super(message)
  }
}

/**
 * Fast HTTP Fetcher (ARD §2.3 / TRD §2.3): the default fetch path.
 * Polls its SQS queue, fetches with undici, applies the JS-render
 * heuristic, and either stores the raw HTML or hands off to the
 * headless pool. Long-running container loop, not a Lambda.
 */
async function pollLoop(): Promise<void> {
  for (;;) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
      })
    )

    for (const message of Messages ?? []) {
      const body = JSON.parse(message.Body ?? "{}") as FetchMessage
      try {
        await handleMessage(body)
      } catch (err) {
        if (!(err instanceof PermanentFetchError)) {
          // Transient: leave the message for SQS redrive (DLQ after 5 tries).
          logger.error("Fetch failed", { error: err as Error, url: body.url })
          continue
        }
        logger.warn("Permanent fetch failure", {
          url: body.url,
          reason: err.reason,
        })
        await recordFailure(body, err.reason, err.message)
      }
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: QUEUE_URL,
          ReceiptHandle: message.ReceiptHandle,
        })
      )
    }
  }
}

async function isAllowedByRobots(url: string): Promise<boolean> {
  const robotsUrl = new URL("/robots.txt", url).toString()
  try {
    const { statusCode, body } = await undiciRequest(robotsUrl, {
      headers: { "user-agent": USER_AGENT },
      dispatcher,
    })
    const text = await body.text()
    // No robots.txt (or an error serving it) means no restrictions.
    if (statusCode >= 400) return true
    return robotsParser(robotsUrl, text).isAllowed(url, USER_AGENT) ?? true
  } catch {
    return true
  }
}

async function handleMessage(msg: FetchMessage): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(msg.url)
  } catch {
    throw new PermanentFetchError("invalid_url", `Invalid URL ${msg.url}`)
  }

  if (!(await isAllowedByRobots(parsed.toString()))) {
    throw new PermanentFetchError(
      "robots_disallowed",
      `robots.txt disallows ${msg.url}`
    )
  }

  const { statusCode, body } = await undiciRequest(msg.url, {
    headers: { "user-agent": USER_AGENT },
    dispatcher,
  })
  const html = await body.text()

  if (statusCode === 403 || statusCode === 429) {
    throw new PermanentFetchError(
      "anti_bot_block",
      `Blocked with status ${statusCode} for ${msg.url}`
    )
  }
  if (statusCode >= 400 && statusCode < 500) {
    throw new PermanentFetchError(
      "invalid_url",
      `Fetch failed with status ${statusCode} for ${msg.url}`
    )
  }
  if (statusCode >= 500) {
    throw new Error(`Fetch failed with status ${statusCode} for ${msg.url}`)
  }

  if (needsJsRender(html, msg.renderJs)) {
    logger.info("Delegating to headless pool", { url: msg.url })
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: HEADLESS_QUEUE_URL,
        MessageBody: JSON.stringify({
          accountId: msg.accountId,
          jobId: msg.jobId,
          url: msg.url,
        }),
      })
    )
    return
  }

  const contentHash = createHash("sha256").update(html).digest("hex")
  const key = `${msg.accountId}/${msg.jobId}/${contentHash}.html`
  await s3.send(
    new PutObjectCommand({
      Bucket: RAW_BUCKET,
      Key: key,
      Body: html,
      ContentType: "text/html",
      Metadata: { "source-url": msg.url },
    })
  )
  logger.info("Stored raw HTML", { key })
}

/**
 * Job state is owned by the processing Lambda, which already fires on
 * every raw-bucket object — so a failure is reported the same way.
 */
async function recordFailure(
  msg: FetchMessage,
  reason: string,
  message: string
): Promise<void> {
  const urlHash = createHash("sha256").update(msg.url).digest("hex")
  await s3.send(
    new PutObjectCommand({
      Bucket: RAW_BUCKET,
      Key: `${msg.accountId}/${msg.jobId}/${urlHash}.failed.json`,
      Body: JSON.stringify({ url: msg.url, reason, message }),
      ContentType: "application/json",
      Metadata: { "source-url": msg.url },
    })
  )
}

pollLoop().catch((err) => {
  logger.error("Fatal error in fetch-http poll loop", { error: err as Error })
  process.exit(1)
})
