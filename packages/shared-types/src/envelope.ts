import { z } from "zod"

/** TRD §8: single response envelope used by every API Gateway response. */
export const ApiEnvelopeSchema = z.object({
  success: z.boolean(),
  data: z.unknown().nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .nullable(),
  requestId: z.string(),
})
export type ApiEnvelope<T = unknown> = Omit<
  z.infer<typeof ApiEnvelopeSchema>,
  "data"
> & {
  data: T | null
}
