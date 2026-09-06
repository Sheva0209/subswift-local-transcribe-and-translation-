#!/usr/bin/env python3
"""
Clip Studio — Dual-engine Whisper transcription bridge script.

Tries faster-whisper first (CTranslate2, fast). If HuggingFace model download fails
(e.g. ISP blocks connection), falls back to openai-whisper (Azure CDN, reliable).
Auto-detects NVIDIA CUDA GPU for acceleration.

Usage:
    python transcribe.py <input_video_path> <output_srt_path> [initial_prompt]

Environment variables:
    WHISPER_MODEL   — Model size: tiny, base, small, medium, large-v3-turbo (default: "large-v3-turbo")
    WHISPER_DEVICE  — "cpu" or "cuda" (default: auto-detect)
    INITIAL_PROMPT  — Optional prompt/glossary to guide Whisper recognition

Outputs JSON to stdout on success:
    {"raw_text": "...", "language": "en", "segments_count": 42}
"""

import sys
import os
import json
import math
import glob


def format_srt_timestamp(seconds):
    """Convert seconds to SRT timestamp format HH:MM:SS,mmm"""
    hours = math.floor(seconds / 3600)
    minutes = math.floor((seconds % 3600) / 60)
    secs = seconds % 60
    millis = round((secs % 1) * 1000)
    return f"{int(hours):02}:{int(minutes):02}:{int(secs):02},{millis:03}"


def detect_device():
    """Auto-detect best device: CUDA GPU if available, otherwise CPU."""
    env_device = os.environ.get("WHISPER_DEVICE")
    if env_device:
        return env_device
    try:
        import torch
        if torch.cuda.is_available():
            gpu_name = torch.cuda.get_device_name(0)
            vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024**3)
            print(f"[whisper] GPU terdeteksi: {gpu_name} ({vram_gb:.1f} GB VRAM)", file=sys.stderr)
            return "cuda"
    except Exception as e:
        print(f"[whisper] Warning: CUDA detection failed ({e})", file=sys.stderr)
    return "cpu"


def transcribe_faster_whisper(input_path, output_srt, model_name, device, initial_prompt=None):
    """Attempt transcription using faster-whisper (CTranslate2) — fastest engine."""
    from faster_whisper import WhisperModel

    compute_type = "float16" if device == "cuda" else "int8"
    print(f"[whisper] Loading faster-whisper model '{model_name}' on {device} ({compute_type})...", file=sys.stderr)

    # Try model name aliases for large-v3-turbo compatibility
    model_aliases = [model_name]
    if model_name == "large-v3-turbo":
        model_aliases = ["large-v3-turbo", "deepdml/faster-whisper-large-v3-turbo-ct2", "turbo", "large-v3"]
    elif model_name == "turbo":
        model_aliases = ["turbo", "large-v3-turbo", "large-v3"]

    model = None
    for alias in model_aliases:
        try:
            print(f"[whisper] Trying model alias: {alias}", file=sys.stderr)
            model = WhisperModel(alias, device=device, compute_type=compute_type, local_files_only=True)
            print(f"[whisper] Loaded model: {alias}", file=sys.stderr)
            break
        except Exception as e:
            print(f"[whisper] Alias '{alias}' failed: {str(e)[:100]}", file=sys.stderr)
            continue
    if model is None:
        raise RuntimeError(f"Failed to load any model alias for '{model_name}'")

    print(f"[whisper] Transcribing: {input_path}", file=sys.stderr)
    if initial_prompt:
        print(f"[whisper] Using initial_prompt/glossary: {initial_prompt[:100]}...", file=sys.stderr)

    transcribe_kwargs = {
        "beam_size": 5,
        "vad_filter": True,
        "word_timestamps": True,
    }
    if initial_prompt:
        transcribe_kwargs["initial_prompt"] = initial_prompt

    segments_gen, info = model.transcribe(input_path, **transcribe_kwargs)

    segments_list = []
    raw_text_parts = []
    os.makedirs(os.path.dirname(output_srt) or ".", exist_ok=True)

    with open(output_srt, "w", encoding="utf-8") as f:
        for i, segment in enumerate(segments_gen, start=1):
            start_ts = format_srt_timestamp(segment.start)
            end_ts = format_srt_timestamp(segment.end)
            text = segment.text.strip()

            f.write(f"{i}\n{start_ts} --> {end_ts}\n{text}\n\n")

            segments_list.append({
                "index": i,
                "start": round(segment.start, 3),
                "end": round(segment.end, 3),
                "text": text,
            })
            raw_text_parts.append(text)

    return {
        "raw_text": " ".join(raw_text_parts),
        "language": info.language if info.language else "unknown",
        "segments_count": len(segments_list),
    }


