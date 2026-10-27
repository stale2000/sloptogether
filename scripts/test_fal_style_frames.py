#!/usr/bin/env python3
"""Render saved 448x256 style frames on the private SlopTogether FastH3 Fal app."""
from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
FRAME_DIR = ROOT / "comfy-cloud-smoke" / "style-video-comparison" / "assets"
WORKFLOW = ROOT / "vendor" / "comfystream" / "reference" / "workflows" / "trim-five-step-first-last-frame.api.json"
DEFAULT_OUTPUT = ROOT / "comfy-cloud-smoke" / "style-video-comparison" / "outputs" / "fal-fast-h3"
VARIANTS = (
    ("anime-cel", "0ca2b9e6_000.png", "Hand-drawn 2D cel anime: bold clean ink outlines, limited indigo and teal night palette, warm amber light."),
    ("flat-cartoon", "94bfb673_000.png", "Flat 2D cartoon: chunky confident ink outlines, rounded graphic shapes, three-tone colors, playful staging."),
    ("watercolor", "79272e58_000.png", "Watercolor storybook animation: soft gouache texture, simple charming shapes, cobalt night sky and peach stars."),
)
MOTION = (
    "The folded paper crane rises from the telescope, rotates once and unfolds into a small glowing constellation. "
    "The young astronaut raises one gloved hand and waves. Stars light up one by one as the camera gently pushes in. "
    "Keep character proportions and composition stable. One continuous 15-second shot, no cuts, no text."
)


