import Redis from "ioredis"

/**
 * TRD §11 open decision #4, resolved: requests/second per account by
 * plan, with bursts up to 2x the rate.
 */
export const PLAN_RATE_LIMITS = {
  free: 5,
  pro: 25,
  enterprise: 100,
} as const
export type Plan = keyof typeof PLAN_RATE_LIMITS
const BURST_MULTIPLIER = 2

// Token bucket: refills at `rate`/s up to `capacity`. Atomic in Redis so
// concurrent Lambdas share one bucket per account.
const TOKEN_BUCKET_LUA = `
local rate = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then
  tokens = capacity
  ts = now
end
tokens = math.min(capacity, tokens + (now - ts) * rate / 1000)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate * 1000) + 1000)
return {allowed, tostring(tokens)}
`

let redis: Redis | undefined

function getRedis(): Redis {
  redis ??= new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT ?? 6379),
    tls: {},
    connectTimeout: 1000,
    commandTimeout: 500,
    maxRetriesPerRequest: 1,
  })
  return redis
}

export interface RateLimitResult {
  allowed: boolean
  limit: number
  retryAfterSeconds: number
}

export async function checkRateLimit(
  accountId: string,
  plan: Plan
): Promise<RateLimitResult> {
  const rate = PLAN_RATE_LIMITS[plan]
  const capacity = rate * BURST_MULTIPLIER
  const [allowed, tokens] = (await getRedis().eval(
    TOKEN_BUCKET_LUA,
    1,
    `ratelimit:${accountId}`,
    rate,
    capacity,
    Date.now()
  )) as [number, string]
  return {
    allowed: allowed === 1,
    limit: rate,
    retryAfterSeconds: Math.max(1, Math.ceil((1 - Number(tokens)) / rate)),
  }
}
