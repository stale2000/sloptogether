from __future__ import annotations

import copy
import http.client
import json
import os
import secrets
import shutil
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .config import WorkerConfig
from .errors import WorkerError
from .models import WorkerJob
from .recipes import RECIPES, Recipe, build_workflow

MAX_FRAME_BYTES = 16 * 1024 * 1024
MAX_VIDEO_BYTES = 128 * 1024 * 1024
MAX_COMFY_JSON_BYTES = 2 * 1024 * 1024
MAX_OUTPUTS_PER_JOB = 3
MAX_HISTORY_BYTES = 4 * 1024 * 1024
ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp"}


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        return None


class ComfyClient:
    def __init__(self, config: WorkerConfig) -> None:
        self.config = config
        self.base_url = config.comfy_url.rstrip("/")
        self.context = ssl.create_default_context()
        self.client_id = secrets.token_hex(16)
        self.bearer = config.comfy_profile_api_token
        self._job_api_mode: str | None = None
        self.opener = urllib.request.build_opener(_NoRedirectHandler)

    def _request(self, method: str, path: str, *, body: bytes | None = None,
                 content_type: str = "application/json", timeout: int | None = None,
                 response_limit: int = MAX_HISTORY_BYTES) -> bytes:
        headers = {"Accept": "application/json", "User-Agent": "SlopTogether-Worker/0.1"}
        if self.bearer:
            headers["Authorization"] = f"Bearer {self.bearer}"
        if body is not None:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(self.base_url + path, data=body, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=timeout or self.config.request_timeout_seconds) as response:
                data = response.read(response_limit + 1)
                if len(data) > response_limit:
                    raise WorkerError("comfy_response_too_large", "ComfyUI returned an oversized response.")
                return data
        except urllib.error.HTTPError as error:
            raise WorkerError(f"comfy_http_{error.code}", f"Local ComfyUI returned HTTP {error.code}.") from None
        except (urllib.error.URLError, TimeoutError, ssl.SSLError) as error:
            raise WorkerError("comfy_unavailable", f"The local ComfyUI service is unavailable ({type(error).__name__}).") from None

    def object_info(self) -> dict[str, Any]:
        raw = self._request("GET", "/object_info", timeout=15)
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as error:
            raise WorkerError("comfy_object_info_invalid", "ComfyUI returned invalid node metadata.") from error
        if not isinstance(payload, dict):
            raise WorkerError("comfy_object_info_invalid", "ComfyUI returned invalid node metadata.")
        return payload

    def queue_is_idle(self) -> bool:
        raw = self._request("GET", "/queue", timeout=10)
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            raise WorkerError("comfy_queue_invalid", "ComfyUI returned invalid queue state.") from None
        if not isinstance(payload, dict) or not isinstance(payload.get("queue_running"), list) or not isinstance(payload.get("queue_pending"), list):
            raise WorkerError("comfy_queue_invalid", "ComfyUI returned invalid queue state.")
        return not payload["queue_running"] and not payload["queue_pending"]

    def release_idle_models(self) -> None:
        self._request("POST", "/free", body=json.dumps({"unload_models": True, "free_memory": True}).encode(), timeout=15)

    @staticmethod
    def temporary_input_filename(suffix: str) -> str:
        normalized=suffix.lower()
        if normalized not in {".png",".jpg",".jpeg",".webp"}:
            raise WorkerError("input_frame_type_invalid","A reference frame has an unsupported filename extension.")
        return f"slop-{secrets.token_hex(16)}{normalized}"

    def _input_directory(self) -> Path:
        configured_root=self.config.comfy_input_dir.expanduser().absolute()
        if configured_root.is_symlink():
            raise WorkerError("comfy_input_directory_invalid","Configured ComfyUI input directory cannot be a symbolic link.")
        input_root=configured_root.resolve(strict=True)
        if not input_root.is_dir():
            raise WorkerError("comfy_input_directory_invalid","Configured ComfyUI input directory is not a directory.")
        return input_root

    def remove_temporary_input(self, name: str) -> None:
        if not isinstance(name,str) or not name.startswith("slop-") or "/" in name or "\\" in name:
            raise WorkerError("comfy_input_filename_invalid","Refusing to remove a non-temporary ComfyUI input file.")
        input_root=self._input_directory()
        candidate=input_root/name
        if candidate.parent!=input_root:
            raise WorkerError("comfy_input_filename_invalid","Refusing to remove a ComfyUI input outside its configured directory.")
        candidate.unlink(missing_ok=True)

    def remove_attempt_outputs(self, job_id: str, attempt_id: str) -> None:
        try:
            job_id=str(uuid.UUID(job_id))
            attempt_id=str(uuid.UUID(attempt_id))
        except (TypeError,ValueError):
            raise WorkerError("comfy_output_identity_invalid","Refusing to clean output for an invalid job attempt.") from None
        configured_root=self.config.comfy_output_dir.expanduser().absolute()
        if configured_root.is_symlink():
            raise WorkerError("comfy_output_directory_invalid","Configured ComfyUI output directory cannot be a symbolic link.")
        output_root=configured_root.resolve(strict=True)
        if not output_root.is_dir():
            raise WorkerError("comfy_output_directory_invalid","Configured ComfyUI output directory is not a directory.")
        namespace=output_root/"sloptogether"
        job_directory=namespace/job_id
        attempt_directory=job_directory/attempt_id
        if any(path.is_symlink() for path in (namespace,job_directory,attempt_directory)):
            raise WorkerError("comfy_output_directory_invalid","Worker output paths cannot contain symbolic links.")
        if attempt_directory.exists():
            if not attempt_directory.is_dir():
                raise WorkerError("comfy_output_directory_invalid","ComfyUI attempt output path is not a directory.")
            shutil.rmtree(attempt_directory)
        for directory in (job_directory,namespace):
            try:
                directory.rmdir()
            except OSError:
                pass

    def upload_image(self, path: Path, filename: str | None = None) -> str:
        mime = _image_mime(path)
        size = path.stat().st_size
        if size <= 0 or size > MAX_FRAME_BYTES:
            raise WorkerError("input_frame_size_invalid", "A reference frame exceeds its allowed size.")
        boundary = f"----SlopTogether{secrets.token_hex(18)}"
        data = path.read_bytes()
        filename = filename or self.temporary_input_filename(path.suffix)
        if not filename.startswith("slop-") or Path(filename).name!=filename or "/" in filename or "\\" in filename or any(c in filename for c in ('"',"\r","\n")):
            raise WorkerError("comfy_input_filename_invalid","Temporary ComfyUI image filename is invalid.")
        pieces = [
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n".encode(),
            data,
            f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"type\"\r\n\r\ninput\r\n--{boundary}--\r\n".encode(),
        ]
        raw = self._request("POST", "/upload/image", body=b"".join(pieces), content_type=f"multipart/form-data; boundary={boundary}")
        try:
            result = json.loads(raw)
            name = result.get("name") if isinstance(result, dict) else None
        except json.JSONDecodeError as error:
            raise WorkerError("comfy_upload_invalid", "ComfyUI returned an invalid image upload response.") from error
        if not isinstance(name, str) or not name or "/" in name or "\\" in name:
            raise WorkerError("comfy_upload_invalid", "ComfyUI returned an unsafe image filename.")
        return name

    def upload_video_to_input_dir(self, path: Path) -> str:
        """Use an explicitly configured, loopback-local ComfyUI input directory."""
        input_root = self._input_directory()
        target_name = f"slop-{secrets.token_hex(16)}{path.suffix.lower()}"
        if path.suffix.lower() not in {".mp4", ".mov", ".webm", ".mkv"}:
            raise WorkerError("video_type_unsupported", "Upscale source is not a supported video file.")
        target = input_root / target_name
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
        descriptor = os.open(target, flags, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as output, path.open("rb") as source:
                total = 0
                while chunk := source.read(1024 * 1024):
                    total += len(chunk)
                    if total > MAX_VIDEO_BYTES:
                        raise WorkerError("input_video_too_large", "Upscale source exceeds the allowed size.")
                    output.write(chunk)
        except Exception:
            target.unlink(missing_ok=True)
            raise
        return target_name

    def submit(self, workflow: dict[str, Any]) -> str:
        raw = self._request("POST", "/prompt", body=json.dumps({"prompt": workflow, "client_id": self.client_id}).encode())
        try:
            result = json.loads(raw)
        except json.JSONDecodeError as error:
            raise WorkerError("comfy_submit_invalid", "ComfyUI returned an invalid workflow response.") from error
        prompt_id = result.get("prompt_id") if isinstance(result, dict) else None
        if not isinstance(prompt_id, str) or len(prompt_id) > 128:
            node_errors = result.get("node_errors") if isinstance(result, dict) else None
            raise WorkerError("comfy_workflow_rejected", "The pinned workflow was rejected by local ComfyUI." if not node_errors else "The pinned workflow needs the required local node/model profile.")
        return prompt_id

    def await_output(self, prompt_id: str, timeout_seconds: float, progress: Callable[[float], None] | None = None,
                     cancelled: Callable[[], bool] | None = None) -> list[dict[str, str]]:
        encoded = urllib.parse.quote(prompt_id, safe="")
        deadline = time.monotonic() + max(0.0, timeout_seconds)
        while time.monotonic() < deadline:
            if cancelled and cancelled():
                raise WorkerError("attempt_cancelled", "The worker attempt was stopped or revoked.")
            try:
                mode=getattr(self,"_job_api_mode",None)
                if mode!="legacy":
                    try:
                        raw=self._request("GET",f"/api/jobs/{encoded}",timeout=10)
                        mode="jobs"
                        self._job_api_mode=mode
                    except WorkerError as error:
                        if error.code!="comfy_http_404":
                            raise
                        mode="legacy"
                        self._job_api_mode=mode
                if mode=="legacy":
                    raw=self._request("GET",f"/history/{encoded}",timeout=10)
                    history=json.loads(raw)
                    item=history.get(prompt_id) if isinstance(history,dict) else None
                    if isinstance(item,dict):
                        outputs=item.get("outputs",{})
                        files=list(_output_files(outputs)) if isinstance(outputs,dict) else []
                        if files:
                            if progress: progress(1.0)
                            return files
                        status=item.get("status",{})
                        if isinstance(status,dict) and status.get("status_str")=="error":
                            raise WorkerError("comfy_execution_failed","Local ComfyUI reported a workflow execution failure.")
                else:
                    job=json.loads(raw)
                    if not isinstance(job,dict) or (job.get("id") is not None and job.get("id")!=prompt_id):
                        raise WorkerError("comfy_job_invalid","ComfyUI returned invalid job details.")
                    status=job.get("status")
                    if not isinstance(status,str):
                        raise WorkerError("comfy_job_invalid","ComfyUI returned invalid job details.")
                    if status in {"failed","cancelled"}:
                        raise WorkerError("comfy_execution_failed","Local ComfyUI reported a workflow execution failure.")
                    if status=="completed":
                        outputs=job.get("outputs",{})
                        files=list(_output_files(outputs)) if isinstance(outputs,dict) else []
                        if not files:
                            raise WorkerError("comfy_output_missing","ComfyUI completed without returning workflow outputs.")
                        if progress: progress(1.0)
                        return files
                    if status not in {"pending","in_progress"}:
                        raise WorkerError("comfy_job_invalid","ComfyUI returned an unsupported job status.")
            except json.JSONDecodeError:
                raise WorkerError("comfy_job_invalid", "Local ComfyUI returned invalid job details.") from None
            if progress:
                progress(0.5)
            time.sleep(min(2.0, max(0.0, deadline - time.monotonic())))
        raise WorkerError("comfy_attempt_deadline", "ComfyUI did not finish before the job deadline.")

    def download_output(self, file: dict[str, str], destination: Path, limit: int) -> None:
        filename = file.get("filename", "")
        if not filename or Path(filename).name != filename:
            raise WorkerError("comfy_output_path_invalid", "ComfyUI returned an unsafe output filename.")
        query = urllib.parse.urlencode({"filename": filename, "subfolder": file.get("subfolder", ""), "type": file.get("type", "output")})
        data = self._request("GET", f"/view?{query}", timeout=90, response_limit=limit)
        if len(data) > limit:
            raise WorkerError("comfy_output_too_large", "ComfyUI output exceeds the allowed upload size.")
        with destination.open("xb") as output:
            output.write(data)

    def cancel_prompt(self, prompt_id: str) -> None:
        """Delete this queued prompt and target only its running execution."""
        if not prompt_id or len(prompt_id) > 128 or any(ch not in "0123456789abcdef-" for ch in prompt_id.lower()):
            raise WorkerError("comfy_prompt_id_invalid", "Cannot cancel an invalid ComfyUI request identity.")
        for path, payload in (("/queue", {"delete": [prompt_id]}), ("/interrupt", {"prompt_id": prompt_id})):
            try:
                self._request("POST", path, body=json.dumps(payload).encode(), timeout=3)
            except WorkerError:
                pass


def build_job_workflow(
    job: WorkerJob,
    recipe: Recipe,
    local_filenames: dict[str, str],
    *,
    vsa_budget_policy: str = "fixed",
) -> tuple[str, dict[str, Any]]:
    graph = _workflow_for_job(job, recipe, local_filenames, vsa_budget_policy=vsa_budget_policy)
    return recipe.output_node_id, graph


def _workflow_for_job(
    job: WorkerJob,
    recipe: Recipe,
    local_filenames: dict[str, str],
    *,
    vsa_budget_policy: str = "fixed",
) -> dict[str, Any]:
    # User/job inputs cannot select kernels; only the worker's deployment profile can.
    from .recipes import build_workflow
    return build_workflow(job, recipe, local_filenames, vsa_budget_policy=vsa_budget_policy)[1]


def _output_files(outputs: dict[str, Any]):
    for node_id, output in outputs.items():
        if not isinstance(output, dict):
            continue
        for field in ("videos", "gifs", "images"):
            entries = output.get(field)
            if not isinstance(entries, list):
                continue
            for item in entries:
                if not isinstance(item, dict):
                    continue
                name = item.get("filename")
                if not isinstance(name, str) or not name.lower().endswith((".mp4", ".mov", ".webm", ".mkv", ".png", ".jpg", ".webp")):
                    continue
                yield {"node_id": str(node_id), "filename": name, "subfolder": str(item.get("subfolder", "")), "type": str(item.get("type", "output")), "content_type": str(item.get("content_type", ""))}


def _image_mime(path: Path) -> str:
    signature = path.open("rb")
    with signature:
        header = signature.read(12)
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "image/webp"
    raise WorkerError("input_frame_format_invalid", "Reference frames must be PNG, JPEG or WebP image files.")
