import { Logger } from "@aws-lambda-powertools/logger"
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs"

const logger = new Logger({ serviceName: "crawl-orchestrator" })
const sqs = new SQSClient({})

export interface FrontierInput {
  accountId: string
  jobId: string
  urls: string[]
  maxDepth: number
  maxPages: number
  includePaths?: string[]
  excludePaths?: string[]
}

/**
 * Step Functions task: depth-controlled URL frontier management (ARD §2.2).
 * Filters by include/exclude path rules and enqueues to the Bulk Crawl Queue.
 */
export const handler = async (
  input: FrontierInput
): Promise<{ enqueued: number }> => {
  const filtered = input.urls
    .filter(
      (url) =>
        !input.includePaths?.length ||
        input.includePaths.some((p) => url.includes(p))
    )
    .filter((url) => !input.excludePaths?.some((p) => url.includes(p)))
    .slice(0, input.maxPages)

  logger.info("Enqueuing frontier batch", {
    count: filtered.length,
    jobId: input.jobId,
  })

  const BATCH_SIZE = 10
  let enqueued = 0
  for (let i = 0; i < filtered.length; i += BATCH_SIZE) {
    const batch = filtered.slice(i, i + BATCH_SIZE)
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: process.env.BULK_QUEUE_URL,
        Entries: batch.map((url, idx) => ({
          Id: `${i + idx}`,
          MessageBody: JSON.stringify({
            accountId: input.accountId,
            jobId: input.jobId,
            url,
            depth: 0,
          }),
        })),
      })
    )
    enqueued += batch.length
  }

  return { enqueued }
}
