from __future__ import annotations

import hashlib
import os
from pathlib import Path

from sloptogether_worker.client import WorkerApi
from sloptogether_worker.config import WorkerConfig


source=Path(os.environ.get("FAL_SMOKE_VIDEO","/tmp/sloptogether-fal-test/sloptogether-fal-smoke.mp4"))
if not source.is_file():
    raise SystemExit("Fal smoke MP4 is missing; run the one-shot Fal smoke first.")
config=WorkerConfig.from_sources(config_path=None,role_override="generation")
api=WorkerApi(config)
lease=api.claim()
if lease is None:
    raise SystemExit("No local demo generation job is ready.")
data=source.read_bytes()
digest=hashlib.sha256(data).hexdigest()
reservation=api.issue_upload(lease,content_type="video/mp4",file_name="fal-smoke.mp4",byte_size=len(data),sha256=digest)
api.upload_file(reservation,str(source),config.max_output_bytes)
result=api.complete_upload(reservation["uploadId"],lease,digest)
print({"accepted":result.get("accepted"),"artifactId":result.get("artifactId"),"approvalPath":result.get("approvalPath"),"bytes":len(data)})
