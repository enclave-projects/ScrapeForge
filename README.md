# ScrapeForge

Cloud-native web scraping and content-extraction platform that converts any
public website into clean, LLM-ready Markdown. See `docs/` (PRD/ARD/TRD) for
product, architecture, and technical requirements.

## Structure (TRD §6)

```
/apps
  /dashboard          → Next.js 14 (App Router) dashboard
  /cli                → oclif CLI (scrapeforge)
  /web                → pre-existing Astro starter (not part of the product; see note below)
/services
  /api-router          → Lambda: Request Validator + Router
  /crawl-orchestrator   → Step Functions supporting Lambdas (sitemap, frontier)
  /fetch-http           → Fargate: Fast HTTP Fetcher
  /fetch-headless        → Fargate: Headless Browser Pool (Playwright)
  /processing            → Lambdas: readability strip, markdown convert, dedup, structured extract
  /delivery               → Lambda: webhook/email dispatch
/packages
  /sdk                  → published TypeScript SDK
  /shared-types          → Zod schemas, shared TS types (single source of truth)
  /llm-client             → Bedrock abstraction layer
  /eslint-config          → shared ESLint config
  /ui                     → pre-existing shadcn/ui component library (see note below)
/infra
  /cdk                  → CDK v2 app (stacks not yet implemented — next phase)
```

> **Note:** `apps/web` and `packages/ui` were already present in this repo
> from a generic Astro+shadcn starter template and predate the ScrapeForge
> TRD. The TRD specifies Next.js for the dashboard (not Astro), so the real
> product dashboard lives in `apps/dashboard`. `apps/web`/`packages/ui` were
> left untouched rather than deleted; decide whether to remove them.

## Environments

`dev` only for now (per ARD §7). `staging`/`prod` are separate AWS accounts
that do not exist yet.
