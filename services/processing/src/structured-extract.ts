import { parseHTML } from "linkedom"
import type { LLMClient } from "@scrapeforge/llm-client"

/**
 * TRD §2.4 — schema-guided extraction: try user-provided CSS selectors
 * first; fall back to a Bedrock call only for fields no selector matched.
 */
export async function structuredExtract(
  html: string,
  schema: Record<string, string>,
  llmClient?: LLMClient
): Promise<Record<string, string | null>> {
  const { document } = parseHTML(html)
  const result: Record<string, string | null> = {}
  const unmatchedFields: string[] = []

  for (const [field, selector] of Object.entries(schema)) {
    const el = document.querySelector(selector)
    const value = el?.textContent?.trim() ?? null
    result[field] = value
    if (!value) unmatchedFields.push(field)
  }

  if (unmatchedFields.length > 0 && llmClient) {
    const prompt = `Extract the following fields as JSON from this page text: ${unmatchedFields.join(", ")}.\n\n${document.body.textContent?.slice(0, 8000)}`
    const completion = await llmClient.complete({
      messages: [{ role: "user", content: prompt }],
    })
    try {
      // Models routinely wrap JSON in markdown code fences (```json ... ```)
      // despite being asked for raw JSON — strip them before parsing.
      const jsonText = completion
        .replace(/^```(?:json)?\s*|\s*```$/g, "")
        .trim()
      const llmResult = JSON.parse(jsonText) as Record<string, string>
      for (const field of unmatchedFields) {
        result[field] = llmResult[field] ?? null
      }
    } catch {
      // LLM did not return valid JSON — leave unmatched fields as null.
    }
  }

  return result
}
