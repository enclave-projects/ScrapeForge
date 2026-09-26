# scrapeforge (Python)

Hand-written `httpx` client for the ScrapeForge API. It mirrors `packages/sdk` (TypeScript).

```python
from scrapeforge import ScrapeForgeClient

with ScrapeForgeClient(api_key=id_token, base_url="https://<api-id>.execute-api.ap-south-1.amazonaws.com") as client:
    job = client.scrape("https://example.com", structured_extract_schema={"title": "h1"})
    done = client.wait_for_job(job["jobId"])
    for result in done["results"]:
        print(result["key"], result["url"])
```

`api_key` is a Cognito ID token for your account. Errors raise `ScrapeForgeError`, which carries `status`, `code`, `request_id` and, on HTTP 429, `retry_after`.

Run the tests with `uv run pytest`.
