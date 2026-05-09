"""MusicGen audio generation on the 5090 — via Hugging Face Transformers.

We use `transformers` (already installed for the video models) instead of
Meta's `audiocraft` package, because audiocraft pulls in `spacy 3.5.x` which
needs `thinc 8.1.x`, which doesn't compile on Python 3.12 (uses a
`_PyCFrame.use_tracing` field that 3.12 removed).

The transformers route runs the same model weights from HuggingFace (e.g.
`facebook/musicgen-small`) — same audio output, no spacy/thinc dependency,
clean Python 3.12 install.

Override the model via env:
   MUSICGEN_MODEL=facebook/musicgen-small      ~600 MB, ~3-5 sec / 10s clip   (default)
   MUSICGEN_MODEL=facebook/musicgen-medium     ~6 GB,   ~8 sec / 10s clip
   MUSICGEN_MODEL=facebook/musicgen-large      ~13 GB,  ~15 sec / 10s clip

Model auto-downloads to ~/.cache/huggingface/hub/ on first use.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

# MusicGen produces tokens at ~50 tokens/sec of audio. Bump max_new_tokens
# proportional to the requested duration.
_TOKENS_PER_SECOND = 50

_MODEL = None
_PROCESSOR = None
_DEVICE = None
_MODEL_NAME = os.getenv("MUSICGEN_MODEL", "facebook/musicgen-small")


def _load():
    """Lazy-load model + processor + figure out CUDA device. First call may
    download several GB to ~/.cache/huggingface/ — subsequent calls are instant."""
    global _MODEL, _PROCESSOR, _DEVICE
    if _MODEL is not None:
        return _MODEL, _PROCESSOR, _DEVICE
    try:
        import torch
        from transformers import AutoProcessor, MusicgenForConditionalGeneration
    except ImportError as e:
        raise RuntimeError(
            "MusicGen needs `transformers` and `torch`. Both should already be "
            f"installed for the video worker. Original error: {e}"
        ) from e

    _DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[audio] loading {_MODEL_NAME} on {_DEVICE} (first run downloads several GB)")
    _PROCESSOR = AutoProcessor.from_pretrained(_MODEL_NAME)
    _MODEL = MusicgenForConditionalGeneration.from_pretrained(_MODEL_NAME).to(_DEVICE)
    print(f"[audio] {_MODEL_NAME} ready")
    return _MODEL, _PROCESSOR, _DEVICE


def generate(prompt: str, duration: int, output_path: str | Path) -> str:
    """Generate `duration` seconds of audio matching `prompt`. Saves to
    output_path as WAV (let ffmpeg encode to AAC during muxing). Returns
    the output path as a string."""
    import scipy.io.wavfile

    model, processor, device = _load()
    duration = max(2, min(int(duration or 8), 30))
    max_new_tokens = duration * _TOKENS_PER_SECOND

    inputs = processor(text=[prompt], padding=True, return_tensors="pt").to(device)
    audio_values = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=True)

    # MusicGen returns shape [batch, channels, samples]. Take the first item,
    # first channel, move to CPU, convert to numpy.
    sample_rate = model.config.audio_encoder.sampling_rate
    waveform = audio_values[0, 0].cpu().numpy()
    output_path = str(output_path)
    scipy.io.wavfile.write(output_path, rate=sample_rate, data=waveform)
    return output_path


def mux_audio_into_video(video_bytes: bytes, audio_path: str) -> bytes:
    """Mux `audio_path` (wav) into `video_bytes` (mp4) via ffmpeg. Returns
    the new mp4 bytes. Falls back to the original video if ffmpeg fails so
    we don't lose the user's video over a muxing hiccup."""
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as vf:
        vf.write(video_bytes)
        in_video = vf.name
    out_video = in_video.replace(".mp4", "_muxed.mp4")

    cmd = [
        "ffmpeg", "-y",
        "-i", in_video,
        "-i", audio_path,
        "-c:v", "copy",          # keep video stream as-is
        "-c:a", "aac", "-b:a", "192k",
        "-shortest",             # video and music length may differ; trim to shorter
        "-loglevel", "error",
        out_video,
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
        with open(out_video, "rb") as f:
            muxed = f.read()
        return muxed
    except subprocess.CalledProcessError as e:
        print(f"[audio] ffmpeg mux failed (returning original video): {e.stderr[:300] if e.stderr else e}")
        return video_bytes
    except FileNotFoundError:
        print("[audio] ffmpeg not on PATH — install ffmpeg to use background music")
        return video_bytes
    finally:
        for p in (in_video, out_video):
            try: os.unlink(p)
            except OSError: pass


def is_available() -> bool:
    """True if `transformers` + `scipy` are importable AND ffmpeg is on PATH.
    Used by worker.py to short-circuit the background-music branch when prerequisites
    are missing."""
    try:
        import transformers   # noqa: F401
        import scipy          # noqa: F401
        import torch          # noqa: F401
    except ImportError:
        return False
    try:
        subprocess.run(["ffmpeg", "-version"], check=True, capture_output=True)
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False
    return True
