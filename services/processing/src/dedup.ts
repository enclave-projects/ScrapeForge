import { createHash } from "node:crypto"
import Redis from "ioredis"
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb"
import type { PageMetadata } from "@scrapeforge/shared-types"

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT ?? 6379),
  tls: {},
})
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const METADATA_TABLE = process.env.PAGE_METADATA_TABLE_NAME ?? ""

export function hashContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`
}

/**
 * ARD §3 step 9 — dedup/change detection. Redis is the fast index checked
 * first; DynamoDB is the durable source of truth used to populate it on a
 * cache miss. Returns `unchanged: true` to short-circuit the pipeline.
 */
export async function checkDedup(
  accountId: string,
  url: string,
  cleanedContent: string
): Promise<{
  unchanged: boolean
  contentHash: string
  previous?: PageMetadata
}> {
  const contentHash = hashContent(cleanedContent)
  const redisKey = `dedup:${accountId}:${url}`

  const cachedHash = await redis.get(redisKey)
  if (cachedHash === contentHash) {
    return { unchanged: true, contentHash }
  }

  const { Item } = await ddb.send(
    new GetCommand({ TableName: METADATA_TABLE, Key: { accountId, url } })
  )
  const previous = Item as PageMetadata | undefined

  if (previous?.contentHash === contentHash) {
    await redis.set(redisKey, contentHash, "EX", 86_400)
    return { unchanged: true, contentHash, previous }
  }

  return { unchanged: false, contentHash, previous }
}

export async function recordPageMetadata(
  metadata: PageMetadata
): Promise<void> {
  await ddb.send(new PutCommand({ TableName: METADATA_TABLE, Item: metadata }))
  await redis.set(
    `dedup:${metadata.accountId}:${metadata.url}`,
    metadata.contentHash,
    "EX",
    86_400
  )
}
