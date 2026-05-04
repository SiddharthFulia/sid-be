"""Upload an MP4 buffer to Cloudinary and return the public secure URL."""
from __future__ import annotations

import io
import os
from typing import Any

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


def upload_video(buffer: bytes, public_id: str) -> dict[str, Any]:
    configure()
    res = cloudinary.uploader.upload_large(
        io.BytesIO(buffer),
        resource_type="video",
        public_id=public_id,
        folder=FOLDER,
        chunk_size=6_000_000,
    )
    return {
        "videoUrl": res.get("secure_url"),
        "publicId": res.get("public_id"),
        "durationSec": res.get("duration"),
        "bytes": res.get("bytes"),
        "format": res.get("format"),
    }
