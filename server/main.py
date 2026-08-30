"""
main.py — fastapi app.

Routes:
  GET  /                  → dashboard (static HTML)
  GET  /api/health        → {ok, version, sites_supported}
  POST /api/scrape        → body: {search_term, location, sites, hours_old, results_wanted}
                          → returns normalized job list (see scraper.py)
"""
from __future__ import annotations

import asyncio
import html as html_module
import json
import logging
import os
import re
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import scraper
import admin

log_level = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=log_level,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("agent-jobs.main")

VERSION = "1.0.0"

MINIMAX_API_KEY = os.getenv("MINIMAX_API_KEY", "")
MINIMAX_API_URL = os.getenv("MINIMAX_API_URL", "https://api.minimax.io/v1/text/chatcompletion_v2")
MINIMAX_MODEL = os.getenv("MINIMAX_MODEL", "MiniMax-Text-01")

app = FastAPI(
    title="Agent Jobs",
    description="Job board scraper (linkedin/indeed/glassdoor) with a tiny dashboard.",
    version=VERSION,
)

# Local-only tool called from other localhost pages (e.g. the resume builder on a
# different port) -- no cookies/auth involved, so a wide-open localhost CORS policy
# is fine here and avoids fighting the browser for every dev port combination.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ScrapeRequest(BaseModel):
    search_term: str = Field(..., min_length=1, max_length=200, description="job title / keywords")
    location: str = Field("", max_length=200, description='e.g. "Remote", "San Francisco", or empty')
    sites: list[str] | None = Field(None, description='subset of ["linkedin","indeed","glassdoor","zip_recruiter","google"]; default = all configured')
    hours_old: int | None = Field(None, ge=1, le=24 * 30, description="filter: posted within N hours")
    results_wanted: int | None = Field(None, ge=1, le=200, description="per-site cap")
    timeout_seconds: int | None = Field(None, ge=5, le=300, description="override default 90s timeout")
    country_indeed: str = Field("usa", max_length=50, description='country name for Indeed/Glassdoor, e.g. "usa", "india", "uk" -- see jobspy.model.Country for the full list')


@app.get("/api/health")
async def health() -> dict:
    return {
        "ok": True,
        "version": VERSION,
        "sites_supported": sorted(scraper.ALLOWED_SITES),
        "sites_default": scraper.DEFAULT_SITES,
        "timeout_default_s": scraper.DEFAULT_TIMEOUT_SECONDS,
    }


async def _minimax_chat(system_prompt: str, user_prompt: str, timeout: float = 30) -> str:
    """Shared MiniMax chat-completion call. Raises HTTPException on any failure
    (unreachable, API error, unexpected response shape) so callers can just
    await this and not repeat the same error handling."""
    if not MINIMAX_API_KEY:
        raise HTTPException(status_code=503, detail="AI feature is not configured (missing MINIMAX_API_KEY).")

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                MINIMAX_API_URL,
                headers={
                    "Authorization": f"Bearer {MINIMAX_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": MINIMAX_MODEL,
                    "messages": [
                        {"role": "system", "name": "assistant", "content": system_prompt},
                        {"role": "user", "name": "user", "content": user_prompt},
                    ],
                },
            )
        resp.raise_for_status()
        data = resp.json()
    except httpx.HTTPError:
        log.exception("minimax request failed")
        raise HTTPException(status_code=502, detail="AI service is unreachable right now.")

    base_resp = data.get("base_resp") or {}
    if base_resp.get("status_code", 0) not in (0, None):
        log.error("minimax error: %s", base_resp)
        raise HTTPException(status_code=502, detail=base_resp.get("status_msg") or "AI service error.")

    try:
        return data["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, AttributeError):
        log.error("unexpected minimax response shape: %s", data)
        raise HTTPException(status_code=502, detail="AI service returned an unexpected response.")


class GenerateSummaryRequest(BaseModel):
    jd: str = Field(..., min_length=1, max_length=8000, description="job description text, or a URL to a job posting")
    name: str = Field("", max_length=200)
    headline: str = Field("", max_length=200)
    skills: str = Field("", max_length=500, description="comma-separated skills")


URL_ONLY_RE = re.compile(r"^https?://\S+$", re.I)


MIN_USABLE_TEXT_LEN = 250  # shorter than this reads as "loading shell", not real content


def _strip_html_to_text(body: str) -> str:
    body = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", " ", body, flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", body)
    text = html_module.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\s*\n\s*", "\n", text).strip()
    return text


