"""rich-paste backend routes, mounted at /api/plugins/rich-paste/.

The desktop half sends every limit and the cache directory with each call;
this module reads no config. Limits are clamped by ``rp_cache`` (review F2), and
a client's cache directory is used only when it lies under the user's home
directory (``rp_cache.client_cache_dir``, review F5); otherwise the default
directory is used and the response carries a short ``warning``. The logic lives
in ``rp_cache.py`` beside the package root so it can be tested without FastAPI.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request

logger = logging.getLogger(__name__)


def _load_rp_cache():
    name = "rich_paste_rp_cache"
    if name in sys.modules:
        return sys.modules[name]
    path = Path(__file__).resolve().parent.parent / "rp_cache.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


rp_cache = _load_rp_cache()
router = APIRouter()

# Bumped whenever a route or the middleware changes. The desktop half compares it with its own
# BACKEND_API to tell "the gateway still runs an older backend" apart from other failures.
API_VERSION = 12


@router.get("/version")
async def version():
    return {"api": API_VERSION}


# One data: URL at its cap (rp_cache.MAX_DATA_URL_BYTES decoded, about 27 MB in base64) fits; the desktop
# half sends one URL per request (review F2).
MAX_FETCH_BODY_BYTES = 32 * 1024 * 1024


def _as_dict(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _in_client_cache(fn, *args, cache_dir: Any, **kwargs) -> tuple[Any, str | None]:
    """``fn(..., cache_dir=<accepted dir or None>)`` and the warning when the client's dir was ignored."""
    chosen, warning = rp_cache.client_cache_dir(cache_dir)
    if warning:
        logger.info("rich-paste: %s", warning)
    return fn(*args, cache_dir=chosen, **kwargs), warning


def _warned(result: dict, warning: str | None) -> dict:
    return {**result, "warning": warning} if warning else result


async def _json_body(request: Request, limit: int) -> dict:
    """The request's JSON object, read at most ``limit`` bytes far: 413 past it, 400 when it is not a JSON object."""
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > limit:
        raise HTTPException(status_code=413, detail=f"request body over {limit} bytes")
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise HTTPException(status_code=413, detail=f"request body over {limit} bytes")
        chunks.append(chunk)
    try:
        body = json.loads(b"".join(chunks) or b"null")
    except (ValueError, RecursionError) as exc:  # deep nesting is a bad body, not a 500
        raise HTTPException(status_code=400, detail="body must be JSON") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")
    return body


@router.post("/fetch-images")
async def fetch_images(request: Request):
    body = await _json_body(request, MAX_FETCH_BODY_BYTES)
    urls = body.get("urls")
    if not isinstance(urls, list):
        raise HTTPException(status_code=400, detail="urls must be a list")
    limits = _as_dict(body.get("limits"))
    cleanup = _as_dict(body.get("cleanup"))
    try:
        results, warning = await asyncio.to_thread(
            _in_client_cache,
            rp_cache.fetch_images,
            urls,
            max_images=limits.get("max_images"),
            max_mb=limits.get("max_mb"),
            cache_dir=body.get("cache_dir"),
            auto_delete=cleanup.get("auto_delete", True) is not False,
            days=cleanup.get("days"),  # rp_cache falls back to DEFAULT_KEEP_DAYS
            referer=body.get("pageUrl") or None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    failed = sum(1 for r in results if not r["path"])
    logger.info("rich-paste fetched %d/%d images", len(results) - failed, len(results))
    return _warned({"results": results}, warning)


@router.get("/cache-stats")
async def cache_stats(cache_dir: str = ""):
    try:
        return _warned(*await asyncio.to_thread(_in_client_cache, rp_cache.cache_stats, cache_dir=cache_dir))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/cleanup")
async def cleanup(body: dict):
    try:
        removed, warning = await asyncio.to_thread(_in_client_cache, rp_cache.cleanup, cache_dir=body.get("cache_dir"),
                                                   days=body.get("days"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _warned({"removed": removed}, warning)


@router.get("/clipboard-files")
async def clipboard_files():
    """File/folder paths on the macOS pasteboard (dogfood D5); the desktop half asks only
    while handling a paste whose files carry no path, and keeps only names from that paste."""
    return await asyncio.to_thread(rp_cache.clipboard_file_paths)


@router.post("/to-png")
async def to_png(body: dict):
    """Send-time PNG for a TIFF/HEIC/BMP/AVIF image attachment (dogfood D6)."""
    path = body.get("path")
    if not isinstance(path, str):
        raise HTTPException(status_code=400, detail="path must be a string")
    try:
        result, warning = await asyncio.to_thread(_in_client_cache, rp_cache.to_png, path, cache_dir=body.get("cache_dir"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    logger.info("rich-paste to-png %s -> %s", Path(path).suffix, result["error"] or "png")
    return _warned(result, warning)


@router.post("/save-preview")
async def save_preview(body: dict):
    """Preview copy of a pasted image for the «截图 N» chip (dogfood D9)."""
    try:
        return _warned(*await asyncio.to_thread(_in_client_cache, rp_cache.save_preview, body.get("data_url"),
                                                cache_dir=body.get("cache_dir")))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/file-digests")
async def file_digests(body: dict):
    """Digests of image attachment files: binds each «截图 N» chip to its own image at send (11-07)."""
    try:
        return {"digests": await asyncio.to_thread(rp_cache.file_digests, body.get("paths"))}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/paste-files")
async def paste_files(body: dict):
    """Length and opening of Desktop's long-paste .txt files: which one a converted paste replaces (11-07)."""
    try:
        return {"files": await asyncio.to_thread(rp_cache.paste_files, body.get("paths"))}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/save-markdown")
async def save_markdown(body: dict):
    """Keep a converted long paste on disk so a plugin reload does not lose it (11-07)."""
    try:
        return _warned(*await asyncio.to_thread(_in_client_cache, rp_cache.save_markdown, body.get("markdown"),
                                                cache_dir=body.get("cache_dir")))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/read-markdown")
async def read_markdown(body: dict):
    """Read back a long paste written by /save-markdown (only those files)."""
    return await asyncio.to_thread(rp_cache.read_markdown, body.get("path"))


@router.get("/stt-status")
async def stt_status(model: str | None = None):
    """What a transcription will do (download a model / upload to a cloud provider), dogfood D10.
    ``model``: the local model picked in the plugin settings (11-08)."""
    return await asyncio.to_thread(rp_cache.stt_status, model)


@router.post("/transcribe")
async def transcribe(body: dict):
    """Transcribe one pasted audio file with Hermes' own STT (dogfood D10)."""
    path = body.get("path")
    if not isinstance(path, str):
        raise HTTPException(status_code=400, detail="path must be a string")
    try:
        result = await asyncio.to_thread(rp_cache.transcribe, path, body.get("model"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    logger.info("rich-paste transcribe %s -> %s", Path(path).suffix, result["error"] or f"ok via {result['provider']}")
    return result
