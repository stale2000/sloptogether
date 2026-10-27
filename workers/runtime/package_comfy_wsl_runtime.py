from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

WORKER_ROOT=Path(__file__).resolve().parent
REPO_ROOT=WORKER_ROOT.parents[1]
SOURCE_ROOT=REPO_ROOT/"vendor"/"comfystream"/"runtime"
ASSEMBLER=SOURCE_ROOT/"scripts"/"assemble_worker_artifact.py"


def package_runtime(output:Path)->tuple[Path,str]:
    output=output.resolve()
    if output.is_symlink():
        raise ValueError("comfy_runtime_output_invalid")
    output.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="sloptogether-comfy-runtime-") as folder:
        artifact=Path(folder)/"runtime"
        subprocess.run([sys.executable,"-B",str(ASSEMBLER),"--profile","vast","--destination",str(artifact)],
            cwd=REPO_ROOT,check=True,capture_output=True,text=True)
        subprocess.run([sys.executable,"-B",str(ASSEMBLER),"--profile","vast","--destination",str(artifact),"--check"],
            cwd=REPO_ROOT,check=True,capture_output=True,text=True)
        manifest=json.loads((artifact/"worker-manifest.json").read_text(encoding="utf-8"))
        paths=sorted(path for path in artifact.rglob("*") if path.is_file())
        if not paths or any(path.is_symlink() for path in paths):
            raise ValueError("comfy_runtime_artifact_invalid")
        model_files=[path for path in paths if path.suffix.lower() in {".safetensors",".ckpt",".pt",".pth"}]
        if model_files:
            raise ValueError("comfy_runtime_artifact_must_not_bundle_weights")
        descriptor,tmp_name=tempfile.mkstemp(prefix=f".{output.name}.",suffix=".tmp",dir=output.parent)
        os.close(descriptor)
        tmp=Path(tmp_name)
        try:
            with zipfile.ZipFile(tmp,"w",compression=zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
                for path in paths:
                    relative=path.relative_to(artifact).as_posix()
                    info=zipfile.ZipInfo(relative,date_time=(2020,1,1,0,0,0))
                    info.compress_type=zipfile.ZIP_DEFLATED
                    executable=bool(manifest.get("files",{}).get(relative,{}).get("executable",False))
                    info.external_attr=((0o100755 if executable else 0o100644)&0xFFFF)<<16
                    archive.writestr(info,path.read_bytes())
            tmp.replace(output)
        finally:
            tmp.unlink(missing_ok=True)
    digest=hashlib.sha256(output.read_bytes()).hexdigest()
    return output,digest


def main()->int:
    parser=argparse.ArgumentParser(description="Package the pinned, weight-free ComfyStreamer WSL runtime.")
    parser.add_argument("--output",type=Path,default=WORKER_ROOT/"dist"/"ComfyStreamer-Wsl-runtime.zip")
    args=parser.parse_args()
    try:
        path,digest=package_runtime(args.output)
    except (OSError,subprocess.CalledProcessError,ValueError) as error:
        parser.error(str(error))
    print(f"ComfyStreamer WSL runtime: {path}")
    print(f"Runtime archive SHA-256: {digest}")
    return 0


if __name__=="__main__":
    raise SystemExit(main())