async def _fetch_static_text(url: str, timeout: float = 15) -> str:
    """Cheap path: a plain server-side HTTP fetch, no JS execution. Returns
    "" on any failure -- the caller decides what to do about it (fall back to
    a real browser render, see _fetch_rendered_text below)."""
    try:
        async with httpx.AsyncClient(
            timeout=timeout, follow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 (compatible; ResumeBuilderBot/1.0)"},
        ) as client:
            resp = await client.get(url)
        resp.raise_for_status()
    except httpx.HTTPError:
        return ""

    return _strip_html_to_text(resp.text)


# Only one headless-browser render at a time -- this box has 1GB RAM total
# and already runs job scraping in the same process; a second concurrent
# Chromium instance is a real OOM risk, so requests queue instead of piling
# up multiple browsers.
_chromium_semaphore = asyncio.Semaphore(1)


async def _fetch_rendered_text(url: str, timeout: float = 25) -> str:
    """Heavier fallback for JS-rendered career sites (Workday/ADP/etc.) that
    a plain fetch can't read -- launches a real headless Chromium via
    Playwright. Best-effort: returns "" on ANY failure (Chromium not
    installed, launch failure, page timeout) rather than raising, so a
    broken or not-yet-provisioned browser setup just degrades to whatever
    the static fetch got instead of breaking the request."""
    try:
        # Must match the predeploy hook's install path exactly -- the app
        # runs as a different user (different $HOME) than the root-run hook
        # that installed the browser, so the default ~/.cache/ms-playwright
        # lookup would never find it.
        os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", "/opt/ms-playwright")
        from playwright.async_api import async_playwright
    except ImportError:
        return ""

    async with _chromium_semaphore:
        try:
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(args=[
                    "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
                    "--disable-extensions", "--disable-background-networking",
                ])
                try:
                    page = await browser.new_page()
                    await page.goto(url, wait_until="networkidle", timeout=timeout * 1000)

                    # Best-effort consent-wall dismiss -- some sites (ADP
                    # included) gate the real content behind a cookie/privacy
                    # consent manager, which is itself often embedded in its
                    # own iframe (OneTrust/TrustArc-style widgets), so this
                    # checks every frame, not just the main page, and tries
                    # both the well-known tool-specific button IDs and common
                    # button text. If dismissing reveals more content, give
                    # the page a moment to load it.
                    consent_selectors = [
                        "#onetrust-accept-btn-handler", "#truste-consent-button",
                        "button:has-text('Accept all')", "button:has-text('Accept All')",
                        "button:has-text('Allow all')", "button:has-text('Allow All')",
                        "button:has-text('Accept')", "button:has-text('I Agree')",
                        "button:has-text('Got it')",
                        # Granular preference-center variants (TrustArc etc.)
                        # -- these show categories/checkboxes instead of a
                        # single "Accept" button, so the confirm action reads
                        # differently.
                        "button:has-text('Save Changes')", "button:has-text('Confirm')",
                        "button:has-text('Continue')", "button:has-text('Select All')",
                    ]
                    dismissed = False
                    for frame in page.frames:
                        if dismissed:
                            break
                        for sel in consent_selectors:
                            try:
                                loc = frame.locator(sel)
                                if await loc.count():
                                    await loc.first.click(timeout=1500)
                                    dismissed = True
                                    break
                            except Exception:
                                pass
                    if dismissed:
                        try:
                            await page.wait_for_load_state("networkidle", timeout=8000)
                        except Exception:
                            await page.wait_for_timeout(1000)

                    # Full HTML rather than inner_text: a cookie-consent modal
                    # (or any overlay) can mark the real content
                    # hidden/inert while it's up, which inner_text -- visible
                    # text only -- would then miss entirely even though the
                    # content is already in the DOM. Also walk every iframe:
                    # ATS embeds (Workday/ADP/etc.) commonly load the actual
                    # posting inside one, which the main frame's HTML alone
                    # doesn't include.
                    log.info("render: dismissed_consent=%s frames=%s", dismissed, [f.url for f in page.frames])
                    html_parts = [await page.content()]
                    for frame in page.frames:
                        if frame == page.main_frame:
                            continue
                        try:
                            html_parts.append(await frame.content())
                        except Exception:
                            pass
                finally:
                    await browser.close()
        except Exception:
            log.exception("headless render failed for %s", url)
            return ""

    return "\n".join(_strip_html_to_text(h) for h in html_parts)


