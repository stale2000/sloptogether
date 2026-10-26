from __future__ import annotations

import hashlib
import json
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any

from .config import WorkerConfig
from .errors import ApiError, WorkerError


@dataclass(frozen=True, slots=True)
class PairingInstructions:
    pairing_id: str
    polling_secret: str
    user_code: str
    verification_uri: str
    expires_at: str


@dataclass(frozen=True, slots=True)
class Lease:
    lease_id: str
    fence: int
    job_payload: dict[str, Any]


class _ScopedRedirect(urllib.request.HTTPRedirectHandler):
    """Allow only the API origin or configured object-storage origins."""

    def __init__(self, allowed_hosts: set[str]) -> None:
        super().__init__()
        self.allowed_hosts = allowed_hosts

    def redirect_request(self, request, file, code, message, headers, new_url):
        old = urllib.parse.urlsplit(request.full_url)
        new = urllib.parse.urlsplit(new_url)
        same_api_origin = old.scheme == new.scheme and old.hostname and new.hostname and old.hostname.lower() == new.hostname.lower() and old.port == new.port
        permitted_host = bool(new.hostname and new.hostname.lower() in self.allowed_hosts)
        if new.scheme != "https" and new.hostname not in {"localhost", "127.0.0.1", "::1"}:
            print(f"asset_redirect_blocked scheme={new.scheme} host={new.hostname or 'unknown'}", flush=True)
            return None
        if not same_api_origin and not permitted_host:
            print(f"asset_redirect_blocked scheme={new.scheme} host={new.hostname or 'unknown'}", flush=True)
            return None
        copied = dict(request.headers)
        copied_unredirected = dict(request.unredirected_hdrs)
        if not same_api_origin:
            for name in ("Authorization", "Cookie", "X-Worker-Key", "Proxy-Authorization"):
                for mapping in (copied, copied_unredirected):
                    for key in tuple(mapping):
                        if key.lower() == name.lower():
                            mapping.pop(key, None)
        redirected = urllib.request.Request(
            new_url,
            data=request.data if code in (307, 308) else None,
            headers=copied,
            origin_req_host=request.origin_req_host,
            unverifiable=True,
            method=request.method if code in (307, 308) else None,
        )
        for name, value in copied_unredirected.items():
            redirected.add_unredirected_header(name, value)
        return redirected


