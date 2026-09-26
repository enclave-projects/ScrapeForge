import { Logger } from "@aws-lambda-powertools/logger"
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns"
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2"
import type { EventBridgeEvent } from "aws-lambda"

const logger = new Logger({ serviceName: "delivery" })
const sns = new SNSClient({})
const ses = new SESv2Client({})

const WEBHOOK_TOPIC_ARN = process.env.WEBHOOK_TOPIC_ARN ?? ""
const NOTIFICATION_SENDER_EMAIL = process.env.NOTIFICATION_SENDER_EMAIL ?? ""

interface JobCompleteDetail {
  accountId: string
  jobId: string
  jobType: "single_url" | "crawl"
  webhookUrl?: string
  notifyEmail?: string
  markdownS3Key: string
}

/**
 * ARD §2.7 — consumes the job-complete EventBridge bus, fans out to SNS
 * (webhooks) and SES (long-running job email notifications).
 */
export const handler = async (
  event: EventBridgeEvent<"JobComplete", JobCompleteDetail>
): Promise<void> => {
  const { detail } = event
  logger.info("Delivering job-complete notification", { jobId: detail.jobId })

  if (detail.webhookUrl) {
    await sns.send(
      new PublishCommand({
        TopicArn: WEBHOOK_TOPIC_ARN,
        Message: JSON.stringify(detail),
        MessageAttributes: {
          webhookUrl: { DataType: "String", StringValue: detail.webhookUrl },
        },
      })
    )
  }

  if (detail.notifyEmail && detail.jobType === "crawl") {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: NOTIFICATION_SENDER_EMAIL,
        Destination: { ToAddresses: [detail.notifyEmail] },
        Content: {
          Simple: {
            Subject: { Data: `ScrapeForge crawl ${detail.jobId} complete` },
            Body: {
              Text: {
                Data: `Your crawl job ${detail.jobId} has finished. Results: ${detail.markdownS3Key}`,
              },
            },
          },
        },
      })
    )
  }
}
