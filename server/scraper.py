"""
scraper.py — thin async wrapper around python-jobspy.

The jobspy library is synchronous and serializes per-call; we run it in a
thread pool with a hard timeout, and gate concurrent calls with an asyncio
semaphore so we don't fork-bomb the upstream job boards.

Returned dicts are normalized to a stable shape so the frontend doesn't need
to know about jobspy's per-site quirks.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import json
import logging
import os
import re
import threading
import time
import urllib.parse
from typing import Any

import cloudscraper
import pandas as pd
from jobspy import scrape_jobs

log = logging.getLogger("agent-jobs.scraper")

DEFAULT_SITES = [s.strip() for s in os.getenv("SCRAPE_DEFAULT_SITES", "linkedin,indeed,glassdoor").split(",") if s.strip()]
DEFAULT_HOURS_OLD = int(os.getenv("SCRAPE_DEFAULT_HOURS_OLD", "168"))
DEFAULT_RESULTS_WANTED = int(os.getenv("SCRAPE_MAX_PER_SITE", "50"))
DEFAULT_TIMEOUT_SECONDS = int(os.getenv("SCRAPE_TIMEOUT_SECONDS", "90"))

ALLOWED_SITES = {"linkedin", "indeed", "glassdoor", "zip_recruiter", "google", "naukri", "simplyhired"}

# Naukri's free-tier anti-bot is much more easily tripped than the other sites --
# gate it behind an explicit opt-in, cap how much we ask for, and never run more
# than one naukri scrape at a time regardless of how many searches are in flight,
# so it can't get our IP flagged or hammer their server. Off by default: an
# operator has to deliberately "allocate" it via env var before it does anything.
NAUKRI_ENABLED = os.getenv("SCRAPE_ENABLE_NAUKRI", "false").strip().lower() in ("1", "true", "yes")
NAUKRI_MAX_RESULTS = int(os.getenv("SCRAPE_NAUKRI_MAX_RESULTS", "30"))
_NAUKRI_LOCK = threading.Semaphore(1)

# jobspy has no SimplyHired support at all -- it's scraped directly here via
# cloudscraper (SimplyHired sits behind a Cloudflare JS challenge that plain
# requests can't pass). Same opt-in/rate-limit treatment as naukri: fragile
# by nature (breaks whenever Cloudflare's challenge changes), so it's off by
# default and capped/serialized to avoid hammering them.
SIMPLYHIRED_ENABLED = os.getenv("SCRAPE_ENABLE_SIMPLYHIRED", "false").strip().lower() in ("1", "true", "yes")
SIMPLYHIRED_MAX_RESULTS = int(os.getenv("SCRAPE_SIMPLYHIRED_MAX_RESULTS", "40"))
_SIMPLYHIRED_LOCK = threading.Semaphore(1)
_simplyhired_scraper = None
_NEXT_DATA_RE = re.compile(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.S)


def _get_simplyhired_scraper():
    global _simplyhired_scraper
    if _simplyhired_scraper is None:
        _simplyhired_scraper = cloudscraper.create_scraper()
    return _simplyhired_scraper


def _parse_simplyhired_salary(salary_info: str | None) -> tuple[Any, Any, Any, Any]:
    if not salary_info:
        return None, None, None, None
    s = salary_info.lower()
    if "year" in s:
        interval = "yearly"
    elif "hour" in s:
        interval = "hourly"
    elif "month" in s:
        interval = "monthly"
    elif "week" in s:
        interval = "weekly"
    else:
        interval = None
    nums = [float(n.replace(",", "")) for n in re.findall(r"[\d,]+(?:\.\d+)?", salary_info)]
    if not nums:
        return None, None, None, interval
    if len(nums) >= 2:
        return nums[0], nums[1], "USD", interval
    return nums[0], nums[0], "USD", interval


def _scrape_simplyhired_sync(
    search_term: str,
    location: str,
    hours_old: int,
    results_wanted: int,
) -> list[dict[str, Any]]:
    """SimplyHired's search page is server-rendered Next.js -- the full result
    set for the page is embedded as JSON in a __NEXT_DATA__ script tag, so this
    parses that directly instead of scraping HTML. Pagination is by opaque
    cursor token (not a page number); the first page's response hands back
    cursors for the next several pages up front."""
    scraper = _get_simplyhired_scraper()
    results_wanted = min(results_wanted, SIMPLYHIRED_MAX_RESULTS)
    cutoff_ms = (time.time() - hours_old * 3600) * 1000

    jobs: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    cursors: dict[str, str] = {}
    page = 1
    while len(jobs) < results_wanted and page <= 4:
        params = {"q": search_term, "l": location or ""}
        if page > 1:
            cursor = cursors.get(str(page))
            if not cursor:
                break
            params["cursor"] = cursor
        url = "https://www.simplyhired.com/search?" + urllib.parse.urlencode(params)
        resp = scraper.get(url, timeout=20)
        if resp.status_code != 200:
            break
        m = _NEXT_DATA_RE.search(resp.text)
        if not m:
            break
        page_props = json.loads(m.group(1)).get("props", {}).get("pageProps", {})
        if page == 1:
            cursors = page_props.get("pageCursors") or {}
        page_jobs = page_props.get("jobs") or []
        if not page_jobs:
            break

        for j in page_jobs:
            key = j.get("jobKey")
            if not key or key in seen_keys:
                continue
            seen_keys.add(key)
            posted_ms = j.get("dateOnIndeed")
            if posted_ms is not None and posted_ms < cutoff_ms:
                continue
            salary_min, salary_max, currency, interval = _parse_simplyhired_salary(j.get("salaryInfo"))
            job_types = j.get("jobTypes") or []
            jobs.append({
                "id": key,
                "title": (j.get("title") or "").strip(),
                "company": (j.get("company") or "").strip(),
                "location": (j.get("location") or "").strip(),
                "site": "simplyhired",
                "url": "https://www.simplyhired.com" + (j.get("botUrl") or ""),
                "date_posted": None,
                "salary_min": salary_min,
                "salary_max": salary_max,
                "salary_currency": currency,
                "interval": interval,
                "description": (j.get("snippet") or "").strip()[:2000],
                "is_remote": "Remote" in (j.get("remoteAttributes") or []),
                "job_type": job_types[0] if job_types else None,
            })
            if len(jobs) >= results_wanted:
                break
        page += 1
    return jobs


# global semaphore — limits concurrent scrapes regardless of which endpoint hit
_SEM: asyncio.Semaphore | None = None


def get_semaphore() -> asyncio.Semaphore:
    global _SEM
    if _SEM is None:
        _SEM = asyncio.Semaphore(2)
    return _SEM


def _job_to_dict(row: Any) -> dict[str, Any]:
    """jobspy returns a pandas DataFrame; normalize each row to a clean dict."""
    def _g(key: str, default: Any = None) -> Any:
        try:
            v = row.get(key)
            if v is None or (isinstance(v, float) and pd.isna(v)):
                return default
            return v
        except Exception:
            return default

    def _clean_text(s: Any) -> str:
        if not s:
            return ""
        # strip excessive whitespace and html
        s = re.sub(r"<[^>]+>", " ", str(s))
        s = re.sub(r"\s+", " ", s).strip()
        return s

    return {
        "id": str(_g("id") or _g("job_url") or ""),
        "title": _clean_text(_g("title")),
        "company": _clean_text(_g("company")),
        "location": _clean_text(_g("location")),
        "site": _g("site", ""),
        "url": _g("job_url", ""),
        "date_posted": str(_g("date_posted")) if _g("date_posted") is not None else None,
        "salary_min": _g("min_amount"),
        "salary_max": _g("max_amount"),
        "salary_currency": _g("currency"),
        "interval": _g("interval"),
        "description": _clean_text(_g("description"))[:2000],  # cap size
        "is_remote": bool(_g("is_remote")),
        "job_type": _g("job_type"),
    }


# matches the <li data-value=...> options in the country dropdown (index.html)
COUNTRY_LABELS = {
    "usa": "USA", "india": "India", "uk": "UK", "canada": "Canada",
    "australia": "Australia", "germany": "Germany", "singapore": "Singapore",
    "uae": "UAE",
}


def _scrape_sync(
    sites: list[str],
    search_term: str,
    location: str,
    hours_old: int,
    results_wanted: int,
    country_indeed: str,
) -> list[dict[str, Any]]:
    """the actual blocking jobspy call. runs in a thread."""
    # LinkedIn/Google/etc. key off `location` alone, not `country_indeed` (that
    # only scopes Indeed/Glassdoor) -- so an empty location must still fall back
    # to the *selected* country, not a hardcoded "USA", or those sites keep
    # returning US jobs no matter what country was picked.
    df: pd.DataFrame = scrape_jobs(
        site_name=sites,
        search_term=search_term,
        location=location or COUNTRY_LABELS.get(country_indeed.lower(), country_indeed or "USA"),
        hours_old=hours_old,
        results_wanted=results_wanted,
        country_indeed=country_indeed,
        description_format="markdown",
        verbose=0,
    )
    if df is None or df.empty:
        return []
    # deduplicate by job_url — different sites sometimes return the same posting
    df = df.drop_duplicates(subset=["job_url"], keep="first")
    return [_job_to_dict(row) for _, row in df.iterrows()]


def _scrape_one_site_sync(
    site: str,
    search_term: str,
    location: str,
    hours_old: int,
    results_wanted: int,
    country_indeed: str,
) -> list[dict[str, Any]]:
    """Same as _scrape_sync but for exactly one site -- lets the caller dispatch
    sites as separate thread-pool tasks so each site's results are available as
    soon as that site finishes, instead of waiting on the slowest one."""
    if site == "naukri":
        if not NAUKRI_ENABLED:
            raise RuntimeError("naukri scraping is disabled on this deployment (set SCRAPE_ENABLE_NAUKRI=true)")
        results_wanted = min(results_wanted, NAUKRI_MAX_RESULTS)
        with _NAUKRI_LOCK:
            return _scrape_sync([site], search_term, location, hours_old, results_wanted, country_indeed)
    if site == "simplyhired":
        if not SIMPLYHIRED_ENABLED:
            raise RuntimeError("simplyhired scraping is disabled on this deployment (set SCRAPE_ENABLE_SIMPLYHIRED=true)")
        with _SIMPLYHIRED_LOCK:
            return _scrape_simplyhired_sync(search_term, location, hours_old, results_wanted)
    return _scrape_sync([site], search_term, location, hours_old, results_wanted, country_indeed)


def _scrape_multi_sync(
    sites: list[str],
    search_term: str,
    location: str,
    hours_old: int,
    results_wanted: int,
    country_indeed: str,
) -> list[dict[str, Any]]:
    """Runs each site as its own isolated call instead of one combined jobspy
    call -- so a broken or rate-limited site (naukri especially) can't take
    the working sites' results down with it. Used by the non-streaming
    /api/scrape endpoint; /api/scrape-stream already isolates per-site via
    separate executor tasks."""
    all_jobs: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(sites))) as pool:
        futures = {
            pool.submit(_scrape_one_site_sync, site, search_term, location, hours_old, results_wanted, country_indeed): site
            for site in sites
        }
        for fut in concurrent.futures.as_completed(futures):
            site = futures[fut]
            try:
                jobs = fut.result()
            except Exception:
                log.exception(f"site failed (non-streaming, falling back to other sites): {site}")
                continue
            for j in jobs:
                if j.get("url") not in seen_urls:
                    seen_urls.add(j.get("url"))
                    all_jobs.append(j)
    return all_jobs


async def scrape_streaming(
    search_term: str,
    location: str = "",
    sites: list[str] | None = None,
    hours_old: int | None = None,
    results_wanted: int | None = None,
    timeout_seconds: int | None = None,
    country_indeed: str = "usa",
):
    """Same inputs/validation as scrape(), but yields one dict per site as soon as
    that site's scrape finishes, instead of one combined result at the end. Each
    yielded dict: {site, ok, jobs, count, error?}. A final {done: true, ...} dict
    closes the stream with the merged totals."""
    if not search_term or not search_term.strip():
        raise ValueError("search_term is required")

    sites = sites or DEFAULT_SITES
    sites = [s for s in sites if s in ALLOWED_SITES]
    if not sites:
        raise ValueError(f"no valid sites; allowed: {sorted(ALLOWED_SITES)}")

    hours_old = hours_old if hours_old is not None else DEFAULT_HOURS_OLD
    results_wanted = results_wanted if results_wanted is not None else DEFAULT_RESULTS_WANTED
    timeout_seconds = timeout_seconds or DEFAULT_TIMEOUT_SECONDS
    results_wanted = max(1, min(int(results_wanted), 200))
    hours_old = max(1, min(int(hours_old), 24 * 30))

    sem = get_semaphore()
    async with sem:
        log.info(f"streaming scrape start: term={search_term!r} loc={location!r} sites={sites} limit={results_wanted}")
        loop = asyncio.get_event_loop()
        tasks = {
            loop.run_in_executor(
                None, _scrape_one_site_sync, site, search_term, location, hours_old, results_wanted, country_indeed
            ): site
            for site in sites
        }

        seen_urls: set[str] = set()
        total = 0
        deadline = loop.time() + timeout_seconds

        pending = set(tasks.keys())
        while pending:
            remaining = deadline - loop.time()
            if remaining <= 0:
                for t in pending:
                    t.cancel()
                for t in pending:
                    yield {"site": tasks[t], "ok": False, "error": "timeout", "jobs": [], "count": 0}
                break

            done, pending = await asyncio.wait(pending, timeout=remaining, return_when=asyncio.FIRST_COMPLETED)
            for t in done:
                site = tasks[t]
                try:
                    jobs = t.result()
                    # cross-site duplicates (same posting mirrored on two boards)
                    fresh = [j for j in jobs if j.get("url") not in seen_urls]
                    for j in fresh:
                        seen_urls.add(j.get("url"))
                    total += len(fresh)
                    log.info(f"site done: {site} -> {len(fresh)} new job(s)")
                    yield {"site": site, "ok": True, "jobs": fresh, "count": len(fresh)}
                except Exception as e:
                    log.exception(f"site failed: {site}")
                    yield {"site": site, "ok": False, "error": str(e)[:300], "jobs": [], "count": 0}

        yield {"done": True, "count": total, "sites": sites}


async def scrape(
    search_term: str,
    location: str = "",
    sites: list[str] | None = None,
    hours_old: int | None = None,
    results_wanted: int | None = None,
    timeout_seconds: int | None = None,
    country_indeed: str = "usa",
) -> dict[str, Any]:
    """public scrape entry. validates inputs, gates concurrency, enforces timeout."""
    if not search_term or not search_term.strip():
        raise ValueError("search_term is required")

    sites = sites or DEFAULT_SITES
    sites = [s for s in sites if s in ALLOWED_SITES]
    if not sites:
        raise ValueError(f"no valid sites; allowed: {sorted(ALLOWED_SITES)}")

    hours_old = hours_old if hours_old is not None else DEFAULT_HOURS_OLD
    results_wanted = results_wanted if results_wanted is not None else DEFAULT_RESULTS_WANTED
    timeout_seconds = timeout_seconds or DEFAULT_TIMEOUT_SECONDS

    # soft cap on results_wanted — protect upstream
    results_wanted = max(1, min(int(results_wanted), 200))
    hours_old = max(1, min(int(hours_old), 24 * 30))  # max 30 days

    sem = get_semaphore()
    async with sem:
        log.info(f"scrape start: term={search_term!r} loc={location!r} sites={sites} limit={results_wanted}")
        try:
            loop = asyncio.get_event_loop()
            jobs = await asyncio.wait_for(
                loop.run_in_executor(
                    None,
                    _scrape_multi_sync,
                    sites,
                    search_term,
                    location,
                    hours_old,
                    results_wanted,
                    country_indeed,
                ),
                timeout=timeout_seconds,
            )
        except asyncio.TimeoutError:
            log.warning(f"scrape timed out after {timeout_seconds}s")
            return {
                "ok": False,
                "error": "timeout",
                "message": f"scrape exceeded {timeout_seconds}s",
                "jobs": [],
                "count": 0,
                "sites": sites,
                "search_term": search_term,
                "location": location,
            }
        except Exception as e:
            log.exception("scrape failed")
            return {
                "ok": False,
                "error": "scrape_failed",
                "message": str(e)[:500],
                "jobs": [],
                "count": 0,
                "sites": sites,
                "search_term": search_term,
                "location": location,
            }

    # per-site breakdown -- a merged list alone hides which sites actually returned
    # anything, and callers have no way to tell "site returned 0" from "site was never
    # asked". Every requested site gets a count here, including the zeros.
    site_counts = {s: 0 for s in sites}
    for j in jobs:
        if j.get("site") in site_counts:
            site_counts[j["site"]] += 1

    log.info(f"scrape done: {len(jobs)} unique jobs, by site: {site_counts}")
    return {
        "ok": True,
        "jobs": jobs,
        "count": len(jobs),
        "sites": sites,
        "site_counts": site_counts,
        "search_term": search_term,
        "location": location,
        "hours_old": hours_old,
        "results_wanted": results_wanted,
    }
