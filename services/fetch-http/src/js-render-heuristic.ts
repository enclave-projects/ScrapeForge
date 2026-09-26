import * as cheerio from "cheerio"

/**
 * TRD §2.3 — JS-render detection heuristic, implemented in code (not ML)
 * so the fast path stays fast. Any one of these signals triggers a
 * headless-browser fallback.
 */
export function needsJsRender(
  html: string,
  explicitRenderFlag?: boolean
): boolean {
  if (explicitRenderFlag) return true

  const $ = cheerio.load(html)
  const bodyText = $("body").text().trim()
  if (bodyText.length < 200) return true

  const spaRootMarkers = ["#root", "#app", "#__next", "[data-reactroot]"]
  for (const marker of spaRootMarkers) {
    const root = $(marker)
    if (root.length > 0 && root.children().length === 0) {
      return true
    }
  }

  return false
}
