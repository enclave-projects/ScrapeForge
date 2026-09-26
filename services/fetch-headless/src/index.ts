import { Logger } from "@aws-lambda-powertools/logger"
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import { chromium, type Browser } from "playwright"
import { createHash } from "node:crypto"

const logger = new Logger({ serviceName: "fetch-headless" })
const sqs = new SQSClient({})
const s3 = new S3Client({})

const QUEUE_URL = process.env.QUEUE_URL ?? ""
const RAW_BUCKET = process.env.RAW_HTML_BUCKET_NAME ?? ""

/** Container recycled after N requests to prevent memory leaks (TRD §2.3). */
const MAX_REQUESTS_PER_CONTAINER = 200

interface FetchMessage {
  accountId: string
  jobId: string
  url: string
}

/** A failure retrying won't fix; recorded for the job instead of retried. */
class PermanentFetchError extends Error {
  constructor(
    readonly reason: "invalid_url" | "anti_bot_block",
    message: string
  ) {
    super(message)
  }
}

async function pollLoop(): Promise<void> {
  const browser: Browser = await chromium.launch({ headless: true })
  let requestCount = 0

  try {
    while (requestCount < MAX_REQUESTS_PER_CONTAINER) {
      const { Messages } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: QUEUE_URL,
          MaxNumberOfMessages: 5,
          WaitTimeSeconds: 20,
        })
      )

      for (const message of Messages ?? []) {
        const body = JSON.parse(message.Body ?? "{}") as FetchMessage
        requestCount += 1
        try {
          await handleMessage(browser, body)
        } catch (err) {
          if (!(err instanceof PermanentFetchError)) {
            // Transient: leave the message for SQS redrive (DLQ after 5 tries).
            logger.error("Headless render failed", {
              error: err as Error,
              url: body.url,
            })
            continue
          }
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
  } finally {
    await browser.close()
  }
}

async function handleMessage(
  browser: Browser,
  msg: FetchMessage
): Promise<void> {
  const page = await browser.newPage({
    userAgent: "ScrapeForgeBot/1.0 (+https://scrapeforge.dev/bot)",
  })
  try {
    const response = await page.goto(msg.url, {
      waitUntil: "networkidle",
      timeout: 30_000,
    })
    const status = response?.status() ?? 0
    if (status === 403 || status === 429) {
      throw new PermanentFetchError(
        "anti_bot_block",
        `Blocked with status ${status} for ${msg.url}`
      )
    }
    if (status >= 400 && status < 500) {
      throw new PermanentFetchError(
        "invalid_url",
        `Render failed with status ${status} for ${msg.url}`
      )
    }

    const html = await page.content()
    const screenshot = await page.screenshot({ fullPage: true })

    const contentHash = createHash("sha256").update(html).digest("hex")
    const metadata = { "source-url": msg.url }
    // Screenshot first: the .html write is what triggers processing.
    await s3.send(
      new PutObjectCommand({
        Bucket: RAW_BUCKET,
        Key: `${msg.accountId}/${msg.jobId}/${contentHash}.png`,
        Body: screenshot,
        ContentType: "image/png",
        Metadata: metadata,
      })
    )
    await s3.send(
      new PutObjectCommand({
        Bucket: RAW_BUCKET,
        Key: `${msg.accountId}/${msg.jobId}/${contentHash}.html`,
        Body: html,
        ContentType: "text/html",
        Metadata: metadata,
      })
    )
    logger.info("Stored rendered HTML + screenshot", { url: msg.url })
  } finally {
    await page.close()
  }
}

/** See fetch-http's recordFailure: processing owns job state. */
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

// Recycle the whole container once the request budget is spent — the
// process exits and the orchestrator (ECS/Fargate service) replaces it.
pollLoop()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error("Fatal error in fetch-headless poll loop", {
      error: err as Error,
    })
    process.exit(1)
  })