async def _fetch_page_text(url: str) -> str:
    """Job-posting text for a pasted link, tried cheapest-first: a plain
    fetch handles most postings; a full headless-browser render (heavy, see
    above) only runs when that didn't get enough real content -- e.g.
    Workday/ADP-style pages that render client-side via JS."""
    text = await _fetch_static_text(url)
    if len(text) < MIN_USABLE_TEXT_LEN:
        rendered = await _fetch_rendered_text(url)
        if len(rendered) > len(text):
            text = rendered

    if not text:
        raise HTTPException(status_code=502, detail="Couldn't fetch that link -- double-check the URL and try again.")
    if len(text) < MIN_USABLE_TEXT_LEN:
        raise HTTPException(
            status_code=422,
            detail="Couldn't find enough of that posting's text to work with -- "
                   "copy the job description text itself and paste it here instead.",
        )
    return text[:8000]


@app.post("/api/generate-summary")
async def generate_summary(req: GenerateSummaryRequest) -> dict:
    profile_bits = []
    if req.headline:
        profile_bits.append(f"Target role: {req.headline}")
    if req.skills:
        profile_bits.append(f"Skills: {req.skills}")
    profile = "\n".join(profile_bits) or "No extra profile details given."

    jd_text = req.jd.strip()
    if URL_ONLY_RE.match(jd_text):
        source_url = jd_text
        jd_text = await _fetch_page_text(source_url)
        log.info("scraped %d chars from %s: %r", len(jd_text), source_url, jd_text[:400])

    prompt = (
        "Given the job description below, return a JSON object with three fields:\n"
        '"title" -- the job title this posting is for, exactly as the posting states it '
        '(e.g. "Senior Data Engineer"), or "" if you can\'t find one stated.\n'
        '"summary" -- a 2-3 sentence professional resume summary tailored to the job '
        "description, mirroring its key requirements and keywords naturally, but staying "
        "truthful to the candidate's given profile: don't invent experience or skills that "
        "aren't implied by it.\n"
        '"skills" -- a comma-separated list of 8-14 skills/technologies most relevant to this '
        "specific job description, prioritizing ones already implied by the candidate's given "
        "profile where truthful, filled out with the specific tools/technologies/methodologies "
        "this job description itself asks for.\n"
        "The text below may be the raw text of a whole job-posting webpage (nav links, footer, "
        "unrelated boilerplate and all) rather than just the description -- find and use the "
        "actual job posting content within it, ignore the rest.\n"
        "Return ONLY the JSON object -- no markdown code fences, no preamble, no extra text.\n\n"
        f"Candidate profile:\n{profile}\n\n"
        f"Job description:\n{jd_text[:6000]}"
    )
    raw = await _minimax_chat("You are a concise, expert resume writer.", prompt)
    log.info("generate-summary raw model reply: %r", raw[:600])

    # Best-effort JSON parse -- strip markdown fences the model sometimes wraps
    # the object in despite the instruction not to. If parsing still fails,
    # fall back to treating the raw reply as the summary (old behavior) rather
    # than erroring the whole request over a formatting slip.
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip())
    try:
        parsed = json.loads(cleaned)
        title = str(parsed.get("title") or "").strip()
        summary = str(parsed.get("summary") or "").strip()
        skills = str(parsed.get("skills") or "").strip()
    except (json.JSONDecodeError, AttributeError):
        title, summary, skills = "", raw.strip(), ""

    return {
        "title": title, "summary": summary, "skills": skills,
        "_debug_jd_len": len(jd_text), "_debug_jd_preview": jd_text[:3000], "_debug_raw": raw[:500],
    }


class ParseResumeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=20000, description="raw resume text extracted client-side from an uploaded PDF/DOCX/txt")


@app.post("/api/parse-resume")
async def parse_resume(req: ParseResumeRequest) -> dict:
    """Turns raw, messily-extracted resume text into the resume builder's own
    field shape, so an upload can fill Experience/Education/Skills instead of
    just dumping text into Summary for the person to re-sort by hand."""
    prompt = (
        "Extract structured resume data from the raw text below (pulled from an uploaded "
        "PDF/DOCX/txt, so spacing and line breaks may be imperfect). Return ONLY a JSON "
        "object -- no markdown fences, no preamble -- with exactly these fields:\n"
        '"name": full name (string, "" if not found)\n'
        '"headline": target role/job title if stated near the top, else "" (string)\n'
        '"email": (string, "" if not found)\n'
        '"phone": (string, "" if not found)\n'
        '"location": city/region if given, else "" (string)\n'
        '"link": LinkedIn/GitHub/portfolio URL if present, else "" (string)\n'
        '"summary": the professional summary/objective if present (verbatim, light cleanup '
        "ok), else \"\" -- don't write a new one if the resume doesn't have one\n"
        '"skillGroups": array of {"label": category name, or "" if the resume lists skills '
        'without categories, "items": [skill strings]} -- preserve the resume\'s own category '
        'groupings (e.g. "Cloud Platforms", "Programming Languages") if it has any, otherwise '
        "a single group with label \"\" containing all the skills\n"
        '"experience": array of {"title","company","location","start","end","bullets":[...]}, '
        'most recent first; "end" is "Present" if it\'s the current role\n'
        '"education": array of {"degree","school","location","start","end"}\n\n'
        "Only use information actually present in the text -- never invent employers, dates, "
        "or skills that aren't stated. Leave a field \"\" or [] if it isn't in the text.\n\n"
        f"Resume text:\n{req.text.strip()[:12000]}"
    )
    raw = await _minimax_chat(
        "You are a precise resume-parsing engine. You extract structured data verbatim from "
        "the given text; you never invent facts.",
        prompt,
        timeout=45,
    )

    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip())
    try:
        parsed = json.loads(cleaned)
        if not isinstance(parsed, dict):
            raise ValueError("not a JSON object")
    except (json.JSONDecodeError, ValueError):
        log.error("parse-resume: model did not return a JSON object: %s", raw[:500])
        raise HTTPException(status_code=502, detail="Couldn't parse that resume -- try again, or fill the form manually.")

    def _s(v) -> str:
        return str(v).strip() if v is not None else ""

    def _list(v) -> list:
        return v if isinstance(v, list) else []

    skill_groups = []
    for g in _list(parsed.get("skillGroups")):
        if not isinstance(g, dict):
            continue
        items = [_s(i) for i in _list(g.get("items")) if _s(i)]
        if items:
            skill_groups.append({"label": _s(g.get("label")), "items": items})

    experience = []
    for e in _list(parsed.get("experience")):
        if not isinstance(e, dict):
            continue
        experience.append({
            "title": _s(e.get("title")), "company": _s(e.get("company")),
            "location": _s(e.get("location")), "start": _s(e.get("start")), "end": _s(e.get("end")),
            "bullets": [_s(b) for b in _list(e.get("bullets")) if _s(b)],
        })

    education = []
    for e in _list(parsed.get("education")):
        if not isinstance(e, dict):
            continue
        education.append({
            "degree": _s(e.get("degree")), "school": _s(e.get("school")),
            "location": _s(e.get("location")), "start": _s(e.get("start")), "end": _s(e.get("end")),
        })

    return {
        "name": _s(parsed.get("name")),
        "headline": _s(parsed.get("headline")),
        "email": _s(parsed.get("email")),
        "phone": _s(parsed.get("phone")),
        "location": _s(parsed.get("location")),
        "link": _s(parsed.get("link")),
        "summary": _s(parsed.get("summary")),
        "skillGroups": skill_groups,
        "experience": experience,
        "education": education,
    }


class RefineSearchRequest(BaseModel):
    search_term: str = Field(..., min_length=1, max_length=200)
    location: str = Field("", max_length=200)