class WorkerApi:
    def __init__(self, config: WorkerConfig) -> None:
        self.config = config
        self.token = config.worker_key
        self.user_agent = "SlopTogether-Worker/0.1"
        self.context = ssl.create_default_context()
        api_host = urllib.parse.urlsplit(config.api_base_url).hostname
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=self.context),
            _ScopedRedirect(set(config.allowed_upload_hosts) | ({api_host.lower()} if api_host else set())),
        )

    def _url(self, path: str, query: dict[str, str] | None = None) -> str:
        if not path.startswith("/") or path.startswith("//"):
            raise WorkerError("invalid_api_path", "Worker service path is invalid.")
        url = f"{self.config.api_base_url}{path}"
        if query:
            url += "?" + urllib.parse.urlencode(query)
        return url

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: object | None = None,
        headers: dict[str, str] | None = None,
        query: dict[str, str] | None = None,
        timeout: int | None = None,
        authorized: bool = True,
    ) -> tuple[dict[str, Any], dict[str, str]]:
        request_headers = {"Accept": "application/json", "User-Agent": self.user_agent}
        if body is not None:
            request_headers["Content-Type"] = "application/json"
        if authorized:
            if not self.token:
                raise WorkerError("worker_pairing_required", "Connect this worker to Twitch before claiming work.")
            request_headers["Authorization"] = f"SlopWorker {self.token}"
        if headers:
            request_headers.update(headers)
        payload = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(self._url(path, query), data=payload, headers=request_headers, method=method)
        try:
            with self.opener.open(request, timeout=timeout or self.config.request_timeout_seconds) as response:
                data = response.read(4 * 1024 * 1024 + 1)
                if len(data) > 4 * 1024 * 1024:
                    raise WorkerError("api_response_too_large", "Worker service returned an oversized response.")
                parsed: object = json.loads(data.decode("utf-8")) if data else {}
                if not isinstance(parsed, dict):
                    raise WorkerError("api_response_invalid", "Worker service response was invalid.")
                return parsed, {key.lower(): value for key, value in response.headers.items()}
        except urllib.error.HTTPError as error:
            code = "request_rejected"
            try:
                parsed = json.loads(error.read(32_768).decode("utf-8"))
                if isinstance(parsed, dict):
                    value = parsed.get("code") if isinstance(parsed.get("code"), str) else parsed.get("error")
                    if isinstance(value, str) and value:
                        code = value[:100]
            except (json.JSONDecodeError, UnicodeDecodeError):
                pass
            raise ApiError(error.code, code) from None
        except (urllib.error.URLError, TimeoutError, ssl.SSLError) as error:
            raise WorkerError("service_unreachable", f"SlopTogether service is temporarily unreachable ({type(error).__name__}).") from None
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise WorkerError("api_response_invalid", "Worker service returned invalid JSON.") from None

    def create_pairing(self, device: dict[str, Any]) -> PairingInstructions:
        result, _ = self._request("POST", "/workers/pairings", body=device, authorized=False)
        return PairingInstructions(
            pairing_id=_text(result, "pairingId"),
            polling_secret=_text(result, "pollSecret"),
            user_code=_text(result, "userCode"),
            verification_uri=_text(result, "verificationUri"),
            expires_at=_text(result, "expiresAt"),
        )

    def poll_pairing(self, pairing: PairingInstructions) -> str | None:
        result, _ = self._request(
            "POST",
            f"/workers/pairings/{urllib.parse.quote(pairing.pairing_id, safe='')}/poll",
            body={"pollSecret": pairing.polling_secret},
            authorized=False,
        )
        if result.get("status") == "approved" and isinstance(result.get("workerKey"), str):
            return result["workerKey"]
        if result.get("status") in {"expired", "revoked", "denied"}:
            raise WorkerError("pairing_not_available", "Twitch device pairing expired or was denied.")
        return None

    def claim(self) -> Lease | None:
        query = {"role": self.config.role}
        if self.config.channel_id:
            query["channelId"] = self.config.channel_id
        result, _ = self._request("POST", "/workers/leases", body={}, query=query)
        if result.get("status") == "empty":
            return None
        raw_job = result.get("job")
        lease_id = result.get("leaseId")
        fence = result.get("fence")
        if not isinstance(raw_job, dict):
            raise WorkerError("lease_response_invalid", "Worker service returned an invalid job lease.")
        if not isinstance(lease_id, str):
            raise WorkerError("lease_response_invalid", "Worker service returned no lease identity.")
        if type(fence) is not int or fence < 1:
            raise WorkerError("lease_response_invalid", "Worker service returned an invalid lease fence.")
        job = dict(raw_job)
        job["leaseId"] = lease_id
        job["fence"] = fence
        if isinstance(result.get("attemptDeadlineAt"), str):
            job["attemptDeadlineAt"] = result["attemptDeadlineAt"]
        return Lease(lease_id=lease_id, fence=fence, job_payload=job)

    def heartbeat(self, lease: Lease, *, phase: str, progress: float) -> dict[str, Any]:
        if phase not in {"starting", "running", "uploading", "validating"} or not 0 <= progress <= 1:
            raise WorkerError("heartbeat_invalid", "Worker progress is invalid.")
        result, _ = self._request(
            "POST",
            f"/workers/leases/{urllib.parse.quote(lease.lease_id, safe='')}/heartbeat",
            body={"leaseId": lease.lease_id, "fence": lease.fence, "phase": phase, "progress": round(progress, 4)},
        )
        return result

    def issue_upload(self, lease: Lease, *, content_type: str, file_name: str, byte_size: int, sha256: str) -> dict[str, Any]:
        body = {"fence": lease.fence, "contentType": content_type, "fileName": file_name, "byteSize": byte_size, "sha256": sha256}
        result, _ = self._request("POST", f"/workers/leases/{urllib.parse.quote(lease.lease_id, safe='')}/uploads", body=body)
        return result

    def upload_file(self, reservation: dict[str, Any], path: str, max_bytes: int) -> None:
        upload_url = _text(reservation, "uploadUrl")
        method = reservation.get("method")
        expiry = reservation.get("expiresAt")
        allowed = reservation.get("requiredHeaders", {})
        if method != "PUT" or not isinstance(expiry, str) or not isinstance(allowed, dict):
            raise WorkerError("upload_ticket_invalid", "Upload authorization is invalid.")
        parsed = urllib.parse.urlsplit(upload_url)
        local_s3_upload=bool(self.config.local_s3_endpoint and f"{parsed.scheme}://{parsed.netloc}"==self.config.local_s3_endpoint)
        if not parsed.hostname or not ((parsed.scheme=="https" and parsed.hostname.lower() in self.config.allowed_upload_hosts) or local_s3_upload):
            raise WorkerError("upload_origin_not_allowed", "Upload destination is not on the configured allowlist.")
        with open(path, "rb") as source:
            body = source.read(max_bytes + 1)
        if not body or len(body) > max_bytes:
            raise WorkerError("upload_size_out_of_range", "Worker output exceeds its configured size bound.")
        allowed_headers: dict[str, str] = {}
        for name, value in allowed.items():
            if not isinstance(name, str) or not isinstance(value, str):
                raise WorkerError("upload_headers_invalid", "Upload headers are invalid.")
            lowered = name.lower()
            if lowered != "content-type" and not lowered.startswith("x-amz-"):
                raise WorkerError("upload_header_not_allowed", "Upload requested an unsupported header.")
            allowed_headers[name] = value
        request = urllib.request.Request(upload_url, data=body, headers=allowed_headers, method="PUT")
        try:
            with self.opener.open(request, timeout=self.config.request_timeout_seconds) as response:
                if response.status < 200 or response.status >= 300:
                    raise WorkerError("upload_failed", "Cloudflare upload was rejected.")
        except urllib.error.HTTPError as error:
            raise ApiError(error.code, "cloud_upload_failed") from None
        except urllib.error.URLError as error:
            raise WorkerError("upload_unreachable", f"Cloudflare upload failed ({type(error.reason).__name__}).") from None

    def complete_upload(self, reservation_id: str, lease: Lease, sha256: str) -> dict[str, Any]:
        result, _ = self._request(
            "POST",
            f"/workers/uploads/{urllib.parse.quote(reservation_id, safe='')}/complete",
            body={"fence": lease.fence, "sha256": sha256},
        )
        return result

    def record_provider_request(self, lease: Lease, provider_request_id: str) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/workers/leases/{urllib.parse.quote(lease.lease_id, safe='')}/provider-request",
            body={"fence": lease.fence, "providerRequestId": provider_request_id},
        )[0]

    def fail_attempt(self, lease: Lease, code: str) -> None:
        try:
            self._request(
                "POST",
                f"/workers/leases/{urllib.parse.quote(lease.lease_id, safe='')}/fail",
                body={"fence": lease.fence, "errorCode": code[:80]},
            )
        except WorkerError as error:
            if getattr(error, "status", None) not in {404, 405, 409}:
                raise

    def acquire_story_producer(self, channel_id: str) -> dict[str, Any] | None:
        if not channel_id or len(channel_id) > 32:
            raise WorkerError("story_channel_invalid", "Select the Twitch channel authorized for this story key.")
        result, _ = self._request(
            "POST",
            f"/channels/{urllib.parse.quote(channel_id, safe='')}/story-producer/leases",
            body={"clientId": self.user_agent},
        )
        if result.get("status") == "empty":
            return None
        # The service may return the lease object directly or wrap it. Accept
        # both wire representations while the route adapter settles, but keep
        # the producer's required fields strict in StoryProducer.run_once.
        lease = result.get("lease", result)
        if not isinstance(lease, dict):
            raise WorkerError("story_lease_invalid", "Story service returned an invalid producer lease.")
        return lease

    def submit_story_proposal(self, channel_id: str, proposal: dict[str, Any]) -> dict[str, Any]:
        result, _ = self._request(
            "POST",
            f"/channels/{urllib.parse.quote(channel_id, safe='')}/story-proposals",
            body=proposal,
        )
        return result

    def download_asset(self, lease: Lease, asset_id: str, destination: str, max_bytes: int) -> None:
        path = f"/workers/leases/{urllib.parse.quote(lease.lease_id, safe='')}/asset/{urllib.parse.quote(asset_id, safe='')}"
        request = urllib.request.Request(self._url(path), headers={"Authorization": f"Bearer {self.token}", "X-Lease-Fence": str(lease.fence), "User-Agent": self.user_agent})
        try:
            with self.opener.open(request, timeout=self.config.request_timeout_seconds) as response:
                claimed_length = response.headers.get("Content-Length")
                if claimed_length and (not claimed_length.isdigit() or int(claimed_length) > max_bytes):
                    raise WorkerError("asset_size_out_of_range", "Source asset exceeds its authorized size bound.")
                total = 0
                with open(destination, "xb") as output:
                    while chunk := response.read(256 * 1024):
                        total += len(chunk)
                        if total > max_bytes:
                            raise WorkerError("asset_size_out_of_range", "Source asset exceeds its authorized size bound.")
                        output.write(chunk)
        except urllib.error.HTTPError as error:
            host = urllib.parse.urlsplit(error.geturl()).hostname or "unknown"
            body = error.read(2048)
            provider_code = re.search(rb"<Code>([^<]{1,80})</Code>", body)
            code = _safe_error_code(provider_code.group(1).decode("ascii", "replace")) if provider_code else "unknown"
            content_type = error.headers.get_content_type() if error.headers else "unknown"
            response_headers = error.headers or {}
            api = urllib.parse.urlsplit(self.config.api_base_url)
            response_url = urllib.parse.urlsplit(error.geturl())
            api_response = host.lower() == (api.hostname or "").lower() and response_url.scheme.lower() == api.scheme.lower()
            if api_response:
                try:
                    parsed = json.loads(body.decode("utf-8"))
                    value = parsed.get("code", parsed.get("error")) if isinstance(parsed, dict) else None
                    if isinstance(value, str) and value:
                        code = _safe_error_code(value)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    pass
            markers = [marker for marker, needle in (("html", b"<html"), ("access_denied", b"access denied"), ("forbidden", b"forbidden"), ("signature", b"signature"), ("expired", b"expired"), ("cloudflare_challenge", b"challenge")) if needle in body.lower()]
            cf_ray = re.sub(r"[^A-Za-z0-9-]", "", response_headers.get("cf-ray", ""))[:80]
            server = re.sub(r"[^A-Za-z0-9 ._-]", "", response_headers.get("server", ""))[:80]
            request_id = re.sub(r"[^A-Za-z0-9._-]", "", response_headers.get("x-amz-request-id", ""))[:80]
            body_hash = hashlib.sha256(body).hexdigest()[:16]
            print(f"asset_download_http_error status={error.code} response_host={host} api_response={str(api_response).lower()} provider_code={code} content_type={content_type} body_bytes={len(body)} body_sha256_prefix={body_hash} body_markers={','.join(markers) or 'none'} server={server or 'none'} cf_ray={cf_ray or 'none'} storage_request_id={request_id or 'none'}", flush=True)
            if api_response:
                raise ApiError(error.code, code if code != "unknown" else "asset_download_failed") from None
            category = "asset_storage_forbidden" if error.code == 403 else "asset_storage_unauthorized" if error.code == 401 else "asset_storage_http_error"
            raise WorkerError(category, f"Private source asset storage rejected the worker request ({error.code}).") from None
        except urllib.error.URLError as error:
            print(f"asset_download_transport_error reason={type(error.reason).__name__}", flush=True)
            raise WorkerError("asset_download_failed", f"Source asset download failed ({type(error.reason).__name__}).") from None
        if total == 0:
            from pathlib import Path
            Path(destination).unlink(missing_ok=True)
            raise WorkerError("asset_size_out_of_range", "Source asset is empty or exceeds its configured size bound.")


def _safe_error_code(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.:-]", "_", value)[:100] or "unknown"


def _text(value: dict[str, Any], key: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result or len(result) > 4096:
        raise WorkerError("api_response_invalid", "Worker service returned invalid response data.")
    return result
