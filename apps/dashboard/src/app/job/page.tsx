"use client"

import { Suspense, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import type { JobStatusResponse } from "@scrapeforge/sdk"
import { createApiClient } from "@/lib/api-client"

const POLL_INTERVAL_MS = 2000

/** PRD §4.12 — per-job status view (queued/fetching/processing/done/failed). */
export default function JobPage() {
  return (
    <Suspense>
      <JobStatus />
    </Suspense>
  )
}

function JobStatus() {
  const jobId = useSearchParams().get("id") ?? ""
  const [job, setJob] = useState<JobStatusResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!jobId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    async function poll() {
      try {
        const next = await (await createApiClient()).getJob(jobId)
        if (cancelled) return
        setJob(next)
        setError(null)
        if (next.status === "done" || next.status === "failed") return
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      }
      timer = setTimeout(poll, POLL_INTERVAL_MS)
    }
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [jobId])

  const statusColor =
    job?.status === "done"
      ? "bg-green-100 text-green-800"
      : job?.status === "failed"
        ? "bg-red-100 text-red-800"
        : "bg-amber-100 text-amber-800"

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <a href="../" className="text-sm text-slate-600 underline">
        ← All jobs
      </a>
      <h1 className="text-xl font-semibold break-all">Job {jobId}</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {job && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-slate-500">Status</dt>
          <dd>
            <span className={`rounded px-2 py-0.5 font-medium ${statusColor}`}>
              {job.status}
            </span>
            {job.errorReason && (
              <span className="ml-2">({job.errorReason})</span>
            )}
          </dd>
          <dt className="text-slate-500">Type</dt>
          <dd>{job.jobType === "crawl" ? "Crawl" : "Single URL"}</dd>
          <dt className="text-slate-500">Target</dt>
          <dd className="break-all">{job.url}</dd>
          {job.jobType === "crawl" && (
            <>
              <dt className="text-slate-500">Pages</dt>
              <dd>
                {job.pagesCompleted ?? 0} / {job.pagesTotal ?? "?"}
                {job.pagesFailed ? ` (${job.pagesFailed} failed)` : ""}
              </dd>
            </>
          )}
          <dt className="text-slate-500">Updated</dt>
          <dd>{new Date(job.updatedAt).toLocaleString()}</dd>
        </dl>
      )}
      {job && job.results.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Results (links valid for 1 hour)</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {job.results.map((r) => (
              <li key={r.key} className="p-3">
                <a
                  className="break-all underline"
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {r.key}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}
