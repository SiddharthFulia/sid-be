"""GPU worker — polls Oracle BE for queued jobs, generates via ComfyUI, uploads to Cloudinary.

Runs on Lightning AI / Kaggle / Colab / RunPod / any GPU box.
Outbound HTTP only — no inbound tunnel needed.
"""
from __future__ import annotations

import asyncio
import os
import socket
import time
import traceback
from typing import Any

import httpx
from dotenv import load_dotenv

load_dotenv()

import cloudinary_upload
import comfyui_client

MAIN_BACKEND_URL = os.getenv("MAIN_BACKEND_URL", "https://api.siddharthfulia.com").rstrip("/")
WORKER_TOKEN = os.getenv("WORKER_TOKEN", "").strip()
WORKER_ROLE = os.getenv("WORKER_ROLE", "worker").strip().lower()  # 'worker' = Lightning, 'local' = personal PC
WORKER_ID = os.getenv("WORKER_ID", "").strip() or f"{WORKER_ROLE}-{socket.gethostname()}"
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", "10"))


def _headers() -> dict:
    h = {
        "Content-Type": "application/json",
        "X-Worker-Id": WORKER_ID,
        "X-Worker-Role": WORKER_ROLE,
    }
    if WORKER_TOKEN:
        h["Authorization"] = f"Bearer {WORKER_TOKEN}"
    return h


def register(client: httpx.Client) -> bool:
    try:
        r = client.post(
            f"{MAIN_BACKEND_URL}/api/gpu-worker/register",
            headers=_headers(),
            json={"workerId": WORKER_ID, "role": WORKER_ROLE, "token": WORKER_TOKEN},
            timeout=10,
        )
        if r.status_code == 200:
            return True
        print(f"[register] {r.status_code}: {r.text[:200]}")
    except Exception as e:
        print(f"[register] error: {e}")
    return False


def get_next_job(client: httpx.Client) -> dict[str, Any] | None:
    try:
        r = client.get(
            f"{MAIN_BACKEND_URL}/api/gpu-worker/next-job",
            headers=_headers(),
            params={"workerId": WORKER_ID, "role": WORKER_ROLE},
            timeout=15,
        )
        if r.status_code != 200:
            print(f"[next-job] {r.status_code}: {r.text[:200]}")
            return None
        body = r.json()
        return body.get("data")
    except Exception as e:
        print(f"[next-job] error: {e}")
        return None


def report_complete(client: httpx.Client, job_id: str, video_url: str, caption: str | None = None) -> None:
    try:
        r = client.post(
            f"{MAIN_BACKEND_URL}/api/gpu-worker/job-complete",
            headers=_headers(),
            json={"jobId": job_id, "videoUrl": video_url, "caption": caption},
            timeout=20,
        )
        print(f"[complete] {job_id}: {r.status_code}")
    except Exception as e:
        print(f"[complete] error: {e}")


def report_failed(client: httpx.Client, job_id: str, err_msg: str, requeue: bool = True) -> None:
    try:
        r = client.post(
            f"{MAIN_BACKEND_URL}/api/gpu-worker/job-failed",
            headers=_headers(),
            json={"jobId": job_id, "error": err_msg, "requeue": requeue},
            timeout=20,
        )
        print(f"[failed] {job_id}: {r.status_code}")
    except Exception as e:
        print(f"[failed] error: {e}")


def process_job(client: httpx.Client, job: dict[str, Any]) -> None:
    job_id = job["jobId"]
    prompt = job.get("prompt", "")
    print(f"\n[process] {job_id} | {prompt[:60]}")
    started = time.monotonic()

    if not cloudinary_upload.is_configured():
        report_failed(client, job_id, "Cloudinary not configured on worker", requeue=False)
        return

    try:
        comfy_ok = asyncio.run(comfyui_client.health())
    except Exception as e:
        report_failed(client, job_id, f"ComfyUI health check failed: {e}")
        return
    if not comfy_ok:
        report_failed(client, job_id, f"ComfyUI not reachable at {comfyui_client.COMFYUI_URL}")
        return

    style = job.get("style") or ""
    styled_prompt = f"{prompt}, {style}, high detail" if style else prompt
    duration = int(job.get("duration") or 5)
    aspect = job.get("aspectRatio") or "9:16"

    try:
        mp4_bytes = asyncio.run(comfyui_client.generate(
            prompt=styled_prompt,
            aspect=aspect,
            duration=duration,
            steps=30,
            cfg=3.0,
        ))
    except TimeoutError as e:
        report_failed(client, job_id, f"ComfyUI timed out: {e}")
        return
    except Exception as e:
        traceback.print_exc()
        report_failed(client, job_id, f"ComfyUI failed: {e}")
        return

    # The BE supplies context + tags so the list endpoint can read metadata back.
    public_id = job.get("public_id") or job_id
    context = job.get("context") or {
        "prompt": prompt,
        "provider": "worker",
        "duration": str(duration),
        "aspectRatio": aspect,
        "style": style,
    }
    tags = job.get("tags") or ["worker", aspect]

    try:
        upload = cloudinary_upload.upload_video(mp4_bytes, public_id, context=context, tags=tags)
    except Exception as e:
        traceback.print_exc()
        report_failed(client, job_id, f"Cloudinary upload failed: {e}", requeue=False)
        return

    elapsed = round(time.monotonic() - started, 1)
    print(f"[done] {job_id} → {upload['videoUrl']} ({elapsed}s)")
    report_complete(client, job_id, upload["videoUrl"])


def main() -> None:
    print(f"=== GPU worker booting ===")
    print(f"Backend:   {MAIN_BACKEND_URL}")
    print(f"WorkerId:  {WORKER_ID}")
    print(f"Role:      {WORKER_ROLE}")
    print(f"Poll:      every {POLL_INTERVAL}s")
    print(f"Auth:      {'on' if WORKER_TOKEN else 'OFF (no WORKER_TOKEN set)'}")

    with httpx.Client() as client:
        if register(client):
            print("[register] OK")
        else:
            print("[register] failed — will retry on next loop")

        consecutive_failures = 0

        while True:
            try:
                job = get_next_job(client)
                if job:
                    process_job(client, job)
                    consecutive_failures = 0
                    register(client)
                else:
                    register(client)
                    time.sleep(POLL_INTERVAL)
            except KeyboardInterrupt:
                print("\nShutting down (Ctrl+C)")
                return
            except Exception as e:
                consecutive_failures += 1
                wait = min(60, POLL_INTERVAL * (2 ** min(consecutive_failures, 3)))
                print(f"[loop] error: {e} — backing off {wait}s")
                time.sleep(wait)


if __name__ == "__main__":
    main()