@app.post("/api/refine-search-term")
async def refine_search_term(req: RefineSearchRequest) -> dict:
    """Job boards (Indeed/LinkedIn/etc, via jobspy) match on the raw keyword
    string as-is -- a vague or colloquial query like "offshore" returns
    whatever loosely matches, not what the person actually meant. This asks
    the model to rewrite it into the specific job title/keyword phrase a
    recruiter would actually post under, so the underlying keyword search
    itself is more targeted. Best-effort: on any failure, callers should just
    fall back to the original term rather than blocking the search."""
    prompt = (
        "Rewrite the job search query below into the single most effective search phrase "
        "for job boards like Indeed and LinkedIn -- the specific job title or keyword phrase "
        "a recruiter would actually use in a posting, so the search returns relevant results "
        "instead of loosely-matched noise. Job seekers often type a single vague or ambiguous "
        "word instead of an actual title (e.g. \"offshore\", \"growth\", \"support\") -- for "
        "those, commit to the single most common interpretation among job seekers generally "
        "(e.g. \"offshore\" -> \"Offshore Engineer\", \"growth\" -> \"Growth Marketing Manager\", "
        "\"support\" -> \"Customer Support Representative\") rather than leaving it unchanged; "
        "an unchanged vague word performs far worse on these sites than a committed best guess. "
        "Expand obvious abbreviations too (\"swe\" -> \"Software Engineer\", \"pm\" -> \"Product "
        "Manager\"). If it's already a clear, specific job title or keyword phrase, return it "
        "unchanged. Return ONLY the rewritten phrase, no explanation, no quotes, no punctuation "
        "around it.\n\n"
        f"Query: {req.search_term.strip()}\n"
        f"Location (if given): {req.location.strip() or 'not specified'}"
    )
    refined = await _minimax_chat(
        "You are an expert technical recruiter who knows how job titles and keywords are "
        "actually phrased across industries.",
        prompt,
        timeout=12,
    )
    refined = refined.strip().strip('"')
    return {
        "refined": refined or req.search_term,
        "changed": bool(refined) and refined.lower() != req.search_term.strip().lower(),
    }


@app.post("/api/scrape")
async def scrape(req: ScrapeRequest) -> dict:
    import time as _time
    t0 = _time.time()
    try:
        result = await scraper.scrape(
            search_term=req.search_term,
            location=req.location,
            sites=req.sites,
            hours_old=req.hours_old,
            results_wanted=req.results_wanted,
            timeout_seconds=req.timeout_seconds,
            country_indeed=req.country_indeed,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # log + send to telegram (best-effort, does not block the response)
    try:
        elapsed = round(_time.time() - t0, 2)
        await admin.log_search(admin.LogSearch(
            search_term=req.search_term,
            location=req.location or "",
            sites=result.get("sites") or [],
            hours_old=result.get("hours_old") or 168,
            results_wanted=result.get("results_wanted") or 50,
            job_count=result.get("count", 0),
            ok=result.get("ok", False),
            duration_seconds=elapsed,
            jobs=[admin.LogJob(**j) for j in result.get("jobs", [])],
        ))
    except Exception:
        log.exception("admin log_search failed (non-fatal)")

    return result


@app.post("/api/scrape-stream")
async def scrape_stream(req: ScrapeRequest):
    """Same inputs as /api/scrape, but responds with newline-delimited JSON: one
    line per site as soon as that site finishes, then a final {"done": true, ...}
    line. Lets the frontend show results incrementally instead of waiting for the
    slowest site (LinkedIn/Glassdoor can take 30-60s+ while Indeed is often done
    in a few seconds)."""
    async def body():
        try:
            async for chunk in scraper.scrape_streaming(
                search_term=req.search_term,
                location=req.location,
                sites=req.sites,
                hours_old=req.hours_old,
                results_wanted=req.results_wanted,
                timeout_seconds=req.timeout_seconds,
                country_indeed=req.country_indeed,
            ):
                yield json.dumps(chunk) + "\n"
        except ValueError as e:
            yield json.dumps({"done": True, "error": str(e), "count": 0}) + "\n"

    return StreamingResponse(body(), media_type="application/x-ndjson")


# serve the dashboard from app/static/
STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def root() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
