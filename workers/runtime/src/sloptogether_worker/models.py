from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

Role = Literal["generation", "upscale", "story-producer"]


@dataclass(frozen=True, slots=True)
class WorkerJob:
    job_id: str
    lease_id: str
    channel_id: str
    stage: str
    kind: str | None
    require_audio: bool
    execution_mode: str
    recipe_id: str
    recipe_sha256: str
    input_sha256: str
    attempt_id: str
    fence: int
    attempt_deadline_at: datetime
    segment_revision_id: str | None
    prompt: str
    start_frame_asset_id: str | None
    end_frame_asset_id: str | None
    requested_end_boundary_revision_id: str | None
    endpoint_resolution_id: str | None
    width: int
    height: int
    fps_num: int
    fps_den: int
    frame_count: int
    source_asset_id: str | None
    output_width: int = 1280
    output_height: int = 720

    @classmethod
    def from_payload(cls, data: object) -> WorkerJob:
        if not isinstance(data, dict):
            raise ValueError("worker_job_invalid")

        def string(name: str, *, optional: bool = False, default: str | None = None) -> str | None:
            value = data.get(name, default)
            if optional and value is None:
                return None
            if not isinstance(value, str) or not value or len(value) > 12_000:
                raise ValueError(f"worker_job_{name}_invalid")
            return value

        def integer(name: str, minimum: int, maximum: int) -> int:
            value = data.get(name)
            if type(value) is not int or not minimum <= value <= maximum:
                raise ValueError(f"worker_job_{name}_invalid")
            return value

        deadline = string("attemptDeadlineAt")
        assert deadline is not None
        parsed_deadline = datetime.fromisoformat(deadline.replace("Z", "+00:00"))
        if parsed_deadline.tzinfo is None:
            raise ValueError("worker_job_deadline_timezone_required")
        stage = string("stage")
        if stage not in ("generation", "upscale", "story_plan"):
            raise ValueError("worker_job_stage_unsupported")
        execution_mode = string("executionMode")
        if execution_mode != "pull_worker":
            raise ValueError("worker_job_not_assigned_to_pull_worker")
        recipe_sha = string("recipeSha256")
        input_sha = string("inputSha256")
        for name, value in (("recipe", recipe_sha), ("input", input_sha)):
            if value is None or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
                raise ValueError(f"worker_job_{name}_digest_invalid")
        attempt = data.get("attemptId")
        fence = data.get("fence")
        if not isinstance(attempt, str) or not attempt or type(fence) is not int or fence < 1:
            raise ValueError("worker_job_lease_invalid")
        require_audio = data.get("requireAudio", False)
        if type(require_audio) is not bool:
            raise ValueError("worker_job_require_audio_invalid")

        return cls(
            job_id=string("jobId") or "",
            lease_id=string("leaseId", optional=True) or string("jobId") or "",
            channel_id=string("channelId") or "",
            stage=stage,
            kind=string("kind", optional=True),
            require_audio=require_audio,
            execution_mode=execution_mode,
            recipe_id=string("recipeId") or "",
            recipe_sha256=recipe_sha or "",
            input_sha256=input_sha or "",
            attempt_id=attempt,
            fence=fence,
            attempt_deadline_at=parsed_deadline,
            segment_revision_id=string("segmentRevisionId", optional=True),
            prompt=string("prompt", default="") or "",
            start_frame_asset_id=string("startFrameAssetId", optional=True),
            end_frame_asset_id=string("endFrameAssetId", optional=True),
            requested_end_boundary_revision_id=string("requestedEndBoundaryRevisionId", optional=True),
            endpoint_resolution_id=string("endpointResolutionId", optional=True),
            width=integer("width", 64, 3840),
            height=integer("height", 64, 2160),
            fps_num=integer("fpsNum", 1, 120),
            fps_den=integer("fpsDen", 1, 1001),
            frame_count=integer("frameCount", 0, 5000),
            source_asset_id=string("sourceAssetId", optional=True),
            output_width=integer("outputWidth", 64, 3840) if data.get("outputWidth") is not None else integer("width", 64, 3840),
            output_height=integer("outputHeight", 64, 2160) if data.get("outputHeight") is not None else integer("height", 64, 2160),
        )

    def as_heartbeat_payload(self) -> dict[str, object]:
        return {"attemptId": self.attempt_id, "jobId": self.job_id, "fence": self.fence}
