import { Logger } from "@aws-lambda-powertools/logger"
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs"
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb"
import robotsParser from "robots-parser"

const logger = new Logger({ serviceName: "crawl-orchestrator" })
const sqs = new SQSClient({})
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const USER_AGENT = "ScrapeForgeBot/1.0 (+https://scrapeforge.dev/bot)"

export interface FrontierInput {
  accountId: string
  jobId: string
  urls: string[]
  maxDepth: number
  maxPages: number
  includePaths?: string[]
  excludePaths?: string[]
  respectRobotsTxt?: boolean
}

async function robotsFilter(urls: string[]): Promise<string[]> {
  const robotsByOrigin = new Map<
    string,
    ReturnType<typeof robotsParser> | null
  >()
  const allowed: string[] = []
  for (const url of urls) {
    const origin = new URL(url).origin
    if (!robotsByOrigin.has(origin)) {
      const robotsUrl = `${origin}/robots.txt`
      try {
        const res = await fetch(robotsUrl, {
          headers: { "user-agent": USER_AGENT },
        })
        robotsByOrigin.set(
          origin,
          res.ok ? robotsParser(robotsUrl, await res.text()) : null
        )
      } catch {
        robotsByOrigin.set(origin, null)
      }
    }
    const robots = robotsByOrigin.get(origin)
    if (!robots || (robots.isAllowed(url, USER_AGENT) ?? true)) {
      allowed.push(url)
    }
  }
  return allowed
}

/**
 * Step Functions task: depth-controlled URL frontier management (ARD §2.2).
 * Filters by include/exclude path rules and robots.txt (on unless the
 * request explicitly set respectRobotsTxt: false), records the page
 * total on the job, and enqueues to the Bulk Crawl Queue.
 */
export const handler = async (
  input: FrontierInput
): Promise<{ enqueued: number }> => {
  const pathFiltered = input.urls
    .filter(
      (url) =>
        !input.includePaths?.length ||
        input.includePaths.some((p) => url.includes(p))
    )
    .filter((url) => !input.excludePaths?.some((p) => url.includes(p)))

  const allowed =
    input.respectRobotsTxt === false
      ? pathFiltered
      : await robotsFilter(pathFiltered)
  const filtered = allowed.slice(0, input.maxPages)

  logger.info("Enqueuing frontier batch", {
    count: filtered.length,
    robotsExcluded: pathFiltered.length - allowed.length,
    jobId: input.jobId,
  })

  // Written before enqueueing so processing can never see a page land
  // ahead of the total it's counted against.
  const now = new Date().toISOString()
  await ddb.send(
    new UpdateCommand({
      TableName: process.env.JOBS_TABLE_NAME,
      Key: { pk: `${input.accountId}#${input.jobId}` },
      UpdateExpression:
        filtered.length === 0
          ? "SET #status = :failed, errorReason = :reason, pagesTotal = :zero, pagesCompleted = :zero, updatedAt = :now"
          : "SET #status = :fetching, pagesTotal = :total, updatedAt = :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues:
        filtered.length === 0
          ? {
              ":failed": "failed",
              ":reason":
                allowed.length === 0 && pathFiltered.length > 0
                  ? "robots_disallowed"
                  : "invalid_url",
              ":zero": 0,
              ":now": now,
            }
          : { ":fetching": "fetching", ":total": filtered.length, ":now": now },
    })
  )

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
