import { Readability } from "@mozilla/readability"
import { parseHTML } from "linkedom"

/**
 * ARD §2.5 "Lambda: Readability + Boilerplate Strip". Runs Readability
 * against a linkedom DOM (lighter-weight than jsdom for Lambda cold starts).
 */
export function stripBoilerplate(
  html: string,
  url: string
): { title: string; contentHtml: string } {
  const { document } = parseHTML(html)
  const base = document.createElement("base")
  base.setAttribute("href", url)
  document.head.appendChild(base)
  const reader = new Readability(document as unknown as Document)
  const article = reader.parse()

  if (!article) {
    throw new Error(`Readability could not extract main content for ${url}`)
  }

  return { title: article.title, contentHtml: article.content }
}
