import TurndownService from "turndown"
import type { MarkdownFrontMatter } from "@scrapeforge/shared-types"

/**
 * TRD §2.4 — Turndown with a custom rule set. Default Turndown output
 * mangles tables/code fences/heading hierarchy, so rules are added
 * explicitly rather than relying on defaults.
 */
function buildTurndownService(): TurndownService {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  })

  turndown.addRule("preserveTables", {
    filter: "table",
    replacement: (_content, node) => {
      const table = node as HTMLTableElement
      const rows = Array.from(table.rows).map((row) =>
        Array.from(row.cells)
          .map((cell) => cell.textContent?.trim().replace(/\|/g, "\\|") ?? "")
          .join(" | ")
      )
      if (rows.length === 0) return ""
      const header = rows[0]
      const separator = header
        .split(" | ")
        .map(() => "---")
        .join(" | ")
      return `\n\n${[header, separator, ...rows.slice(1)].join("\n")}\n\n`
    },
  })

  return turndown
}

const turndownService = buildTurndownService()

export function convertToMarkdown(
  contentHtml: string,
  frontMatter: MarkdownFrontMatter
): string {
  const body = turndownService.turndown(contentHtml)
  const yaml = [
    "---",
    `source_url: ${frontMatter.source_url}`,
    `scraped_at: ${frontMatter.scraped_at}`,
    `content_hash: ${frontMatter.content_hash}`,
    "---",
    "",
  ].join("\n")
  return `${yaml}${body}\n`
}
