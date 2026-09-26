import asyncio
import json

import httpx
import pytest

from scrapeforge import AsyncScrapeForgeClient, ScrapeForgeClient, ScrapeForgeError


def envelope(data, request_id="req-1"):
    return {"success": True, "data": data, "error": None, "requestId": request_id}


def test_scrape_sends_camel_case_body_and_bearer_token():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(202, json=envelope({"jobId": "j1", "status": "queued", "jobType": "single_url"}))

    with ScrapeForgeClient("tok", base_url="https://api.test/", transport=httpx.MockTransport(handler)) as client:
        accepted = client.scrape("https://example.com", render_js=True, structured_extract_schema={"t": "h1"})

    assert accepted["jobId"] == "j1"
    assert seen["path"] == "/v1/scrape"
    assert seen["auth"] == "Bearer tok"
    assert seen["body"] == {"url": "https://example.com", "renderJs": True, "structuredExtractSchema": {"t": "h1"}}


def test_crawl_omits_unset_options():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return httpx.Response(202, json=envelope({"jobId": "c1", "status": "queued", "jobType": "crawl"}))

    with ScrapeForgeClient("tok", base_url="https://api.test", transport=httpx.MockTransport(handler)) as client:
        client.crawl("https://example.com", max_pages=5)

    assert seen["body"] == {"rootUrl": "https://example.com", "maxPages": 5}


def test_rate_limit_error_carries_retry_after():
    def handler(request):
        return httpx.Response(
            429,
            headers={"retry-after": "2"},
            json={"success": False, "data": None, "error": {"code": "RATE_LIMITED", "message": "slow down"}, "requestId": "r9"},
        )

    with ScrapeForgeClient("tok", base_url="https://api.test", transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(ScrapeForgeError) as info:
            client.get_job("j1")

    assert info.value.status == 429
    assert info.value.code == "RATE_LIMITED"
    assert info.value.retry_after == 2
    assert info.value.request_id == "r9"


def test_gateway_401_without_envelope():
    def handler(request):
        return httpx.Response(401, json={"message": "Unauthorized"})

    with ScrapeForgeClient("bad", base_url="https://api.test", transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(ScrapeForgeError) as info:
            client.get_job("j1")

    assert info.value.status == 401
    assert info.value.code == "HTTP_ERROR"


def test_wait_for_job_polls_until_terminal():
    statuses = iter(["queued", "fetching", "done"])

    def handler(request):
        return httpx.Response(200, json=envelope({"jobId": "j1", "status": next(statuses), "results": []}))

    with ScrapeForgeClient("tok", base_url="https://api.test", transport=httpx.MockTransport(handler)) as client:
        job = client.wait_for_job("j1", interval=0)

    assert job["status"] == "done"


def test_async_client_scrape():
    def handler(request):
        return httpx.Response(202, json=envelope({"jobId": "a1", "status": "queued", "jobType": "single_url"}))

    async def run():
        async with AsyncScrapeForgeClient("tok", base_url="https://api.test", transport=httpx.MockTransport(handler)) as client:
            return await client.scrape("https://example.com")

    assert asyncio.run(run())["jobId"] == "a1"
