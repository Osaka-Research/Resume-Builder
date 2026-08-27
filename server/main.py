"""
main.py — fastapi app.

Routes:
  GET  /                  → dashboard (static HTML)
  GET  /api/health        → {ok, version, sites_supported}
  POST /api/scrape        → body: {search_term, location, sites, hours_old, results_wanted}
                          → returns normalized job list (see scraper.py)
"""
from __future__ import annotations

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
    jd: str = Field(..., min_length=1, max_length=8000, description="job description text")
    name: str = Field("", max_length=200)
    headline: str = Field("", max_length=200)
    skills: str = Field("", max_length=500, description="comma-separated skills")


@app.post("/api/generate-summary")
async def generate_summary(req: GenerateSummaryRequest) -> dict:
    profile_bits = []
    if req.headline:
        profile_bits.append(f"Target role: {req.headline}")
    if req.skills:
        profile_bits.append(f"Skills: {req.skills}")
    profile = "\n".join(profile_bits) or "No extra profile details given."

    prompt = (
        "Given the job description below, return a JSON object with two fields:\n"
        '"summary" -- a 2-3 sentence professional resume summary tailored to the job '
        "description, mirroring its key requirements and keywords naturally, but staying "
        "truthful to the candidate's given profile: don't invent experience or skills that "
        "aren't implied by it.\n"
        '"skills" -- a comma-separated list of 8-14 skills/technologies most relevant to this '
        "specific job description, prioritizing ones already implied by the candidate's given "
        "profile where truthful, filled out with the specific tools/technologies/methodologies "
        "this job description itself asks for.\n"
        "Return ONLY the JSON object -- no markdown code fences, no preamble, no extra text.\n\n"
        f"Candidate profile:\n{profile}\n\n"
        f"Job description:\n{req.jd.strip()[:6000]}"
    )
    raw = await _minimax_chat("You are a concise, expert resume writer.", prompt)

    # Best-effort JSON parse -- strip markdown fences the model sometimes wraps
    # the object in despite the instruction not to. If parsing still fails,
    # fall back to treating the raw reply as the summary (old behavior) rather
    # than erroring the whole request over a formatting slip.
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip())
    try:
        parsed = json.loads(cleaned)
        summary = str(parsed.get("summary") or "").strip()
        skills = str(parsed.get("skills") or "").strip()
    except (json.JSONDecodeError, AttributeError):
        summary, skills = raw.strip(), ""

    return {"summary": summary, "skills": skills}


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
