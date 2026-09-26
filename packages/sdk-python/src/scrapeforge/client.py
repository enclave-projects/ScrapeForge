"""ScrapeForge API client.

Mirrors packages/sdk (TypeScript). Request and response shapes follow
packages/shared-types, which is the source of truth; responses are
returned as plain dicts with the API's camelCase keys.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Dict, List, Optional

import httpx

DEFAULT_BASE_URL = "https://api.scrapeforge.dev"
TERMINAL_STATUSES = {"done", "failed"}


class ScrapeForgeError(Exception):
    """A non-2xx response. Carries the API's error envelope."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        request_id: Optional[str] = None,
        retry_after: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.request_id = request_id
        self.retry_after = retry_after


def _scrape_body(
    url: str,
    render_js: Optional[bool],
    structured_extract_schema: Optional[Dict[str, str]],
    webhook_url: Optional[str],
) -> Dict[str, Any]:
    body: Dict[str, Any] = {"url": url}
    if render_js is not None:
        body["renderJs"] = render_js
    if structured_extract_schema:
        body["structuredExtractSchema"] = structured_extract_schema
    if webhook_url:
        body["webhookUrl"] = webhook_url
    return body


def _crawl_body(
    root_url: str,
    max_depth: Optional[int],
    max_pages: Optional[int],
    include_paths: Optional[List[str]],
    exclude_paths: Optional[List[str]],
    structured_extract_schema: Optional[Dict[str, str]],
    webhook_url: Optional[str],
) -> Dict[str, Any]:
    # respectRobotsTxt is deliberately not exposed: it defaults to true
    # server-side and this client doesn't offer a way to turn it off.
    body: Dict[str, Any] = {"rootUrl": root_url}
    optional = {
        "maxDepth": max_depth,
        "maxPages": max_pages,
        "includePaths": include_paths,
        "excludePaths": exclude_paths,
        "structuredExtractSchema": structured_extract_schema,
        "webhookUrl": webhook_url,
    }
    body.update({k: v for k, v in optional.items() if v is not None})
    return body


def _unwrap(response: httpx.Response) -> Any:
    try:
        envelope = response.json()
    except ValueError:
        envelope = None
    if response.is_success and isinstance(envelope, dict) and envelope.get("success"):
        return envelope.get("data")

    error = (envelope or {}).get("error") or {} if isinstance(envelope, dict) else {}
    retry_after = response.headers.get("retry-after")
    raise ScrapeForgeError(
        status=response.status_code,
        code=error.get("code", "HTTP_ERROR"),
        # API Gateway's own 401s aren't wrapped in the envelope.
        message=error.get("message", f"Request failed with status {response.status_code}"),
        request_id=envelope.get("requestId") if isinstance(envelope, dict) else None,
        retry_after=int(retry_after) if retry_after else None,
    )


def _headers(api_key: str) -> Dict[str, str]:
    return {"authorization": f"Bearer {api_key}", "content-type": "application/json"}


class ScrapeForgeClient:
    """Synchronous client. Use as a context manager, or call close()."""

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        transport: Optional[httpx.BaseTransport] = None,
    ) -> None:
        self._http = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers=_headers(api_key),
            timeout=timeout,
            transport=transport,
        )

    def __enter__(self) -> "ScrapeForgeClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._http.close()

    def scrape(
        self,
        url: str,
        *,
        render_js: Optional[bool] = None,
        structured_extract_schema: Optional[Dict[str, str]] = None,
        webhook_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Start a single-URL job. Returns {jobId, status, jobType}."""
        body = _scrape_body(url, render_js, structured_extract_schema, webhook_url)
        return _unwrap(self._http.post("/v1/scrape", json=body))

    def crawl(
        self,
        root_url: str,
        *,
        max_depth: Optional[int] = None,
        max_pages: Optional[int] = None,
        include_paths: Optional[List[str]] = None,
        exclude_paths: Optional[List[str]] = None,
        structured_extract_schema: Optional[Dict[str, str]] = None,
        webhook_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Start a site crawl. Returns {jobId, status, jobType}."""
        body = _crawl_body(
            root_url, max_depth, max_pages, include_paths, exclude_paths,
            structured_extract_schema, webhook_url,
        )
        return _unwrap(self._http.post("/v1/crawl", json=body))

    def get_job(self, job_id: str) -> Dict[str, Any]:
        """Job status; `results` lists signed result URLs once done."""
        return _unwrap(self._http.get(f"/v1/jobs/{job_id}"))

    def wait_for_job(
        self, job_id: str, *, interval: float = 2.0, timeout: float = 300.0
    ) -> Dict[str, Any]:
        """Poll get_job until the job is done or failed."""
        deadline = time.monotonic() + timeout
        while True:
            job = self.get_job(job_id)
            if job["status"] in TERMINAL_STATUSES:
                return job
            if time.monotonic() + interval > deadline:
                raise TimeoutError(f"Timed out waiting for job {job_id} ({job['status']})")
            time.sleep(interval)


class AsyncScrapeForgeClient:
    """asyncio client with the same methods as ScrapeForgeClient."""

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers=_headers(api_key),
            timeout=timeout,
            transport=transport,
        )

    async def __aenter__(self) -> "AsyncScrapeForgeClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._http.aclose()

    async def scrape(
        self,
        url: str,
        *,
        render_js: Optional[bool] = None,
        structured_extract_schema: Optional[Dict[str, str]] = None,
        webhook_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        body = _scrape_body(url, render_js, structured_extract_schema, webhook_url)
        return _unwrap(await self._http.post("/v1/scrape", json=body))

    async def crawl(
        self,
        root_url: str,
        *,
        max_depth: Optional[int] = None,
        max_pages: Optional[int] = None,
        include_paths: Optional[List[str]] = None,
        exclude_paths: Optional[List[str]] = None,
        structured_extract_schema: Optional[Dict[str, str]] = None,
        webhook_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        body = _crawl_body(
            root_url, max_depth, max_pages, include_paths, exclude_paths,
            structured_extract_schema, webhook_url,
        )
        return _unwrap(await self._http.post("/v1/crawl", json=body))

    async def get_job(self, job_id: str) -> Dict[str, Any]:
        return _unwrap(await self._http.get(f"/v1/jobs/{job_id}"))

    async def wait_for_job(
        self, job_id: str, *, interval: float = 2.0, timeout: float = 300.0
    ) -> Dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            job = await self.get_job(job_id)
            if job["status"] in TERMINAL_STATUSES:
                return job
            if time.monotonic() + interval > deadline:
                raise TimeoutError(f"Timed out waiting for job {job_id} ({job['status']})")
            await asyncio.sleep(interval)