def transcribe_openai_whisper(input_path, output_srt, model_name, device, initial_prompt=None):
    """Fallback transcription using openai-whisper (Torch) — reliable Azure CDN download."""
    import whisper

    # openai-whisper uses 'turbo' for large-v3-turbo
    ow_model_name = model_name
    if model_name == "large-v3-turbo":
        ow_model_name = "turbo"

    print(f"[whisper-fallback] Loading openai-whisper model '{ow_model_name}' on {device}...", file=sys.stderr)
    try:
        model = whisper.load_model(ow_model_name, device=device)
    except RuntimeError as e:
        err_str = str(e).lower()
        if "checksum" in err_str or "sha256" in err_str:
            print("[whisper-fallback] Corrupted cache detected, cleaning & retrying...", file=sys.stderr)
            cache_dir = os.path.expanduser("~/.cache/whisper")
            for fpath in glob.glob(os.path.join(cache_dir, "*.pt")):
                try:
                    os.remove(fpath)
                    print(f"  removed: {fpath}", file=sys.stderr)
                except Exception:
                    pass
            model = whisper.load_model(ow_model_name, device=device)
        else:
            raise

    print(f"[whisper-fallback] Transcribing: {input_path}", file=sys.stderr)
    if initial_prompt:
        print(f"[whisper-fallback] Using initial_prompt/glossary: {initial_prompt[:100]}...", file=sys.stderr)

    transcribe_kwargs = {
        "verbose": False,
        "word_timestamps": True,
        "condition_on_previous_text": True,
    }
    if initial_prompt:
        transcribe_kwargs["initial_prompt"] = initial_prompt

    result = model.transcribe(input_path, **transcribe_kwargs)

    segments = result.get("segments", [])
    raw_text_parts = []
    os.makedirs(os.path.dirname(output_srt) or ".", exist_ok=True)

    with open(output_srt, "w", encoding="utf-8") as f:
        for i, seg in enumerate(segments, start=1):
            start_ts = format_srt_timestamp(seg["start"])
            end_ts = format_srt_timestamp(seg["end"])
            text = seg["text"].strip()

            f.write(f"{i}\n{start_ts} --> {end_ts}\n{text}\n\n")
            raw_text_parts.append(text)

    return {
        "raw_text": " ".join(raw_text_parts),
        "language": result.get("language", "unknown"),
        "segments_count": len(segments),
    }


def main():
    if len(sys.argv) < 3:
        print("Usage: python transcribe.py <input_video> <output_srt> [initial_prompt]", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_srt = sys.argv[2]
    # initial_prompt can come from argv[3] or INITIAL_PROMPT env var
    initial_prompt = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("INITIAL_PROMPT", "")
    initial_prompt = initial_prompt.strip() or None

    if not os.path.isfile(input_path):
        print(f"Error: input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    model_name = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
    device = detect_device()

    print(f"[whisper] Config: model={model_name}, device={device}", file=sys.stderr)
    if initial_prompt:
        print(f"[whisper] Glossary/prompt: {initial_prompt[:150]}", file=sys.stderr)

    result = None

    # Engine 1: Try faster-whisper (CTranslate2, fastest)
    try:
        result = transcribe_faster_whisper(input_path, output_srt, model_name, device, initial_prompt)
    except Exception as e:
        err_msg = str(e)
        # Only log the first 200 chars to keep it readable
        print(f"[whisper] faster-whisper failed: {err_msg[:200]}", file=sys.stderr)
        print("[whisper] Switching to openai-whisper fallback...", file=sys.stderr)

    # Engine 2: Fallback to openai-whisper (Torch, reliable download)
    if result is None:
        try:
            result = transcribe_openai_whisper(input_path, output_srt, model_name, device, initial_prompt)
        except Exception as e:
            print(f"Error: both whisper engines failed: {e}", file=sys.stderr)
            sys.exit(1)

    print(f"[whisper] Done! {result['segments_count']} segments, lang={result['language']}", file=sys.stderr)
    # Output clean JSON to stdout for Node.js
    print(json.dumps(result))


if __name__ == "__main__":
    main()
