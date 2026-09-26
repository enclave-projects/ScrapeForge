import { ScrapeForgeClient } from "@scrapeforge/sdk"
import { getIdToken } from "./auth"
import { config } from "./config"

export async function createApiClient(): Promise<ScrapeForgeClient> {
  const token = await getIdToken()
  if (!token) throw new Error("Not signed in")
  return new ScrapeForgeClient({ apiKey: token, baseUrl: config.apiBaseUrl })
}

const RECENT_JOBS_KEY = "scrapeforge.recentJobs"

export interface RecentJob {
  jobId: string
  jobType: string
  target: string
  createdAt: string
}

// There's no list-jobs endpoint yet, so the dashboard remembers the jobs
// it submitted in this browser.
export function loadRecentJobs(): RecentJob[] {
  try {
    return JSON.parse(
      localStorage.getItem(RECENT_JOBS_KEY) ?? "[]"
    ) as RecentJob[]
  } catch {
    return []
  }
}

export function rememberJob(job: RecentJob): void {
  try {
    const jobs = [job, ...loadRecentJobs()].slice(0, 20)
    localStorage.setItem(RECENT_JOBS_KEY, JSON.stringify(jobs))
  } catch {
    // Storage unavailable (private mode): the job just isn't remembered.
  }
}
