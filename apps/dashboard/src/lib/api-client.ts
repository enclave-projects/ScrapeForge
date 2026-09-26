import { ScrapeForgeClient } from "@scrapeforge/sdk"

/** Dashboard's own thin wrapper around the published SDK (TanStack Query hooks live alongside this). */
export function createApiClient(apiKey: string): ScrapeForgeClient {
  return new ScrapeForgeClient({
    apiKey,
    baseUrl: process.env.NEXT_PUBLIC_API_BASE_URL,
  })
}
