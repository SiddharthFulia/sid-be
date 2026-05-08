"""GPU worker — polls Oracle BE for queued jobs, generates via ComfyUI, uploads to Cloudinary.

Runs on Lightning AI / Kaggle / Colab / RunPod / any GPU box.
Outbound HTTP only — no inbound tunnel needed.
"""
from __future__ import annotations

import asyncio
import os
import socket
import threading
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


def report_progress(client: httpx.Client, job_id: str, **fields: Any) -> None:
    """Push estimated_seconds / progressMessage / step / totalSteps / logLine to BE."""
    if not fields:
        return
    try:
        client.post(
            f"{MAIN_BACKEND_URL}/api/gpu-worker/job-progress",
            headers=_headers(),
            json={"jobId": job_id, **fields},
            timeout=8,
        )
    except Exception:
        pass   # progress is best-effort; never fail a job over this


def report_log(client: httpx.Client, job_id: str, line: str) -> None:
    """Append a log line to the inflight job's `logs` array. Mirrors print() to
    the worker terminal, but the BE persists the line so the FE shows a live feed.
    Fire-and-forget on a background thread so we never block sampling."""
    print(f"[log] {line}")
    threading.Thread(
        target=lambda: report_progress(client, job_id, logLine=line),
        daemon=True,
    ).start()


# Per-model rough seconds-per-step on the 5090 at 720p (calibrated from real runs).
# 1080p gets ~1.8x. Overhead covers model load + VAE decode + Cloudinary upload.
_SECONDS_PER_STEP = {
    "ltx-video":   1.7,
    "wan-2.1":     2.6,
    "wan-2.1-i2v": 18.0,   # 14B is much heavier
    "wan-2.2":     12.0,   # 5B
    "hunyuan":     64.0,   # the 26GB beast
    "mochi":       15.0,
    "svd":         2.0,
}


def estimate_seconds(model: str, steps: int, resolution: str) -> int:
    base = _SECONDS_PER_STEP.get(model, 3.0)
    res_mult = 1.8 if (resolution or "").lower() == "1080p" else 1.0
    sampler = base * max(steps, 1) * res_mult
    overhead = 25   # model load + VAE decode + Cloudinary upload
    return int(sampler + overhead)


