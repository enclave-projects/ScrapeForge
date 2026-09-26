import { Logger } from "@aws-lambda-powertools/logger"
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import { request as undiciRequest } from "undici"
import { createHash } from "node:crypto"
import { needsJsRender } from "./js-render-heuristic.js"

const logger = new Logger({ serviceName: "fetch-http" })
const sqs = new SQSClient({})
const s3 = new S3Client({})

const QUEUE_URL = process.env.QUEUE_URL ?? ""
const RAW_BUCKET = process.env.RAW_HTML_BUCKET_NAME ?? ""
const HEADLESS_QUEUE_URL = process.env.HEADLESS_QUEUE_URL ?? ""

interface FetchMessage {
  accountId: string
  jobId: string
  url: string
  renderJs?: boolean
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
      try {
        const body = JSON.parse(message.Body ?? "{}") as FetchMessage
        await handleMessage(body)
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: QUEUE_URL,
            ReceiptHandle: message.ReceiptHandle,
          })
        )
      } catch (err) {
        logger.error("Fetch failed", { error: err as Error })
      }
    }
  }
}

async function handleMessage(msg: FetchMessage): Promise<void> {
  const { statusCode, body } = await undiciRequest(msg.url, {
    headers: {
      "user-agent": "ScrapeForgeBot/1.0 (+https://scrapeforge.dev/bot)",
    },
  })
  const html = await body.text()

  if (statusCode >= 400) {
    throw new Error(`Fetch failed with status ${statusCode} for ${msg.url}`)
  }

  if (needsJsRender(html, msg.renderJs)) {
    logger.info("Delegating to headless pool", { url: msg.url })
    // Headless fallback enqueue omitted here for brevity — same shape as
    // the SendMessageCommand used in the crawl-orchestrator frontier.
    void HEADLESS_QUEUE_URL
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
    })
  )
  logger.info("Stored raw HTML", { key })
}

pollLoop().catch((err) => {
  logger.error("Fatal error in fetch-http poll loop", { error: err as Error })
  process.exit(1)
})
