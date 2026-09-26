/** PRD §4.12 — per-job status view (queued/fetching/processing/done/failed). */
export default function JobStatusPage({
  params,
}: {
  params: { jobId: string }
}) {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-xl font-semibold">Job {params.jobId}</h1>
    </main>
  )
}
