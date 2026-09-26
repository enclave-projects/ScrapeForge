import { Logger } from "@aws-lambda-powertools/logger"
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns"
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager"
import type { EventBridgeEvent } from "aws-lambda"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

const logger = new Logger({ serviceName: "delivery" })
const sns = new SNSClient({})
const secretsManager = new SecretsManagerClient({})

const WEBHOOK_TOPIC_ARN = process.env.WEBHOOK_TOPIC_ARN ?? ""
const NOTIFICATION_SENDER = process.env.NOTIFICATION_SENDER ?? ""
const RESEND_API_KEY_SECRET_ARN = process.env.RESEND_API_KEY_SECRET_ARN ?? ""

interface JobCompleteDetail {
  accountId: string
  jobId: string
  jobType: "single_url" | "crawl"
  status: "done" | "failed"
  errorReason?: string
  webhookUrl?: string
  notifyEmail?: string
  markdownS3Key?: string
}

let resendApiKey: string | undefined

async function getResendApiKey(): Promise<string> {
  if (resendApiKey) return resendApiKey
  const secret = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: RESEND_API_KEY_SECRET_ARN })
  )
  if (!secret.SecretString) throw new Error("Resend API key secret is empty")
  resendApiKey = secret.SecretString
  return resendApiKey
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase()
    return (
      v6 === "::1" ||
      v6.startsWith("fc") ||
      v6.startsWith("fd") ||
      v6.startsWith("fe80") ||
      v6.startsWith("::ffff:")
    )
  }
  const [a, b] = ip.split(".").map(Number)
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b! >= 64 && b! <= 127)
  )
}

/** Webhook URLs are caller-supplied: https only, public addresses only. */
async function assertSafeWebhookUrl(raw: string): Promise<URL> {
  const url = new URL(raw)
  if (url.protocol !== "https:") {
    throw new Error("Webhook URL must use https")
  }
  const addresses = await lookup(url.hostname, { all: true })
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Webhook URL resolves to a private address")
  }
  return url
}

async function deliverWebhook(detail: JobCompleteDetail): Promise<void> {
  const url = await assertSafeWebhookUrl(detail.webhookUrl!)
  const { webhookUrl: _w, notifyEmail: _e, ...payload } = detail
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "ScrapeForge-Webhooks/1.0",
    },
    body: JSON.stringify({ event: "job.completed", ...payload }),
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  })
  if (response.status >= 500) {
    // Thrown so EventBridge's async-invoke retries redeliver.
    throw new Error(`Webhook endpoint returned ${response.status}`)
  }
  logger.info("Webhook delivered", {
    jobId: detail.jobId,
    status: response.status,
  })
}

async function sendEmail(detail: JobCompleteDetail): Promise<void> {
  const outcome =
    detail.status === "done"
      ? "has finished"
      : `failed${detail.errorReason ? ` (${detail.errorReason})` : ""}`
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${await getResendApiKey()}`,
      "content-type": "application/json",
      // Makes Lambda retries of the same event safe.
      "idempotency-key": `job-complete-${detail.jobId}`,
    },
    body: JSON.stringify({
      from: NOTIFICATION_SENDER,
      to: [detail.notifyEmail],
      subject: `ScrapeForge crawl ${detail.jobId} ${detail.status === "done" ? "complete" : "failed"}`,
      text: `Your crawl job ${detail.jobId} ${outcome}.\n\nFetch results with GET /v1/jobs/${detail.jobId}.`,
    }),
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) {
    throw new Error(
      `Resend request failed: ${response.status} ${await response.text()}`
    )
  }
  logger.info("Completion email sent", { jobId: detail.jobId })
}

/**
 * ARD §2.7 — consumes the job-complete EventBridge bus: POSTs the
 * caller's webhook (SNS can't target a per-request URL — HTTP
 * subscriptions need per-endpoint confirmation — so the topic stays as
 * the internal fanout only), and emails crawl owners via Resend.
 */
export const handler = async (
  event: EventBridgeEvent<"JobComplete", JobCompleteDetail>
): Promise<void> => {
  const { detail } = event
  logger.info("Delivering job-complete notification", {
    jobId: detail.jobId,
    status: detail.status,
  })

  await sns.send(
    new PublishCommand({
      TopicArn: WEBHOOK_TOPIC_ARN,
      Message: JSON.stringify({ ...detail, notifyEmail: undefined }),
    })
  )

  const deliveries: Promise<void>[] = []
  if (detail.webhookUrl) deliveries.push(deliverWebhook(detail))
  if (detail.notifyEmail && detail.jobType === "crawl") {
    deliveries.push(sendEmail(detail))
  }
  const results = await Promise.allSettled(deliveries)
  const failures = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected"
  )
  for (const failure of failures) {
    logger.error("Delivery failed", { error: failure.reason as Error })
  }
  if (failures.length > 0) throw failures[0]!.reason
}
