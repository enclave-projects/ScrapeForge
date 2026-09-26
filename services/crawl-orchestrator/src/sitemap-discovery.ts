import { Logger } from "@aws-lambda-powertools/logger"

const logger = new Logger({ serviceName: "crawl-orchestrator" })

export interface SitemapDiscoveryInput {
  accountId: string
  jobId: string
  rootUrl: string
}

export interface SitemapDiscoveryOutput {
  urls: string[]
}

/**
 * Step Functions task: ARD §2.2 "sitemap discovery" stage of the Crawl
 * Orchestrator. Falls back to just the root URL if no sitemap is found —
 * URL frontier / depth control is applied by the next state, not here.
 */
export const handler = async (
  input: SitemapDiscoveryInput
): Promise<SitemapDiscoveryOutput> => {
  logger.info("Discovering sitemap", { rootUrl: input.rootUrl })

  const sitemapUrl = new URL("/sitemap.xml", input.rootUrl).toString()
  try {
    const res = await fetch(sitemapUrl)
    if (!res.ok) {
      return { urls: [input.rootUrl] }
    }
    const xml = await res.text()
    const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1])
    return { urls: urls.length > 0 ? urls : [input.rootUrl] }
  } catch (err) {
    logger.warn("Sitemap fetch failed, falling back to root URL", {
      error: err as Error,
    })
    return { urls: [input.rootUrl] }
  }
}
