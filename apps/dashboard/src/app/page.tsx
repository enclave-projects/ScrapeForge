"use client"

import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import {
  confirmSignUp,
  currentEmail,
  getIdToken,
  signIn,
  signOut,
  signUp,
} from "@/lib/auth"
import {
  createApiClient,
  loadRecentJobs,
  rememberJob,
  type RecentJob,
} from "@/lib/api-client"

const inputClass =
  "w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
const buttonClass =
  "rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      {children}
    </label>
  )
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** PRD §6 step 2 — sign in, then submit a job from the Scrape box. */
export default function HomePage() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null)

  useEffect(() => {
    void getIdToken().then((token) => setSignedIn(token !== null))
  }, [])

  if (signedIn === null) return null
  return (
    <main className="mx-auto max-w-2xl space-y-8 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">ScrapeForge</h1>
        {signedIn && (
          <button
            className="text-sm text-slate-600 underline"
            onClick={() => {
              signOut()
              setSignedIn(false)
            }}
          >
            Sign out {currentEmail()}
          </button>
        )}
      </header>
      {signedIn ? (
        <Workspace />
      ) : (
        <AuthPanel onSignedIn={() => setSignedIn(true)} />
      )}
    </main>
  )
}

function AuthPanel({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<"signIn" | "signUp" | "confirm">("signIn")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (mode === "signUp") {
        await signUp(email, password)
        setMode("confirm")
      } else if (mode === "confirm") {
        await confirmSignUp(email, code)
        await signIn(email, password)
        onSignedIn()
      } else {
        await signIn(email, password)
        onSignedIn()
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border p-6">
      <h2 className="text-lg font-semibold">
        {mode === "signIn"
          ? "Sign in"
          : mode === "signUp"
            ? "Create account"
            : "Confirm email"}
      </h2>
      <Field label="Email">
        <input
          className={inputClass}
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={mode === "confirm"}
        />
      </Field>
      {mode !== "confirm" && (
        <Field label="Password">
          <input
            className={inputClass}
            type="password"
            required
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      )}
      {mode === "confirm" && (
        <Field label="Verification code (sent to your email)">
          <input
            className={inputClass}
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
      )}
      {mode === "signUp" && (
        <p className="text-xs text-slate-500">
          At least 12 characters with upper, lower, digit and symbol.
        </p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center gap-4">
        <button className={buttonClass} disabled={busy}>
          {busy
            ? "Working…"
            : mode === "signIn"
              ? "Sign in"
              : mode === "signUp"
                ? "Create account"
                : "Confirm"}
        </button>
        {mode !== "confirm" && (
          <button
            type="button"
            className="text-sm text-slate-600 underline"
            onClick={() => setMode(mode === "signIn" ? "signUp" : "signIn")}
          >
            {mode === "signIn" ? "Create an account" : "I have an account"}
          </button>
        )}
      </div>
    </form>
  )
}

function Workspace() {
  const [jobType, setJobType] = useState<"scrape" | "crawl">("scrape")
  const [url, setUrl] = useState("")
  const [renderJs, setRenderJs] = useState(false)
  const [maxPages, setMaxPages] = useState(10)
  const [schemaText, setSchemaText] = useState("")
  const [webhookUrl, setWebhookUrl] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [recent, setRecent] = useState<RecentJob[]>([])

  useEffect(() => setRecent(loadRecentJobs()), [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const structuredExtractSchema = schemaText.trim()
        ? (JSON.parse(schemaText) as Record<string, string>)
        : undefined
      const client = await createApiClient()
      const common = {
        structuredExtractSchema,
        webhookUrl: webhookUrl.trim() || undefined,
        llmCleanup: false,
      }
      const accepted =
        jobType === "scrape"
          ? await client.scrape({ url, renderJs, ...common })
          : await client.crawl({
              rootUrl: url,
              maxPages,
              maxDepth: 2,
              respectRobotsTxt: true,
              ...common,
            })
      rememberJob({
        jobId: accepted.jobId,
        jobType: accepted.jobType,
        target: url,
        createdAt: new Date().toISOString(),
      })
      window.location.href = `job/?id=${accepted.jobId}`
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-8">
      <form onSubmit={submit} className="space-y-4 rounded-lg border p-6">
        <div className="flex gap-2">
          {(["scrape", "crawl"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setJobType(t)}
              className={`rounded px-3 py-1 text-sm ${jobType === t ? "bg-slate-900 text-white" : "bg-slate-100"}`}
            >
              {t === "scrape" ? "Single URL" : "Crawl site"}
            </button>
          ))}
        </div>
        <Field label={jobType === "scrape" ? "URL" : "Root URL"}>
          <input
            className={inputClass}
            type="url"
            required
            placeholder="https://example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        {jobType === "scrape" ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={renderJs}
              onChange={(e) => setRenderJs(e.target.checked)}
            />
            Force JavaScript rendering
          </label>
        ) : (
          <Field label="Max pages">
            <input
              className={inputClass}
              type="number"
              min={1}
              max={1000}
              value={maxPages}
              onChange={(e) => setMaxPages(Number(e.target.value))}
            />
          </Field>
        )}
        <Field label='Structured extraction schema (optional JSON: {"field": "css selector"})'>
          <textarea
            className={`${inputClass} font-mono`}
            rows={3}
            placeholder='{"title": "h1", "price": ".price"}'
            value={schemaText}
            onChange={(e) => setSchemaText(e.target.value)}
          />
        </Field>
        <Field label="Webhook URL (optional, https)">
          <input
            className={inputClass}
            type="url"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
          />
        </Field>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className={buttonClass} disabled={busy}>
          {busy ? "Submitting…" : "Start job"}
        </button>
      </form>

      {recent.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Recent jobs</h2>
          <ul className="divide-y rounded-lg border">
            {recent.map((job) => (
              <li
                key={job.jobId}
                className="flex justify-between gap-4 p-3 text-sm"
              >
                <a className="truncate underline" href={`job/?id=${job.jobId}`}>
                  {job.target}
                </a>
                <span className="shrink-0 text-slate-500">
                  {job.jobType === "crawl" ? "crawl" : "scrape"} ·{" "}
                  {new Date(job.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
