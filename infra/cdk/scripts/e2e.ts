/**
 * Live end-to-end check against the deployed dev stacks, through the
 * public API exactly as a customer would use it: Cognito SRP sign-in ->
 * POST /v1/scrape (with structured extraction + webhook) -> poll
 * GET /v1/jobs/{id} -> fetch the signed result URLs -> crawl -> rate
 * limiting. Usage:
 *   API_URL=... USER_POOL_ID=... CLIENT_ID=... E2E_EMAIL=... E2E_PASSWORD=... \
 *     bun run infra/cdk/scripts/e2e.ts
 */
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
} from "amazon-cognito-identity-js"
import { ScrapeForgeClient, ScrapeForgeError } from "@scrapeforge/sdk"

const env = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function signIn(): Promise<string> {
  const pool = new CognitoUserPool({
    UserPoolId: env("USER_POOL_ID"),
    ClientId: env("CLIENT_ID"),
  })
  const user = new CognitoUser({ Username: env("E2E_EMAIL"), Pool: pool })
  return new Promise((resolve, reject) => {
    user.authenticateUser(
      new AuthenticationDetails({
        Username: env("E2E_EMAIL"),
        Password: env("E2E_PASSWORD"),
      }),
      {
        onSuccess: (session) => resolve(session.getIdToken().getJwtToken()),
        onFailure: reject,
      }
    )
  })
}

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`)
  console.log(`  ok  ${message}`)
}

const token = await signIn()
console.log("signed in via SRP, got ID token")
const client = new ScrapeForgeClient({
  apiKey: token,
  baseUrl: env("API_URL"),
})

console.log("\n1. unauthenticated request is rejected at the gateway")
const anon = await fetch(`${env("API_URL")}/v1/jobs/x`)
check(anon.status === 401, `no token -> ${anon.status}`)

console.log("\n2. single-URL scrape with structured extraction + webhook")
const accepted = await client.scrape({
  url: "https://example.com/",
  structuredExtractSchema: {
    heading: "h1",
    moreInfoLinkText: ".does-not-exist-forces-llm",
  },
  webhookUrl: "https://httpbin.org/post",
  llmCleanup: false,
})
check(accepted.status === "queued", `accepted job ${accepted.jobId}`)
const started = Date.now()
const job = await client.waitForJob(accepted.jobId, { timeoutMs: 600_000 })
console.log(`  finished in ${Math.round((Date.now() - started) / 1000)}s`)
check(job.status === "done", `status ${job.status} ${job.errorReason ?? ""}`)
const md = job.results.find((r) => r.key.endsWith(".md"))
const json = job.results.find((r) => r.key.endsWith(".json"))
check(md, "markdown result listed")
check(json, "structured-extraction result listed")
const markdown = await (await fetch(md!.url)).text()
check(
  markdown.includes("source_url: https://example.com/") &&
    markdown.includes("Example Domain"),
  "markdown has front matter + page content"
)
const extracted = (await (await fetch(json!.url)).json()) as {
  data: Record<string, string | null>
}
check(
  extracted.data.heading === "Example Domain",
  `selector field: heading=${extracted.data.heading}`
)
console.log(`  llm field: moreInfoLinkText=${extracted.data.moreInfoLinkText}`)

console.log("\n3. repeat scrape of the unchanged page still returns a result")
const repeat = await client.waitForJob(
  (await client.scrape({ url: "https://example.com/", llmCleanup: false }))
    .jobId,
  { timeoutMs: 300_000 }
)
check(
  repeat.status === "done" && repeat.changed === false,
  `status ${repeat.status}, changed=${repeat.changed}`
)
check(repeat.results.length === 1, "one markdown result")

console.log("\n4. robots.txt disallowed URL fails cleanly")
// google.com/search is disallowed for all user agents in its robots.txt.
const blocked = await client.waitForJob(
  (
    await client.scrape({
      url: "https://www.google.com/search?q=scrapeforge",
      llmCleanup: false,
    })
  ).jobId,
  { timeoutMs: 300_000 }
)
check(
  blocked.status === "failed" && blocked.errorReason === "robots_disallowed",
  `status ${blocked.status}, reason ${blocked.errorReason}`
)

console.log("\n5. crawl (headless pool) runs to completion")
const crawl = await client.waitForJob(
  (
    await client.crawl({
      rootUrl: "https://example.com/",
      maxPages: 1,
      maxDepth: 0,
      respectRobotsTxt: true,
      llmCleanup: false,
    })
  ).jobId,
  { timeoutMs: 900_000 }
)
check(
  crawl.status === "done" &&
    crawl.pagesCompleted === 1 &&
    crawl.pagesTotal === 1,
  `status ${crawl.status}, pages ${crawl.pagesCompleted}/${crawl.pagesTotal}`
)
check(crawl.results.length >= 1, "crawl results listed")

console.log("\n6. per-plan rate limit (free: 5 rps, burst 10)")
const burst = await Promise.allSettled(
  Array.from({ length: 30 }, () => client.getJob(accepted.jobId))
)
const limited = burst.filter(
  (r) =>
    r.status === "rejected" &&
    r.reason instanceof ScrapeForgeError &&
    r.reason.status === 429
)
check(
  limited.length > 0 && limited.length < 30,
  `${30 - limited.length} allowed, ${limited.length} rate-limited`
)
const first = (limited[0] as PromiseRejectedResult).reason as ScrapeForgeError
check(
  first.retryAfter !== undefined,
  `429 carries retry-after=${first.retryAfter}`
)

console.log(
  `\nALL CHECKS PASSED\njobs: ${[accepted.jobId, repeat.jobId, blocked.jobId, crawl.jobId].join(" ")}`
)
process.exit(0)
