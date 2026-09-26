import type {
  ApiEnvelope,
  CrawlRequest,
  JobRecord,
  ScrapeRequest,
} from "@scrapeforge/shared-types"

export interface ScrapeForgeClientConfig {
  apiKey: string
  baseUrl?: string
}

/**
 * Minimal typed client stub. Request/response shapes are imported from
 * @scrapeforge/shared-types — the single source of truth per TRD §6 — and
 * must never be redeclared here.
 */
export class ScrapeForgeClient {
  private readonly apiKey: string
  private readonly baseUrl: string

  constructor(config: ScrapeForgeClientConfig) {
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl ?? "https://api.scrapeforge.dev"
  }

  async scrape(request: ScrapeRequest): Promise<ApiEnvelope<JobRecord>> {
    return this.request("/v1/scrape", request)
  }

  async crawl(request: CrawlRequest): Promise<ApiEnvelope<JobRecord>> {
    return this.request("/v1/crawl", request)
  }

  async getJob(jobId: string): Promise<ApiEnvelope<JobRecord>> {
    return this.request(`/v1/jobs/${jobId}`, undefined, "GET")
  }

  private async request<T>(
    path: string,
    body?: unknown,
    method = "POST"
  ): Promise<ApiEnvelope<T>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    return (await response.json()) as ApiEnvelope<T>
  }
}

export type {
  ScrapeRequest,
  CrawlRequest,
  JobRecord,
  ApiEnvelope,
} from "@scrapeforge/shared-types"
