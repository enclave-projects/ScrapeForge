import type {
  ApiEnvelope,
  CrawlRequest,
  JobAccepted,
  JobStatusResponse,
  ScrapeRequest,
} from "@scrapeforge/shared-types"

export interface ScrapeForgeClientConfig {
  /** A Cognito ID token for the calling account. */
  apiKey: string
  baseUrl?: string
}

/** Thrown for any non-2xx response; carries the API's error envelope. */
export class ScrapeForgeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | undefined,
    /** Seconds to wait before retrying, set on 429 responses. */
    readonly retryAfter?: number
  ) {
    super(message)
  }
}

const TERMINAL_STATUSES = new Set(["done", "failed"])

/**
 * Typed client. Request/response shapes are imported from
 * @scrapeforge/shared-types — the single source of truth per TRD §6 — and
 * must never be redeclared here.
 */
export class ScrapeForgeClient {
  private readonly apiKey: string
  private readonly baseUrl: string

  constructor(config: ScrapeForgeClientConfig) {
    this.apiKey = config.apiKey
    this.baseUrl = (config.baseUrl ?? "https://api.scrapeforge.dev").replace(
      /\/$/,
      ""
    )
  }

  scrape(request: ScrapeRequest): Promise<JobAccepted> {
    return this.request("/v1/scrape", request)
  }

  crawl(request: CrawlRequest): Promise<JobAccepted> {
    return this.request("/v1/crawl", request)
  }

  getJob(jobId: string): Promise<JobStatusResponse> {
    return this.request(
      `/v1/jobs/${encodeURIComponent(jobId)}`,
      undefined,
      "GET"
    )
  }

  /** Polls getJob until the job is done or failed. */
  async waitForJob(
    jobId: string,
    { intervalMs = 2000, timeoutMs = 300_000 } = {}
  ): Promise<JobStatusResponse> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const job = await this.getJob(jobId)
      if (TERMINAL_STATUSES.has(job.status)) return job
      if (Date.now() + intervalMs > deadline) {
        throw new Error(`Timed out waiting for job ${jobId} (${job.status})`)
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  private async request<T>(
    path: string,
    body?: unknown,
    method = "POST"
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const envelope = (await response
      .json()
      .catch(() => null)) as ApiEnvelope<T> | null
    if (!response.ok || !envelope?.success) {
      const retryAfter = response.headers.get("retry-after")
      throw new ScrapeForgeError(
        response.status,
        envelope?.error?.code ?? "HTTP_ERROR",
        envelope?.error?.message ??
          // API Gateway's own 401s aren't wrapped in the envelope.
          `Request failed with status ${response.status}`,
        envelope?.requestId,
        retryAfter ? Number(retryAfter) : undefined
      )
    }
    return envelope.data as T
  }
}

export type {
  ScrapeRequest,
  CrawlRequest,
  JobAccepted,
  JobRecord,
  JobResult,
  JobStatusResponse,
  ApiEnvelope,
} from "@scrapeforge/shared-types"
