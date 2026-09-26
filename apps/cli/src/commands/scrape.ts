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
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Scrape)
    const client = new ScrapeForgeClient({ apiKey: flags["api-key"] })
    const result = await client.scrape({
      url: args.url,
      renderJs: flags["render-js"],
      llmCleanup: false,
    })
    this.log(JSON.stringify(result.data, null, 2))
  }
}
