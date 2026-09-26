import { z } from "zod"

/** DynamoDB Page Metadata/ETags (ARD §2.6) — dedup/change-detection record. */
export const PageMetadataSchema = z.object({
  accountId: z.string(),
  url: z.string().url(),
  contentHash: z.string(),
  etag: z.string().optional(),
  lastFetchedAt: z.string().datetime(),
  lastChangedAt: z.string().datetime(),
  markdownS3Key: z.string(),
  rawHtmlS3Key: z.string(),
})
export type PageMetadata = z.infer<typeof PageMetadataSchema>

/** Required front-matter block on every Markdown output file (TRD §8). */
export const MarkdownFrontMatterSchema = z.object({
  source_url: z.string().url(),
  scraped_at: z.string().datetime(),
  content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
})
export type MarkdownFrontMatter = z.infer<typeof MarkdownFrontMatterSchema>
