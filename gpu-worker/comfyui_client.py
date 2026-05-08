"""ComfyUI HTTP client — queues a workflow, polls until done, returns MP4 bytes.

Also subscribes to ComfyUI's WebSocket during a job to surface real-time
sampler progress (step / total / sec-per-step) via an optional callback.
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import time
import uuid
from typing import Any, Callable, Optional

import httpx

COMFYUI_URL = os.getenv("COMFYUI_URL", "http://127.0.0.1:8000").rstrip("/")
POLL_INTERVAL = 2.5
POLL_TIMEOUT = 8 * 60  # seconds

# Stable per-process client ID — ComfyUI uses this to route WS events back to us.
# Sent on every /prompt POST so the WS at /ws?clientId=... receives our job's progress.
_CLIENT_ID = str(uuid.uuid4())


# ── Cache acceleration injection ──────────────────────────────────────────
# When the user has installed ComfyUI-TeaCache (custom node by welltop-cn) and
# sets ENABLE_TEACACHE=1, we splice a TeaCache node between the model patcher
# and the KSampler. ~2× speedup on Wan/Hunyuan with mild quality loss.
# Workflows call _maybe_inject_teacache(graph, model_node_ref, model_type) and
# get back the new model ref — if TeaCache isn't enabled, returns the original.
TEACACHE_THRESHOLDS = {
    "ltxv":              0.10,
    "wan2.1_t2v_1.3B":   0.20,
    "wan2.1_i2v_480p_14B": 0.20,
    "wan2.2_ti2v_5B":    0.18,
    "hunyuan_video":     0.15,
}


def _teacache_enabled() -> bool:
    return os.getenv("ENABLE_TEACACHE", "").strip().lower() in ("1", "true", "yes")


def _maybe_inject_teacache(graph: dict[str, Any], model_ref: list, model_type: str,
                           steps: int) -> list:
    """Splice a TeaCache node before the KSampler if the user has it enabled."""
    if not _teacache_enabled():
        return model_ref
    threshold = TEACACHE_THRESHOLDS.get(model_type, 0.15)
    # Use a high node id we know isn't taken (workflows use 1-13 typically)
    tc_id = "200"
    graph[tc_id] = {
        "class_type": "TeaCache",
        "inputs": {
            "model": model_ref,
            "model_type": model_type,
            "rel_l1_thresh": threshold,
            "max_skip_steps": max(1, steps // 4),
        },
    }
    return [tc_id, 0]


def _ws_url() -> str:
    """Convert COMFYUI_URL (http://... or https://...) to ws://... or wss://..."""
    base = COMFYUI_URL
    if base.startswith("https://"):
        return f"wss://{base[len('https://'):]}/ws?clientId={_CLIENT_ID}"
    if base.startswith("http://"):
        return f"ws://{base[len('http://'):]}/ws?clientId={_CLIENT_ID}"
    return f"ws://{base}/ws?clientId={_CLIENT_ID}"


def _ltx_frames(duration: int) -> int:
    """LTX latent constraint: (frames - 1) must be divisible by 8.
    Round down to the nearest valid count so the user's duration isn't exceeded."""
    raw = max(9, min((duration or 5) * 25, 257))
    return ((raw - 1) // 8) * 8 + 1


def _ltx_distilled_workflow(prompt: str, image_filename: str | None, aspect: str, duration: int,
                            steps: int, resolution: str = "720p") -> dict[str, Any]:
    """LTX-Video DISTILLED (v0.9.6/0.9.7) — same node graph as regular LTX but uses a
    distilled checkpoint that converges in 8-12 steps with cfg≈1. Ultra-fast preview path.

    Requires `ltxv-2b-0.9.6-distilled-04-25.safetensors` in ComfyUI/models/checkpoints/.
    """
    res = (resolution or "720p").lower()
    if aspect == "9:16":
        width, height = (768, 1280) if res == "1080p" else (480, 832)
    elif aspect == "16:9":
        width, height = (1280, 768) if res == "1080p" else (832, 480)
    else:
        width, height = (768, 768) if res == "1080p" else (640, 640)
    # Hard-cap frames for preview speed; user duration only nudges within bounds.
    frames = _ltx_frames(min(duration or 2, 4))   # ≤ 97 frames worst case
    seed = random.randint(1, 1_000_000_000)
    steps = max(steps, 6)   # distilled needs at least 6 steps
    cfg = 1.0               # distilled is trained to denoise in one direction; cfg=1 is correct

    graph: dict[str, Any] = {
        "1": {"class_type": "CheckpointLoaderSimple",
              "inputs": {"ckpt_name": "ltxv-2b-0.9.6-distilled-04-25.safetensors"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": "t5xxl_fp8_e4m3fn.safetensors", "type": "ltxv"}},
        "3": {"class_type": "ModelSamplingLTXV",
              "inputs": {"model": ["1", 0], "max_shift": 2.05, "base_shift": 0.95}},
        "4": {"class_type": "CLIPTextEncode",
              "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode",
              "inputs": {"text": "low quality, blurry, watermark", "clip": ["2", 0]}},
    }
    if image_filename:
        graph["11"] = {"class_type": "LoadImage", "inputs": {"image": image_filename}}
        graph["6"] = {"class_type": "LTXVImgToVideo",
                      "inputs": {
                          "positive": ["4", 0], "negative": ["5", 0],
                          "vae": ["1", 2], "image": ["11", 0],
                          "width": width, "height": height,
                          "length": frames, "batch_size": 1,
                          "image_noise_scale": 0.15, "strength": 1.0,
                      }}
        graph["7"] = {"class_type": "LTXVConditioning",
                      "inputs": {"positive": ["6", 0], "negative": ["6", 1], "frame_rate": 25}}
        latent_in = ["6", 2]
    else:
        graph["6"] = {"class_type": "EmptyLTXVLatentVideo",
                      "inputs": {"width": width, "height": height, "length": frames, "batch_size": 1}}
        graph["7"] = {"class_type": "LTXVConditioning",
                      "inputs": {"positive": ["4", 0], "negative": ["5", 0], "frame_rate": 25}}
        latent_in = ["6", 0]
    graph["8"] = {"class_type": "KSampler",
                  "inputs": {"seed": seed, "steps": steps, "cfg": cfg,
                             "sampler_name": "euler", "scheduler": "normal", "denoise": 1,
                             "model": ["3", 0],
                             "positive": ["7", 0], "negative": ["7", 1],
                             "latent_image": latent_in}}
    graph["9"] = {"class_type": "VAEDecode",
                  "inputs": {"samples": ["8", 0], "vae": ["1", 2]}}
    graph["10"] = {"class_type": "VHS_VideoCombine",
                   "inputs": {"images": ["9", 0], "frame_rate": 25,
                              "filename_prefix": "ltx_preview", "format": "video/h264-mp4",
                              "pix_fmt": "yuv420p", "crf": 22,
                              "loop_count": 0, "pingpong": False, "save_output": True}}
    return graph


def _ltx_video_workflow(prompt: str, aspect: str, duration: int, steps: int, cfg: float,
                       resolution: str = "720p") -> dict[str, Any]:
    """LTX-Video 0.9 — uses the model's native training resolution (480x832 for 9:16)
    and known-working sampler (euler/normal). Higher res / dpmpp_2m_sde produces
    pink/empty videos with v0.9 + recent ComfyUI."""
    res = (resolution or "720p").lower()
    # LTX v0.9's training resolution. 1080p path uses 768x1280 which is the
    # outer limit before quality collapses; only safe with LTX 0.9.5+.
    if aspect == "9:16":
        width, height = (768, 1280) if res == "1080p" else (480, 832)
    elif aspect == "16:9":
        width, height = (1280, 768) if res == "1080p" else (832, 480)
    else:
        width, height = (768, 768) if res == "1080p" else (640, 640)
    frames = _ltx_frames(duration)
    seed = random.randint(1, 1_000_000_000)
    cfg = max(cfg, 3.0)
    return {
        "1": {"class_type": "CheckpointLoaderSimple",
              "inputs": {"ckpt_name": "ltx-video-2b-v0.9.5.safetensors"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": "t5xxl_fp8_e4m3fn.safetensors", "type": "ltxv"}},
        "3": {"class_type": "ModelSamplingLTXV",
              "inputs": {"model": ["1", 0], "max_shift": 2.05, "base_shift": 0.95}},
        "4": {"class_type": "CLIPTextEncode",
              "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode",
              "inputs": {"text": "low quality, blurry, distorted, watermark", "clip": ["2", 0]}},
        "6": {"class_type": "EmptyLTXVLatentVideo",
              "inputs": {"width": width, "height": height, "length": frames, "batch_size": 1}},
        "7": {"class_type": "LTXVConditioning",
              "inputs": {"positive": ["4", 0], "negative": ["5", 0], "frame_rate": 25}},
        "8": {"class_type": "KSampler",
              "inputs": {"seed": seed, "steps": steps, "cfg": cfg,
                         "sampler_name": "euler", "scheduler": "normal", "denoise": 1,
                         "model": ["3", 0],
                         "positive": ["7", 0], "negative": ["7", 1],
                         "latent_image": ["6", 0]}},
        "9": {"class_type": "VAEDecode",
              "inputs": {"samples": ["8", 0], "vae": ["1", 2]}},
        "10": {"class_type": "VHS_VideoCombine",
               "inputs": {"images": ["9", 0], "frame_rate": 25,
                          "filename_prefix": "ai_video", "format": "video/h264-mp4",
                          "pix_fmt": "yuv420p", "crf": 19,
                          "loop_count": 0, "pingpong": False, "save_output": True}},
    }


def _wan_t2v_workflow(prompt: str, aspect: str, duration: int, steps: int, cfg: float) -> dict[str, Any]:
    """Wan 2.1 1.3B T2V — uses ComfyUI native UNETLoader + CLIPLoader(type=wan) + WAN VAE.
    Native fps is 16; lengths quantize to 4n+1 frames (5s ≈ 81 frames)."""
    width, height = (480, 832) if aspect == "9:16" else (832, 480) if aspect == "16:9" else (640, 640)
    fps = 16
    desired = max(17, min((duration or 5) * fps + 1, 161))
    # Quantize to nearest 4n+1 (Wan latent constraint)
    frames = ((desired - 1) // 4) * 4 + 1
    seed = random.randint(1, 1_000_000_000)
    return {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": "wan2.1_t2v_1.3B_fp16.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan"}},
        "3": {"class_type": "VAELoader",
              "inputs": {"vae_name": "wan_2.1_vae.safetensors"}},
        # Wan 2.1 REQUIRES ModelSamplingSD3 with shift=8.0 — without this the
        # latent isn't denoised correctly and you get black/noise output.
        "10": {"class_type": "ModelSamplingSD3",
               "inputs": {"model": ["1", 0], "shift": 8.0}},
        "4": {"class_type": "CLIPTextEncode",
              "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode",
              "inputs": {"text": "low quality, blurry, distorted, watermark, text, ugly, deformed",
                         "clip": ["2", 0]}},
        "6": {"class_type": "EmptyHunyuanLatentVideo",
              "inputs": {"width": width, "height": height, "length": frames, "batch_size": 1}},
        "7": {"class_type": "KSampler",
              "inputs": {"seed": seed, "steps": steps, "cfg": cfg,
                         "sampler_name": "uni_pc", "scheduler": "simple", "denoise": 1,
                         "model": ["10", 0],
                         "positive": ["4", 0], "negative": ["5", 0],
                         "latent_image": ["6", 0]}},
        "8": {"class_type": "VAEDecode",
              "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "VHS_VideoCombine",
              "inputs": {"images": ["8", 0], "frame_rate": fps,
                         "filename_prefix": "wan_video", "format": "video/h264-mp4",
                         "pix_fmt": "yuv420p", "crf": 19,
                         "loop_count": 0, "pingpong": False, "save_output": True}},
    }


def _ltx_i2v_workflow(prompt: str, image_filename: str, aspect: str, duration: int,
                      steps: int, cfg: float, resolution: str = "720p") -> dict[str, Any]:
    """LTX-Video image-to-video: extends a still photo into an animated clip.
    Uses LTX 0.9's native resolution + euler/normal (matches T2V config)."""
    res = (resolution or "720p").lower()
    if aspect == "9:16":
        width, height = (768, 1280) if res == "1080p" else (480, 832)
    elif aspect == "16:9":
        width, height = (1280, 768) if res == "1080p" else (832, 480)
    else:
        width, height = (768, 768) if res == "1080p" else (640, 640)
    frames = _ltx_frames(duration)
    seed = random.randint(1, 1_000_000_000)
    cfg = max(cfg, 3.0)
    return {
        "1": {"class_type": "CheckpointLoaderSimple",
              "inputs": {"ckpt_name": "ltx-video-2b-v0.9.5.safetensors"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": "t5xxl_fp8_e4m3fn.safetensors", "type": "ltxv"}},
        "3": {"class_type": "ModelSamplingLTXV",
              "inputs": {"model": ["1", 0], "max_shift": 2.05, "base_shift": 0.95}},
        "4": {"class_type": "CLIPTextEncode",
              "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode",
              "inputs": {"text": "low quality, blurry, distorted, watermark", "clip": ["2", 0]}},
        "11": {"class_type": "LoadImage", "inputs": {"image": image_filename}},
        "6": {"class_type": "LTXVImgToVideo",
              "inputs": {
                  "positive": ["4", 0], "negative": ["5", 0],
                  "vae": ["1", 2], "image": ["11", 0],
                  "width": width, "height": height,
                  "length": frames, "batch_size": 1,
                  "image_noise_scale": 0.15,
                  "strength": 1.0,
              }},
        "7": {"class_type": "LTXVConditioning",
              "inputs": {"positive": ["6", 0], "negative": ["6", 1], "frame_rate": 25}},
        "8": {"class_type": "KSampler",
              "inputs": {"seed": seed, "steps": steps, "cfg": cfg,
                         "sampler_name": "euler", "scheduler": "normal", "denoise": 1,
                         "model": ["3", 0],
                         "positive": ["7", 0], "negative": ["7", 1],
                         "latent_image": ["6", 2]}},
        "9": {"class_type": "VAEDecode",
              "inputs": {"samples": ["8", 0], "vae": ["1", 2]}},
        "10": {"class_type": "VHS_VideoCombine",
               "inputs": {"images": ["9", 0], "frame_rate": 25,
                          "filename_prefix": "ai_video_i2v", "format": "video/h264-mp4",
                          "pix_fmt": "yuv420p", "crf": 19,
                          "loop_count": 0, "pingpong": False, "save_output": True}},
    }


def _wan_i2v_workflow(prompt: str, image_filename: str, aspect: str, duration: int,
                      steps: int, cfg: float) -> dict[str, Any]:
    """Wan 2.1 I2V 14B — image conditioned via CLIPVisionEncode + WanImageToVideo."""
    width, height = (480, 832) if aspect == "9:16" else (832, 480) if aspect == "16:9" else (640, 640)
    fps = 16
    desired = max(17, min((duration or 5) * fps + 1, 161))
    frames = ((desired - 1) // 4) * 4 + 1
    seed = random.randint(1, 1_000_000_000)
    return {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": "wan2.1_i2v_480p_14B_fp16.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan"}},
        "3": {"class_type": "VAELoader",
              "inputs": {"vae_name": "wan_2.1_vae.safetensors"}},
        "4": {"class_type": "CLIPVisionLoader",
              "inputs": {"clip_name": "clip_vision_h.safetensors"}},
        "5": {"class_type": "LoadImage", "inputs": {"image": image_filename}},
        "6": {"class_type": "CLIPVisionEncode",
              "inputs": {"clip_vision": ["4", 0], "image": ["5", 0], "crop": "none"}},
        "7": {"class_type": "CLIPTextEncode",
              "inputs": {"text": prompt, "clip": ["2", 0]}},
        "8": {"class_type": "CLIPTextEncode",
              "inputs": {"text": "low quality, blurry, distorted, watermark, deformed",
                         "clip": ["2", 0]}},
        "9": {"class_type": "WanImageToVideo",
              "inputs": {"positive": ["7", 0], "negative": ["8", 0],
                         "vae": ["3", 0], "clip_vision_output": ["6", 0],
                         "start_image": ["5", 0],
                         "width": width, "height": height,
                         "length": frames, "batch_size": 1}},
        # Wan I2V also requires ModelSamplingSD3 shift to denoise correctly
        "13": {"class_type": "ModelSamplingSD3",
               "inputs": {"model": ["1", 0], "shift": 8.0}},
        "10": {"class_type": "KSampler",
               "inputs": {"seed": seed, "steps": steps, "cfg": max(cfg, 6.0),
                          "sampler_name": "uni_pc", "scheduler": "simple", "denoise": 1,
                          "model": ["13", 0],
                          "positive": ["9", 0], "negative": ["9", 1],
                          "latent_image": ["9", 2]}},
        "11": {"class_type": "VAEDecode",
               "inputs": {"samples": ["10", 0], "vae": ["3", 0]}},
        "12": {"class_type": "VHS_VideoCombine",
               "inputs": {"images": ["11", 0], "frame_rate": fps,
                          "filename_prefix": "wan_i2v", "format": "video/h264-mp4",
                          "pix_fmt": "yuv420p", "crf": 19,
                          "loop_count": 0, "pingpong": False, "save_output": True}},
    }


def _wan22_workflow(prompt: str, image_filename: str | None, aspect: str, duration: int,
                    steps: int, cfg: float) -> dict[str, Any]:
    """Wan 2.2 5B TI2V — exact mirror of ComfyUI's official Wan2.2 5B template.

    Single TI2V model handles both T2V and I2V via Wan22ImageToVideoLatent
    (start_image is optional). Uses Wan 2.2's own VAE (not Wan 2.1's) and
    ModelSamplingSD3 with shift=8.0. Native fps=24, length=4n+1, default 121.
    """
    width, height = (704, 1280) if aspect == "9:16" else (1280, 704) if aspect == "16:9" else (704, 704)
    fps = 24
    desired = max(25, min((duration or 5) * fps + 1, 193))
    frames = ((desired - 1) // 4) * 4 + 1
    seed = random.randint(1, 1_000_000_000)
    is_i2v = bool(image_filename)

    # Wan22ImageToVideoLatent inputs: vae (required) + start_image (optional for I2V)
    latent_inputs: dict[str, Any] = {
        "vae": ["39", 0],
        "width": width, "height": height,
        "length": frames, "batch_size": 1,
    }
    if is_i2v:
        latent_inputs["start_image"] = ["56", 0]

    graph: dict[str, Any] = {
        "37": {"class_type": "UNETLoader",
               "inputs": {"unet_name": "wan2.2_ti2v_5B_fp16.safetensors", "weight_dtype": "default"}},
        "38": {"class_type": "CLIPLoader",
               "inputs": {"clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan"}},
        "39": {"class_type": "VAELoader",
               "inputs": {"vae_name": "wan2.2_vae.safetensors"}},
        "48": {"class_type": "ModelSamplingSD3",
               "inputs": {"model": ["37", 0], "shift": 8.0}},
        "6":  {"class_type": "CLIPTextEncode",
               "inputs": {"text": prompt, "clip": ["38", 0]}},
        "7":  {"class_type": "CLIPTextEncode",
               "inputs": {
                   "text": "low quality, blurry, distorted, watermark, deformed, ugly",
                   "clip": ["38", 0]}},
        "55": {"class_type": "Wan22ImageToVideoLatent", "inputs": latent_inputs},
    }
    if is_i2v:
        graph["56"] = {"class_type": "LoadImage", "inputs": {"image": image_filename}}
    # Optional TeaCache between ModelSamplingSD3 and KSampler (~2× faster on Wan)
    sampler_model = _maybe_inject_teacache(graph, ["48", 0], "wan2.2_ti2v_5B", steps)
    graph["3"] = {"class_type": "KSampler",
                  "inputs": {"seed": seed, "steps": steps, "cfg": max(cfg, 5.0),
                             "sampler_name": "uni_pc", "scheduler": "simple", "denoise": 1.0,
                             "model": sampler_model,
                             "positive": ["6", 0], "negative": ["7", 0],
                             "latent_image": ["55", 0]}}
    graph["8"] = {"class_type": "VAEDecode",
                  "inputs": {"samples": ["3", 0], "vae": ["39", 0]}}
    graph["10"] = {"class_type": "VHS_VideoCombine",
                   "inputs": {"images": ["8", 0], "frame_rate": fps,
                              "filename_prefix": "wan22", "format": "video/h264-mp4",
                              "pix_fmt": "yuv420p", "crf": 19,
                              "loop_count": 0, "pingpong": False, "save_output": True}}
    return graph


def _svd_xt_workflow(image_filename: str, aspect: str, steps: int, cfg: float) -> dict[str, Any]:
    """SVD-XT 1.1 — image-only (no prompt). Native 25 frames at 1024x576 / 576x1024."""
    if aspect == "9:16":
        width, height = 576, 1024
    elif aspect == "16:9":
        width, height = 1024, 576
    else:
        width, height = 768, 768
    frames = 25
    fps = 10
    seed = random.randint(1, 1_000_000_000)
    return {
        "1": {"class_type": "ImageOnlyCheckpointLoader",
              "inputs": {"ckpt_name": "svd_xt_1_1.safetensors"}},
        "2": {"class_type": "LoadImage", "inputs": {"image": image_filename}},
        "3": {"class_type": "ImageScale",
              "inputs": {"image": ["2", 0], "upscale_method": "lanczos",
                         "width": width, "height": height, "crop": "center"}},
        "4": {"class_type": "SVD_img2vid_Conditioning",
              "inputs": {"clip_vision": ["1", 1], "init_image": ["3", 0],
                         "vae": ["1", 2], "width": width, "height": height,
                         "video_frames": frames, "motion_bucket_id": 127,
                         "fps": fps, "augmentation_level": 0.0}},
        "5": {"class_type": "VideoLinearCFGGuidance",
              "inputs": {"model": ["1", 0], "min_cfg": 1.0}},
        "6": {"class_type": "KSampler",
              "inputs": {"seed": seed, "steps": steps, "cfg": max(cfg, 2.5),
                         "sampler_name": "euler", "scheduler": "karras", "denoise": 1.0,
                         "model": ["5", 0],
                         "positive": ["4", 0], "negative": ["4", 1],
                         "latent_image": ["4", 2]}},
        "7": {"class_type": "VAEDecode",
              "inputs": {"samples": ["6", 0], "vae": ["1", 2]}},
        "8": {"class_type": "VHS_VideoCombine",
              "inputs": {"images": ["7", 0], "frame_rate": fps,
                         "filename_prefix": "svd_video", "format": "video/h264-mp4",
                         "pix_fmt": "yuv420p", "crf": 19,
                         "loop_count": 0, "pingpong": False, "save_output": True}},
    }


def _hunyuan_t2v_workflow(prompt: str, aspect: str, duration: int, steps: int, cfg: float) -> dict[str, Any]:
    """HunyuanVideo T2V — Tencent's video model.
    Uses DualCLIPLoader (clip_l + llava_llama3) + ModelSamplingSD3 + FluxGuidance.
    Heavy: 720p × 20 steps ≈ 10-15 min on a 5090. The FE step selector lets the
    user trade off speed vs quality."""
    width, height = (720, 1280) if aspect == "9:16" else (1280, 720) if aspect == "16:9" else (960, 960)
    fps = 24
    desired = max(25, min((duration or 5) * fps + 1, 129))
    frames = ((desired - 1) // 4) * 4 + 1
    seed = random.randint(1, 1_000_000_000)
    graph: dict[str, Any] = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": "hunyuan_video_t2v_720p_bf16.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "DualCLIPLoader",
              "inputs": {"clip_name1": "clip_l.safetensors",
                         "clip_name2": "llava_llama3_fp8_scaled.safetensors",
                         "type": "hunyuan_video"}},
        "3": {"class_type": "VAELoader",
              "inputs": {"vae_name": "hunyuan_video_vae_bf16.safetensors"}},
        "4": {"class_type": "CLIPTextEncode",
              "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode",
              "inputs": {"text": "", "clip": ["2", 0]}},
        "6": {"class_type": "FluxGuidance",
              "inputs": {"conditioning": ["4", 0], "guidance": 6.0}},
        "7": {"class_type": "ModelSamplingSD3",
              "inputs": {"model": ["1", 0], "shift": 7.0}},
        "8": {"class_type": "EmptyHunyuanLatentVideo",
              "inputs": {"width": width, "height": height, "length": frames, "batch_size": 1}},
    }
    # Optional TeaCache between ModelSamplingSD3 and KSampler — biggest win on Hunyuan
    sampler_model = _maybe_inject_teacache(graph, ["7", 0], "hunyuan_video", steps)
    graph["9"] = {"class_type": "KSampler",
                  "inputs": {"seed": seed, "steps": steps, "cfg": 1.0,
                             "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0,
                             "model": sampler_model,
                             "positive": ["6", 0], "negative": ["5", 0],
                             "latent_image": ["8", 0]}}
    graph["10"] = {"class_type": "VAEDecode",
                   "inputs": {"samples": ["9", 0], "vae": ["3", 0]}}
    graph["11"] = {"class_type": "VHS_VideoCombine",
                   "inputs": {"images": ["10", 0], "frame_rate": fps,
                              "filename_prefix": "hunyuan_t2v", "format": "video/h264-mp4",
                              "pix_fmt": "yuv420p", "crf": 19,
                              "loop_count": 0, "pingpong": False, "save_output": True}}
    return graph


def _hunyuan_i2v_workflow(prompt: str, image_filename: str, aspect: str, duration: int,
                          steps: int, cfg: float) -> dict[str, Any]:
    """HunyuanVideo I2V — image-conditioned variant. Uses HunyuanImageToVideo node
    similar to WanImageToVideo (positive, vae, start_image → cond + latent).
    Same speed concerns as T2V — heavy at 720p, plan accordingly."""
    width, height = (720, 1280) if aspect == "9:16" else (1280, 720) if aspect == "16:9" else (960, 960)
    fps = 24
    desired = max(25, min((duration or 5) * fps + 1, 129))
    frames = ((desired - 1) // 4) * 4 + 1
    seed = random.randint(1, 1_000_000_000)
    return {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": "hunyuan_video_image_to_video_720p_bf16.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "DualCLIPLoader",
              "inputs": {"clip_name1": "clip_l.safetensors",
                         "clip_name2": "llava_llama3_fp8_scaled.safetensors",
                         "type": "hunyuan_video"}},
        "3": {"class_type": "VAELoader",
              "inputs": {"vae_name": "hunyuan_video_vae_bf16.safetensors"}},
        "4": {"class_type": "LoadImage", "inputs": {"image": image_filename}},
        "5": {"class_type": "CLIPTextEncode",
              "inputs": {"text": prompt, "clip": ["2", 0]}},
        "6": {"class_type": "CLIPTextEncode",
              "inputs": {"text": "", "clip": ["2", 0]}},
        "7": {"class_type": "FluxGuidance",
              "inputs": {"conditioning": ["5", 0], "guidance": 6.0}},
        "8": {"class_type": "HunyuanImageToVideo",
              "inputs": {"positive": ["7", 0], "vae": ["3", 0],
                         "start_image": ["4", 0],
                         "width": width, "height": height,
                         "length": frames, "batch_size": 1,
                         "guidance_type": "v1 (concat)"}},
        "9": {"class_type": "ModelSamplingSD3",
              "inputs": {"model": ["1", 0], "shift": 7.0}},
        "10": {"class_type": "KSampler",
               "inputs": {"seed": seed, "steps": steps, "cfg": 1.0,
                          "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0,
                          "model": ["9", 0],
                          "positive": ["8", 0], "negative": ["6", 0],
                          "latent_image": ["8", 1]}},
        "11": {"class_type": "VAEDecode",
               "inputs": {"samples": ["10", 0], "vae": ["3", 0]}},
        "12": {"class_type": "VHS_VideoCombine",
               "inputs": {"images": ["11", 0], "frame_rate": fps,
                          "filename_prefix": "hunyuan_i2v", "format": "video/h264-mp4",
                          "pix_fmt": "yuv420p", "crf": 19,
                          "loop_count": 0, "pingpong": False, "save_output": True}},
    }


def _mochi_workflow(prompt: str, aspect: str, duration: int, steps: int, cfg: float) -> dict[str, Any]:
    """Mochi 1 (Genmo, Apache-2). Native 848x480, 24 fps; latent length is 6n+1."""
    width, height = (480, 848) if aspect == "9:16" else (848, 480) if aspect == "16:9" else (640, 640)
    fps = 24
    desired = max(25, min((duration or 5) * fps + 1, 163))
    frames = ((desired - 1) // 6) * 6 + 1
    seed = random.randint(1, 1_000_000_000)
    return {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": "mochi_preview_bf16.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": "t5xxl_fp8_e4m3fn.safetensors", "type": "mochi"}},
        "3": {"class_type": "VAELoader",
              "inputs": {"vae_name": "mochi_vae.safetensors"}},
        "4": {"class_type": "CLIPTextEncode",
              "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode",
              "inputs": {"text": "low quality, blurry, distorted, watermark", "clip": ["2", 0]}},
        "6": {"class_type": "ModelSamplingSD3",
              "inputs": {"model": ["1", 0], "shift": 6.0}},
        "7": {"class_type": "EmptyMochiLatentVideo",
              "inputs": {"width": width, "height": height, "length": frames, "batch_size": 1}},
        "8": {"class_type": "KSampler",
              "inputs": {"seed": seed, "steps": steps, "cfg": max(cfg, 4.5),
                         "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0,
                         "model": ["6", 0],
                         "positive": ["4", 0], "negative": ["5", 0],
                         "latent_image": ["7", 0]}},
        "9": {"class_type": "VAEDecode",
              "inputs": {"samples": ["8", 0], "vae": ["3", 0]}},
        "10": {"class_type": "VHS_VideoCombine",
               "inputs": {"images": ["9", 0], "frame_rate": fps,
                          "filename_prefix": "mochi_video", "format": "video/h264-mp4",
                          "pix_fmt": "yuv420p", "crf": 19,
                          "loop_count": 0, "pingpong": False, "save_output": True}},
    }


def build_workflow(model: str, prompt: str, aspect: str, duration: int, steps: int, cfg: float,
                   resolution: str = "720p", image_filename: str | None = None) -> dict[str, Any]:
    m = (model or "ltx-video").lower()
    # LTX distilled — fast preview pipeline (8-12 steps, cfg=1, native checkpoint switch)
    if m in ("ltx-distilled", "ltx-preview", "ltxv-distilled"):
        return _ltx_distilled_workflow(prompt, image_filename, aspect, duration, steps or 8, resolution)
    # SVD is image-only (no prompt) — accept either name
    if m in ("svd", "svd-xt", "svd_xt"):
        if not image_filename:
            raise RuntimeError("SVD-XT requires an input image (this model is image-only).")
        return _svd_xt_workflow(image_filename, aspect, steps or 25, cfg or 2.5)
    # Mochi
    if m in ("mochi", "mochi-1", "mochi1"):
        return _mochi_workflow(prompt, aspect, duration, steps or 30, cfg or 4.5)
    # Hunyuan I2V (explicit, separate model file)
    if m in ("hunyuan-i2v", "hunyuan_i2v"):
        if not image_filename:
            raise RuntimeError("HunyuanVideo I2V requires an input image.")
        return _hunyuan_i2v_workflow(prompt, image_filename, aspect, duration, steps or 20, cfg or 6.0)
    # Hunyuan T2V (auto-switches to I2V when image provided)
    if m in ("hunyuan", "hunyuan-video", "hunyuanvideo"):
        if image_filename:
            return _hunyuan_i2v_workflow(prompt, image_filename, aspect, duration, steps or 20, cfg or 6.0)
        return _hunyuan_t2v_workflow(prompt, aspect, duration, steps or 20, cfg or 6.0)
    # Wan 2.2 (5B) — supports both T2V and I2V via same dispatch
    if m in ("wan-2.2", "wan2.2", "wan22"):
        return _wan22_workflow(prompt, image_filename, aspect, duration, steps or 30, cfg or 6.0)
    # Wan 2.1 I2V 14B — explicit I2V variant (different model file)
    if m in ("wan-2.1-i2v", "wan21-i2v", "wan-2.1-image", "wan-i2v"):
        if not image_filename:
            raise RuntimeError("Wan 2.1 I2V requires an input image.")
        return _wan_i2v_workflow(prompt, image_filename, aspect, duration, steps or 30, cfg or 6.0)
    # I2V branch (existing models)
    if image_filename:
        # LTX is the default I2V path — uses same checkpoint as T2V
        return _ltx_i2v_workflow(prompt, image_filename, aspect, duration, steps or 40, cfg or 4.0, resolution)
    # T2V branch
    if m in ("wan-2.1", "wan2.1", "wan21", "wan"):
        return _wan_t2v_workflow(prompt, aspect, duration, steps or 30, cfg or 6.0)
    # Default: LTX-Video T2V
    return _ltx_video_workflow(prompt, aspect, duration, steps or 30, cfg or 3.0, resolution)


async def _queue_prompt(client: httpx.AsyncClient, workflow: dict[str, Any]) -> str:
    r = await client.post(
        f"{COMFYUI_URL}/prompt",
        json={"prompt": workflow, "client_id": _CLIENT_ID},
        timeout=30,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"ComfyUI rejected workflow ({r.status_code}): {r.text[:1000]}")
    data = r.json()
    if "prompt_id" not in data:
        raise RuntimeError(f"ComfyUI did not return prompt_id: {data}")
    return data["prompt_id"]


async def _ws_progress_listener(
    prompt_id: str,
    progress_cb: Callable[[int, int, float], None],
    stop_event: asyncio.Event,
) -> None:
    """Listen on ComfyUI's WebSocket and fire progress_cb(step, total, sec_per_step).

    Silently exits if the websockets package isn't installed or ComfyUI's WS
    is unreachable — the caller's job still completes via /history polling."""
    try:
        import websockets  # type: ignore
    except ImportError:
        return

    url = _ws_url()
    started_at = time.monotonic()
    last_step = 0
    try:
        async with websockets.connect(url, ping_interval=20, max_size=2 ** 20) as ws:
            while not stop_event.is_set():
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=2.0)
                except asyncio.TimeoutError:
                    continue
                except Exception:
                    return
                if not isinstance(raw, (str, bytes)):
                    continue
                try:
                    msg = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    continue
                if msg.get("type") != "progress":
                    continue
                d = msg.get("data") or {}
                if d.get("prompt_id") != prompt_id:
                    continue
                step = int(d.get("value") or 0)
                total = int(d.get("max") or 0)
                if step <= last_step or total <= 0:
                    continue
                last_step = step
                elapsed = time.monotonic() - started_at
                sec_per_step = elapsed / step if step > 0 else 0
                try:
                    progress_cb(step, total, sec_per_step)
                except Exception:
                    pass
    except Exception:
        # WS unreachable / closed mid-job — silent fallback
        return


async def _poll_history(client: httpx.AsyncClient, prompt_id: str) -> dict[str, Any]:
    deadline = asyncio.get_event_loop().time() + POLL_TIMEOUT
    while asyncio.get_event_loop().time() < deadline:
        r = await client.get(f"{COMFYUI_URL}/history/{prompt_id}", timeout=10)
        if r.status_code == 200:
            hist = r.json()
            entry = hist.get(prompt_id)
            if entry and entry.get("status", {}).get("completed"):
                return entry
            status = (entry or {}).get("status", {}) if entry else {}
            if status.get("status_str") == "error":
                # Pull the per-node error message out of status.messages
                msgs = status.get("messages") or []
                detail = ""
                for m in msgs:
                    if isinstance(m, list) and len(m) >= 2 and m[0] == "execution_error":
                        info = m[1] if isinstance(m[1], dict) else {}
                        detail = (info.get("exception_type") or "") + ": " + (info.get("exception_message") or "")
                        node = info.get("node_type") or info.get("node_id") or ""
                        if node:
                            detail = f"[{node}] {detail}"
                        break
                raise RuntimeError(f"ComfyUI workflow errored — {detail or 'no detail'}")
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


async def _download_image(client: httpx.AsyncClient, url: str) -> bytes:
    r = await client.get(url, timeout=30)
    r.raise_for_status()
    ct = r.headers.get("content-type", "")
    if not ct.startswith("image/"):
        raise RuntimeError(f"image_url returned non-image content-type: {ct}")
    return r.content


async def _upload_image_to_comfy(client: httpx.AsyncClient, image_bytes: bytes,
                                 filename: str = "input.png") -> str:
    """POST the image to ComfyUI's /upload/image endpoint, return the saved name."""
    files = {"image": (filename, image_bytes, "image/png")}
    r = await client.post(f"{COMFYUI_URL}/upload/image", files=files,
                          data={"overwrite": "true"}, timeout=60)
    if r.status_code >= 400:
        raise RuntimeError(f"ComfyUI image upload failed ({r.status_code}): {r.text[:300]}")
    data = r.json()
    return data.get("name") or filename


async def health() -> bool:
    try:
        async with httpx.AsyncClient() as c:
            r = await c.get(f"{COMFYUI_URL}/system_stats", timeout=4)
            return r.status_code == 200
    except Exception:
        return False


async def generate(prompt: str, model: str = "ltx-video", aspect: str = "9:16",
                   duration: int = 5, steps: int = 30, cfg: float = 3.0,
                   resolution: str = "720p", image_url: str | None = None,
                   progress_cb: Optional[Callable[[int, int, float], None]] = None) -> bytes:
    async with httpx.AsyncClient() as client:
        image_filename = None
        if image_url:
            img_bytes = await _download_image(client, image_url)
            image_filename = await _upload_image_to_comfy(client, img_bytes)
        workflow = build_workflow(model, prompt, aspect, duration, steps, cfg, resolution, image_filename)
        prompt_id = await _queue_prompt(client, workflow)

        # Run WS progress listener concurrently with /history polling.
        # If WS fails (or websockets not installed), polling still finishes the job.
        stop_event = asyncio.Event()
        listener: Optional[asyncio.Task[None]] = None
        if progress_cb is not None:
            listener = asyncio.create_task(_ws_progress_listener(prompt_id, progress_cb, stop_event))

        try:
            entry = await _poll_history(client, prompt_id)
        finally:
            stop_event.set()
            if listener is not None:
                try:
                    await asyncio.wait_for(listener, timeout=3.0)
                except (asyncio.TimeoutError, Exception):
                    listener.cancel()

        file = _find_video_file(entry)
        if not file:
            raise RuntimeError("ComfyUI completed but no video file in outputs")
        return await _download(client, file)
