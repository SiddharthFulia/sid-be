"""Upload an MP4 buffer to Cloudinary with optional context tags + return secure_url."""
from __future__ import annotations

import io
import os
from typing import Any, Optional

import cloudinary
import cloudinary.uploader

CLOUD_NAME = os.getenv("CLOUDINARY_CLOUD_NAME", "")
API_KEY = os.getenv("CLOUDINARY_API_KEY", "")
API_SECRET = os.getenv("CLOUDINARY_API_SECRET", "")
FOLDER = os.getenv("CLOUDINARY_FOLDER", "ai-videos")


def is_configured() -> bool:
    return bool(CLOUD_NAME and API_KEY and API_SECRET)


def configure() -> None:
    if not is_configured():
        raise RuntimeError("Cloudinary credentials missing — set CLOUDINARY_CLOUD_NAME, _API_KEY, _API_SECRET")
    cloudinary.config(
        cloud_name=CLOUD_NAME,
        api_key=API_KEY,
        api_secret=API_SECRET,
        secure=True,
    )


def _escape_ctx(v: Any) -> str:
    if v is None:
        return ""
    return str(v).replace("|", " ").replace("=", ":").replace("\n", " ")[:950]


def _build_context(meta: Optional[dict]) -> str:
    if not meta:
        return ""
    pairs = []
    for k, v in meta.items():
        if v is None or v == "":
            continue
        pairs.append(f"{k}={_escape_ctx(v)}")
    return "|".join(pairs)


def upload_video(buffer: bytes, public_id: str,
                 context: Optional[dict] = None,
                 tags: Optional[list] = None) -> dict[str, Any]:
    """Upload an MP4 buffer. `context` is a dict of metadata keys (prompt, provider, etc.)
    that gets stored on the Cloudinary resource and returned by the list endpoint."""
    configure()
    kwargs: dict[str, Any] = {
        "resource_type": "video",
        "public_id": public_id,
        "folder": FOLDER,
        "chunk_size": 6_000_000,
    }
    ctx_str = _build_context(context)
    if ctx_str:
        kwargs["context"] = ctx_str
    if tags:
        kwargs["tags"] = [t for t in tags if t]

    res = cloudinary.uploader.upload_large(io.BytesIO(buffer), **kwargs)
    return {
        "videoUrl": res.get("secure_url"),
        "publicId": res.get("public_id"),
        "durationSec": res.get("duration"),
        "bytes": res.get("bytes"),
        "format": res.get("format"),
    }