def process_job(client: httpx.Client, job: dict[str, Any]) -> None:
    job_id = job["jobId"]
    prompt = job.get("prompt", "")
    model = job.get("model") or "ltx-video"
    aspect = job.get("aspectRatio") or "9:16"
    duration = job.get("duration")
    resolution = job.get("resolution") or "720p"
    steps = int(job.get("steps") or 30)
    image_url = (job.get("imageUrl") or "").strip()
    print(f"\n[process] {job_id}")
    print(f"  model={model} | aspect={aspect} | duration={duration}s | res={resolution} | steps={steps}")
    print(f"  prompt={prompt[:80]!r}")
    if image_url:
        print(f"  image_url={image_url[:80]}")
    started = time.monotonic()

    # Stream-to-FE log feed: every milestone emits a line that lands in the
    # inflight job's `logs` array. The FE renders these so the user sees the
    # same activity the worker terminal shows.
    report_log(client, job_id, f"picked up by worker {WORKER_ID}")
    report_log(client, job_id, f"model={model} • aspect={aspect} • {duration}s • {resolution} • {steps} steps")
    if image_url:
        report_log(client, job_id, f"i2v source: {image_url[:80]}")

    if not cloudinary_upload.is_configured():
        report_failed(client, job_id, "Cloudinary not configured on worker", requeue=False)
        return

    try:
        comfy_ok = asyncio.run(comfyui_client.health())
    except Exception as e:
        report_log(client, job_id, f"✗ ComfyUI health check failed: {e}")
        report_failed(client, job_id, f"ComfyUI health check failed: {e}")
        return
    if not comfy_ok:
        report_failed(client, job_id, f"ComfyUI not reachable at {comfyui_client.COMFYUI_URL}")
        return

    style = job.get("style") or ""
    styled_prompt = f"{prompt}, {style}, high detail" if style else prompt
    duration = int(duration or 5)
    image_url = image_url or None

    # Estimate how long this job should take + tell BE so the FE can show ETA
    eta = estimate_seconds(model, steps, resolution)
    nice_name = {
        "ltx-video": "LTX-Video", "wan-2.1": "Wan 2.1", "wan-2.1-i2v": "Wan 2.1 I2V 14B",
        "wan-2.2": "Wan 2.2 5B", "hunyuan": "HunyuanVideo", "mochi": "Mochi 1", "svd": "SVD-XT",
    }.get(model, model)
    print(f"[eta] ~{eta}s estimated ({nice_name} • {steps} steps • {resolution})")
    report_progress(
        client, job_id,
        estimatedSeconds=eta,
        message=f"Rendering on the 5090 — {nice_name} • {steps} steps • {resolution}",
        totalSteps=steps,
    )
    report_log(client, job_id, f"⏱ ETA ~{eta}s ({nice_name})")
    if os.getenv("ENABLE_TEACACHE", "0").strip().lower() in ("1", "true", "yes"):
        # TeaCache supports Hunyuan + Wan 2.1, but NOT Wan 2.2 5B and not LTX (in
        # this version of the welltop-cn fork). Surface only when we actually splice.
        if model in ("hunyuan", "hunyuan-video", "hunyuan-i2v",
                     "wan-2.1", "wan-2.1-i2v"):
            report_log(client, job_id, "⚡ TeaCache acceleration: ON")
    if os.getenv("SAGE_ATTENTION", "0").strip().lower() in ("1", "true", "yes"):
        report_log(client, job_id, "⚡ SageAttention: ON")

    # ── Live progress via ComfyUI websocket ──────────────────────────────
    # ComfyUI emits {"type": "progress", "value": N, "max": M} per sampler step.
    # We throttle to ~2s and use an EMA over sec/step so the ETA the FE shows
    # stops being a constant prediction and starts being a live readout.
    _prog_state = {
        "last_post": 0.0,
        "ema_sps": None,        # exponential moving average of seconds-per-step
    }

    # Track which step indices we've already logged (every 25% mark) so we don't
    # spam the BE with 30 separate log lines on a 30-step run.
    _logged_marks: set[int] = set()

    def progress_cb(step: int, total: int, sec_per_step: float) -> None:
        now = time.monotonic()
        # EMA smoothing — fast steps still reach the user without bouncing the bar
        prev = _prog_state["ema_sps"]
        _prog_state["ema_sps"] = sec_per_step if prev is None else (0.6 * prev + 0.4 * sec_per_step)
        # Throttle BE posts to once per ~1.5s so we don't spam Oracle
        if now - _prog_state["last_post"] < 1.5 and step != total:
            return
        _prog_state["last_post"] = now
        sps = _prog_state["ema_sps"] or sec_per_step or 0.0
        remaining_steps = max(0, total - step)
        remaining_sec = remaining_steps * sps
        live_eta = int(((step * sps) if sps > 0 else 0) + remaining_sec + 8)
        msg = (f"Rendering on the 5090 — {nice_name} • step {step}/{total}"
               f" • {sps:.2f}s per step")
        # Fire-and-forget on a background thread so we never block the asyncio loop
        threading.Thread(
            target=lambda: report_progress(
                client, job_id,
                estimatedSeconds=live_eta,
                step=step, totalSteps=total,
                message=msg,
            ),
            daemon=True,
        ).start()
        # Log a discrete line at start, 25%, 50%, 75%, and end — gives the user
        # the same "30/30 [00:50<00:00, 1.68s/it]" granularity ComfyUI prints.
        marks = {1, max(1, total // 4), max(1, total // 2), max(1, (3 * total) // 4), total}
        if step in marks and step not in _logged_marks:
            _logged_marks.add(step)
            pct = int(round(100 * step / max(total, 1)))
            report_log(
                client, job_id,
                f"sampler {step}/{total} ({pct}%) • {sps:.2f}s/it • ~{int(remaining_sec)}s left",
            )

    report_log(client, job_id, "→ submitting workflow to ComfyUI")
    try:
        mp4_bytes = asyncio.run(comfyui_client.generate(
            prompt=styled_prompt,
            model=model,
            aspect=aspect,
            duration=duration,
            steps=steps,
            cfg=3.0,
            resolution=resolution,
            image_url=image_url,
            progress_cb=progress_cb,
        ))
    except TimeoutError as e:
        report_log(client, job_id, f"✗ ComfyUI timed out: {e}")
        report_failed(client, job_id, f"ComfyUI timed out: {e}")
        return
    except Exception as e:
        traceback.print_exc()
        report_log(client, job_id, f"✗ ComfyUI error: {str(e)[:180]}")
        report_failed(client, job_id, f"ComfyUI failed: {e}")
        return
    report_log(client, job_id, f"✓ generation done ({len(mp4_bytes) / (1024*1024):.1f} MB mp4)")

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

    report_log(client, job_id, "↑ uploading to Cloudinary")
    try:
        upload = cloudinary_upload.upload_video(mp4_bytes, public_id, context=context, tags=tags)
    except Exception as e:
        traceback.print_exc()
        report_log(client, job_id, f"✗ Cloudinary upload failed: {str(e)[:180]}")
        report_failed(client, job_id, f"Cloudinary upload failed: {e}", requeue=False)
        return

    elapsed = round(time.monotonic() - started, 1)
    print(f"[done] {job_id} → {upload['videoUrl']} ({elapsed}s)")
    report_log(client, job_id, f"✓ published in {elapsed}s")
    report_log(client, job_id, f"🎬 {upload['videoUrl']}")
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
