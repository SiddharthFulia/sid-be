"""ComfyUI HTTP client — queues a workflow, polls until done, returns MP4 bytes."""
from __future__ import annotations

import asyncio
import os
import random
from typing import Any

import httpx

COMFYUI_URL = os.getenv("COMFYUI_URL", "http://127.0.0.1:8000").rstrip("/")
POLL_INTERVAL = 2.5
POLL_TIMEOUT = 8 * 60  # seconds


def _ltx_video_workflow(prompt: str, aspect: str, duration: int, steps: int, cfg: float) -> dict[str, Any]:
    width, height = (480, 832) if aspect == "9:16" else (832, 480) if aspect == "16:9" else (640, 640)
    frames = max(25, min(duration * 25, 257))
    seed = random.randint(1, 1_000_000_000)
    return {
        "3": {"class_type": "CheckpointLoaderSimple",
              "inputs": {"ckpt_name": "ltx-video-2b-v0.9.safetensors"}},
        "4": {"class_type": "ModelSamplingLTXV",
              "inputs": {"model": ["3", 0], "max_shift": 2.05, "base_shift": 0.95}},
        "6": {"class_type": "CLIPTextEncode",
              "inputs": {"text": prompt, "clip": ["3", 1]}},
        "7": {"class_type": "CLIPTextEncode",
              "inputs": {"text": "low quality, blurry, distorted, watermark", "clip": ["3", 1]}},
        "8": {"class_type": "EmptyLTXVLatentVideo",
              "inputs": {"width": width, "height": height, "length": frames, "batch_size": 1}},
        "12": {"class_type": "LTXVConditioning",
               "inputs": {"positive": ["6", 0], "negative": ["7", 0], "frame_rate": 25}},
        "9": {"class_type": "KSampler",
              "inputs": {"seed": seed, "steps": steps, "cfg": cfg,
                         "sampler_name": "euler", "scheduler": "normal", "denoise": 1,
                         "model": ["4", 0],
                         "positive": ["12", 0], "negative": ["12", 1],
                         "latent_image": ["8", 0]}},
        "10": {"class_type": "VAEDecode",
               "inputs": {"samples": ["9", 0], "vae": ["3", 2]}},
        "11": {"class_type": "VHS_VideoCombine",
               "inputs": {"images": ["10", 0], "frame_rate": 25,
                          "filename_prefix": "ai_video", "format": "video/h264-mp4",
                          "pix_fmt": "yuv420p", "crf": 19,
                          "loop_count": 0, "pingpong": False, "save_output": True}},
    }


def build_workflow(model: str, prompt: str, aspect: str, duration: int, steps: int, cfg: float) -> dict[str, Any]:
    # Currently only LTX-Video has a built-in workflow template.
    # Drop additional templates here keyed by model id.
    return _ltx_video_workflow(prompt, aspect, duration, steps, cfg)


async def _queue_prompt(client: httpx.AsyncClient, workflow: dict[str, Any]) -> str:
    r = await client.post(f"{COMFYUI_URL}/prompt", json={"prompt": workflow}, timeout=30)
    if r.status_code >= 400:
        raise RuntimeError(f"ComfyUI rejected workflow ({r.status_code}): {r.text[:1000]}")
    data = r.json()
    if "prompt_id" not in data:
        raise RuntimeError(f"ComfyUI did not return prompt_id: {data}")
    return data["prompt_id"]


async def _poll_history(client: httpx.AsyncClient, prompt_id: str) -> dict[str, Any]:
    deadline = asyncio.get_event_loop().time() + POLL_TIMEOUT
    while asyncio.get_event_loop().time() < deadline:
        r = await client.get(f"{COMFYUI_URL}/history/{prompt_id}", timeout=10)
        if r.status_code == 200:
            hist = r.json()
            entry = hist.get(prompt_id)
            if entry and entry.get("status", {}).get("completed"):
                return entry
            if entry and entry.get("status", {}).get("status_str") == "error":
                raise RuntimeError("ComfyUI workflow errored")
        await asyncio.sleep(POLL_INTERVAL)
    raise TimeoutError("ComfyUI generation timed out")


def _find_video_file(entry: dict[str, Any]) -> dict[str, str] | None:
    outputs = entry.get("outputs", {}) or {}
    for node in outputs.values():
        for key in ("gifs", "videos", "images"):
            for f in node.get(key, []) or []:
                if str(f.get("filename", "")).lower().endswith((".mp4", ".webm", ".mov")):
                    return f
    return None


async def _download(client: httpx.AsyncClient, file: dict[str, str]) -> bytes:
    params = {
        "filename": file["filename"],
        "subfolder": file.get("subfolder", ""),
        "type": file.get("type", "output"),
    }
    r = await client.get(f"{COMFYUI_URL}/view", params=params, timeout=120)
    r.raise_for_status()
    return r.content


async def health() -> bool:
    try:
        async with httpx.AsyncClient() as c:
            r = await c.get(f"{COMFYUI_URL}/system_stats", timeout=4)
            return r.status_code == 200
    except Exception:
        return False


async def generate(prompt: str, model: str = "ltx-video", aspect: str = "9:16",
                   duration: int = 5, steps: int = 30, cfg: float = 3.0) -> bytes:
    workflow = build_workflow(model, prompt, aspect, duration, steps, cfg)
    async with httpx.AsyncClient() as client:
        prompt_id = await _queue_prompt(client, workflow)
        entry = await _poll_history(client, prompt_id)
        file = _find_video_file(entry)
        if not file:
            raise RuntimeError("ComfyUI completed but no video file in outputs")
        return await _download(client, file)
