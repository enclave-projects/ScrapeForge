import { Command, Args, Flags } from "@oclif/core"
import { ScrapeForgeClient } from "@scrapeforge/sdk"

/** PRD §6 step 2 — `scrapeforge scrape <url>` CLI entry point. */
export default class Scrape extends Command {
  static description = "Scrape a single URL and print the resulting Markdown"

  static args = {
    url: Args.string({ required: true, description: "URL to scrape" }),
  }

  static flags = {
    "render-js": Flags.boolean({ description: "Force headless JS rendering" }),
    "api-key": Flags.string({ env: "SCRAPEFORGE_API_KEY", required: true }),
    "base-url": Flags.string({ env: "SCRAPEFORGE_BASE_URL" }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Scrape)
    const client = new ScrapeForgeClient({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
    })
    const { jobId } = await client.scrape({
      url: args.url,
      renderJs: flags["render-js"],
      llmCleanup: false,
    })
    const job = await client.waitForJob(jobId)
    if (job.status === "failed") {
      this.error(`Job ${jobId} failed: ${job.errorReason ?? "unknown"}`)
    }
    const markdown = job.results.find((r) => r.key.endsWith(".md"))
    if (!markdown) this.error(`Job ${jobId} finished without a result`)
    const response = await fetch(markdown.url)
    this.log(await response.text())
  }
}