def api(base: str, key: str, path: str, *, method: str = "GET", body: bytes | None = None,
        content_type: str = "application/json", timeout: int = 90, read_limit: int = 160 * 1024 * 1024) -> bytes:
    request = urllib.request.Request(
        base.rstrip("/") + path,
        data=body,
        headers={"Authorization": f"Key {key}", "Accept": "application/json", "User-Agent": "SlopTogether-Worker/0.1",
                 **({"Content-Type": content_type} if body is not None else {})},
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = response.read(read_limit + 1)
            if len(data) > read_limit:
                raise RuntimeError("fal_test_response_too_large")
            return data
    except urllib.error.HTTPError as error:
        detail = error.read(2048).decode("utf-8", "replace")
        raise RuntimeError(f"fal_test_http_{error.code}:{detail[:600]}") from None


def upload_image(base: str, key: str, source: Path, name: str) -> str:
    boundary = "----SlopTogetherFalTest" + uuid.uuid4().hex
    data = source.read_bytes()
    content_type = "image/png"
    payload = b"".join((
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n".encode(),
        f"Content-Type: {content_type}\r\n\r\n".encode(), data,
        f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"type\"\r\n\r\ninput\r\n".encode(),
        f"--{boundary}--\r\n".encode(),
    ))
    result = json.loads(api(base, key, "/upload/image", method="POST", body=payload,
                            content_type=f"multipart/form-data; boundary={boundary}"))
    uploaded = result.get("name")
    if not isinstance(uploaded, str) or not uploaded or Path(uploaded).name != uploaded:
        raise RuntimeError("fal_test_image_upload_invalid")
    return uploaded


def response_images(entry: dict[str, Any]) -> list[dict[str, str]]:
    outputs = entry.get("outputs")
    if not isinstance(outputs, dict):
        return []
    result: list[dict[str, str]] = []
    for node in outputs.values():
        if not isinstance(node, dict):
            continue
        for field in ("videos", "gifs", "images"):
            files = node.get(field)
            if isinstance(files, list):
                result.extend(item for item in files if isinstance(item, dict) and isinstance(item.get("filename"), str))
    return result


def run(base: str, output_dir: Path, timeout_seconds: int) -> int:
    key = os.environ.get("FAL_KEY", "")
    if not key or any(ch.isspace() for ch in key):
        raise RuntimeError("fal_test_key_required_in_environment")
    if not base.startswith("https://fal.run/"):
        raise RuntimeError("fal_test_endpoint_must_be_private_fal_run_url")
    graph = json.loads(WORKFLOW.read_text(encoding="utf-8"))
    output_dir.mkdir(parents=True, exist_ok=True)
    uploaded: dict[str, str] = {}
    for style, frame_name, _ in VARIANTS:
        frame = FRAME_DIR / frame_name
        remote = f"slop-{style}-{uuid.uuid4().hex}.png"
        uploaded[style] = upload_image(base, key, frame, remote)
        print(f"uploaded {style} start/end frame ({frame.stat().st_size} bytes)", flush=True)

    prompt_ids: dict[str, str] = {}
    for index, (style, _, art_direction) in enumerate(VARIANTS):
        workflow = json.loads(json.dumps(graph))
        workflow["20"]["inputs"]["image"] = uploaded[style]
        workflow["21"]["inputs"]["image"] = uploaded[style]
        workflow["5"]["inputs"].update({
            "prompt": f"integrated_multimodal_description: [Shot 1] {art_direction} {MOTION}\n"
                      "soundscape: Gentle paper rustle and a soft sparkling chime.\n"
                      "non_diegetic_music: N/A",
            "width": 448,
            "height": 256,
            "length": 362,
        })
        workflow["8"]["inputs"]["seed"] = 71231 + index
        workflow["8"]["inputs"]["run_nonce"] = f"fal-style-{style}-{uuid.uuid4().hex}"
        workflow["12"]["inputs"]["filename_prefix"] = f"sloptogether-style-tests/{style}"
        submitted = json.loads(api(base, key, "/prompt", method="POST",
                                   body=json.dumps({"prompt": workflow, "client_id": uuid.uuid4().hex}).encode()))
        prompt_id = submitted.get("prompt_id")
        errors = submitted.get("node_errors")
        if not isinstance(prompt_id, str) or errors:
            raise RuntimeError(f"fal_test_submit_failed:{style}:{str(errors)[:500]}")
        prompt_ids[style] = prompt_id
        print(f"queued {style} FastH3 5-step job {prompt_id}", flush=True)

    deadline = time.monotonic() + timeout_seconds
    pending = dict(prompt_ids)
    while pending:
        for style, prompt_id in list(pending.items()):
            encoded=urllib.parse.quote(prompt_id,safe="")
            try:
                job=json.loads(api(base,key,f"/api/jobs/{encoded}",timeout=30))
                entry=job if isinstance(job,dict) else None
                state=entry.get("status") if entry else None
                if state=="failed":raise RuntimeError(f"fal_test_comfy_failed:{style}")
                if state not in {"completed","complete"}:continue
            except (TimeoutError,urllib.error.URLError):
                print(f"status temporarily unavailable for {style}; retrying read-only poll",flush=True)
                time.sleep(10)
                continue
            except RuntimeError as error:
                if not str(error).startswith("fal_test_http_404:"):
                    raise
                history=json.loads(api(base,key,f"/history/{encoded}",timeout=30))
                entry=history.get(prompt_id) if isinstance(history,dict) else None
            if not isinstance(entry, dict):
                continue
            status_value=entry.get("status")
            state=status_value.get("status_str") if isinstance(status_value,dict) else status_value
            if state == "error":
                raise RuntimeError(f"fal_test_comfy_failed:{style}")
            if state not in {"success", "completed"}:
                continue
            files = [item for item in response_images(entry) if item["filename"].lower().endswith(".mp4")]
            if not files:
                raise RuntimeError(f"fal_test_video_missing:{style}")
            item = files[0]
            query = urllib.parse.urlencode({"filename": item["filename"], "subfolder": item.get("subfolder", ""), "type": item.get("type", "output")})
            try:
                content = api(base, key, f"/view?{query}", timeout=120, read_limit=256 * 1024 * 1024)
            except (TimeoutError,urllib.error.URLError):
                print(f"output temporarily unavailable for {style}; retrying read-only download",flush=True)
                time.sleep(10)
                continue
            target = output_dir / f"{style}.mp4"
            target.write_bytes(content)
            print(f"completed {style}: {target} ({len(content)} bytes)", flush=True)
            del pending[style]
        if pending:
            if time.monotonic() >= deadline:
                raise RuntimeError("fal_test_deadline_exceeded:" + ",".join(pending))
            time.sleep(5)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the saved low-resolution style frames through SlopTogether's private Fal FastH3 app.")
    parser.add_argument("--endpoint", default="https://fal.run/stale2000/sloptogether-h3-generation")
    parser.add_argument("--timeout-seconds", type=int, default=3600)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    if not 60 <= args.timeout_seconds <= 7200:
        parser.error("--timeout-seconds must be between 60 and 7200")
    try:
        return run(args.endpoint, args.output_dir, args.timeout_seconds)
    except Exception as error:
        print(f"fal_style_test_failed:{error}", file=__import__("sys").stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
