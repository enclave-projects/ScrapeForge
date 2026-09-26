import { z } from "zod"

/** PRD §4.1 — single-URL scrape request (priority path). */
export const ScrapeRequestSchema = z.object({
  url: z.string().url(),
  renderJs: z.boolean().optional(),
  structuredExtractSchema: z.record(z.string(), z.string()).optional(),
  llmCleanup: z.boolean().optional().default(false),
  webhookUrl: z.string().url().optional(),
})
export type ScrapeRequest = z.infer<typeof ScrapeRequestSchema>

/** PRD §4.2 — bulk/site crawl request. */
export const CrawlRequestSchema = z.object({
  rootUrl: z.string().url(),
  maxDepth: z.number().int().min(0).max(10).default(2),
  maxPages: z.number().int().min(1).max(100_000).default(500),
  includePaths: z.array(z.string()).optional(),
  excludePaths: z.array(z.string()).optional(),
  respectRobotsTxt: z.boolean().default(true),
  structuredExtractSchema: z.record(z.string(), z.string()).optional(),
  llmCleanup: z.boolean().optional().default(false),
  webhookUrl: z.string().url().optional(),
  schedule: z
    .object({
      cronExpression: z.string(),
    })
    .optional(),
})
export type CrawlRequest = z.infer<typeof CrawlRequestSchema>

export const JobStatusEnum = z.enum([
  "queued",
  "fetching",
  "processing",
  "done",
  "failed",
])
export type JobStatus = z.infer<typeof JobStatusEnum>

export const JobErrorReasonEnum = z.enum([
  "robots_disallowed",
  "timeout",
  "anti_bot_block",
  "invalid_url",
  "internal_error",
])
export type JobErrorReason = z.infer<typeof JobErrorReasonEnum>

/** DynamoDB Jobs + Crawl State record (ARD §2.2), partition key accountId#jobId. */
export const JobRecordSchema = z.object({
  accountId: z.string(),
  jobId: z.string(),
  jobType: z.enum(["single_url", "crawl"]),
  status: JobStatusEnum,
  errorReason: JobErrorReasonEnum.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  pagesTotal: z.number().int().optional(),
  pagesCompleted: z.number().int().optional(),
  pagesFailed: z.number().int().optional(),
  url: z.string().url().optional(),
  webhookUrl: z.string().url().optional(),
  structuredExtractSchema: z.record(z.string(), z.string()).optional(),
  markdownS3Key: z.string().optional(),
  /** False when the page's content was identical to the last fetch. */
  changed: z.boolean().optional(),
})
export type JobRecord = z.infer<typeof JobRecordSchema>

/** 202 response body for POST /v1/scrape and POST /v1/crawl. */
export const JobAcceptedSchema = z.object({
  jobId: z.string(),
  status: JobStatusEnum,
  jobType: z.enum(["single_url", "crawl"]),
})
export type JobAccepted = z.infer<typeof JobAcceptedSchema>

/** A result file (.md, or .json for structured extraction) and a 1h signed URL. */
export const JobResultSchema = z.object({
  key: z.string(),
  url: z.string().url(),
})
export type JobResult = z.infer<typeof JobResultSchema>

/** GET /v1/jobs/{jobId} response body; results are listed once status is done. */
export const JobStatusResponseSchema = JobRecordSchema.extend({
  results: z.array(JobResultSchema),
})
export type JobStatusResponse = z.infer<typeof JobStatusResponseSchema>
