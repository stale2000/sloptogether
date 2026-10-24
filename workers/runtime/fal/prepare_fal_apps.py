from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
VENDOR = ROOT / "vendor" / "comfystream"
RUNTIME = VENDOR / "runtime"
REFERENCE = VENDOR / "reference" / "deploy" / "fal"
IMPORT_MANIFEST = VENDOR / "import-manifest.json"
APP_CONFIG = '''[project]
name = "{name}"
version = "0.1.0"
requires-python = ">=3.12,<3.13"

[tool.fal.apps.{app}]
auth = "private"
machine_type = "GPU-RTXPRO6000"
num_gpus = 1
exposed_port = 8188
app_scale_settings = true
min_concurrency = 0
max_concurrency = 1
max_multiplexing = 1
keep_alive = 60
request_timeout = 3600
startup_timeout = 3600
private_logs = true
secrets = ["{worker_key_name}", "SLOPTOGETHER_API_BASE_URL", "SLOPTOGETHER_ALLOWED_UPLOAD_HOSTS"]

[tool.fal.apps.{app}.image]
dockerfile = "Dockerfile"
'''
RESTORE_MARKDOWN = (
    "COPY context/sloptogether-markdown /tmp/sloptogether-markdown\n"
    "RUN python3 - <<'PY'\n"
    "from pathlib import Path\n"
    "source=Path('/tmp/sloptogether-markdown')\n"
    "destination=Path('/opt/comfystream')\n"
    "for item in source.rglob('*.slopdoc'):\n"
    " target=destination/item.relative_to(source).with_suffix('')\n"
    " target.parent.mkdir(parents=True,exist_ok=True)\n"
    " target.write_bytes(item.read_bytes())\n"
    "PY\n"
)


def _replace_once(content: str, old: str, new: str, *, label: str) -> str:
    if content.count(old) != 1:
        raise ValueError(f"fal_dockerfile_anchor_invalid:{label}")
    return content.replace(old, new, 1)


def _add_fal_users(content: str, *, role: str) -> str:
    content = _replace_once(
        content,
        "ca-certificates curl ffmpeg git libgl1 libglib2.0-0 \\\n",
        "ca-certificates curl ffmpeg git libgl1 libglib2.0-0 passwd util-linux \\\n",
        label=f"{role}_user_tools",
    )
    if role == "generation":
        anchor = " && rm -rf /var/lib/apt/lists/*\n\n# The source manifest"
        writable = "/tmp/fasth3-user:/tmp/fasth3-output:/tmp/fasth3-temp:/data/.cache/huggingface:/data/torchinductor:/data/triton:/data/cuda-cache"
    else:
        anchor = " && rm -rf /var/lib/apt/lists/*\n\nCOPY context/comfystream"
        writable = "/opt/ComfyUI/user:/opt/ComfyUI/output:/opt/ComfyUI/temp:/data/.cache/huggingface:/data/torchinductor:/data/triton:/data/cuda-cache:/data/comfystream/sol-h3/nvfp4"
    setup = (
        " && rm -rf /var/lib/apt/lists/*\n\n"
        "RUN if ! getent group video >/dev/null; then groupadd --system video; fi \\\n"
        "    && groupadd --system sloptogether-media \\\n"
        "    && groupadd --system sloptogether-comfy \\\n"
        "    && groupadd --system sloptogether-worker \\\n"
        "    && useradd --system --gid sloptogether-comfy --groups sloptogether-media,video --home-dir /tmp/sloptogether-comfy-home --shell /usr/sbin/nologin sloptogether-comfy \\\n"
        "    && useradd --system --gid sloptogether-worker --groups sloptogether-media,video --home-dir /tmp/sloptogether-worker --shell /usr/sbin/nologin sloptogether-worker \\\n"
        "    && mkdir -p /tmp/sloptogether-comfy-home \\\n"
        "    && chown sloptogether-comfy:sloptogether-comfy /tmp/sloptogether-comfy-home \\\n"
        "    && chmod 0700 /tmp/sloptogether-comfy-home\n\n"
    )
    content = _replace_once(content, anchor, setup + anchor.split("\n\n", 1)[1], label=f"{role}_worker_users")
    if role == "generation":
        copy_anchor = "COPY context/comfystream/deploy/fal/fasth3-b1/entrypoint.sh /opt/fasth3-entrypoint.sh\nRUN chmod 0755 /opt/fasth3-entrypoint.sh\n"
        copy_update = (
            copy_anchor
            + "RUN python3 - <<'PY'\n"
            + "from pathlib import Path\n"
            + "path=Path('/opt/fasth3-entrypoint.sh')\n"
            + "source=path.read_text()\n"
            + "old='exec /opt/venv-fasth3/bin/python /opt/ComfyUI/main.py \\\n'\n"
            + "new='exec runuser --preserve-environment --user=sloptogether-comfy -- /opt/venv-fasth3/bin/python /opt/ComfyUI/main.py \\\n'\n"
            + "assert source.count(old)==1, 'pinned_comfy_entrypoint_changed'\n"
            + "path.write_text(source.replace(old,new,1))\n"
            + "PY\n"
        )
        content = _replace_once(content, copy_anchor, copy_update, label="generation_comfy_user")

    app_env = (
        f"ENV SLOPTOGETHER_FAL_COMFY_USER=sloptogether-comfy \\\n"
        f"    SLOPTOGETHER_FAL_WORKER_USER=sloptogether-worker \\\n"
        f"    SLOPTOGETHER_FAL_MEDIA_GROUP=sloptogether-media \\\n"
        f"    SLOPTOGETHER_COMFY_WRITABLE_DIRS={writable} \\\n"
        f"    SLOPTOGETHER_WORKER_ROLE={role}\n"
    )
    if role == "generation":
        app_env += "ENV SLOPTOGETHER_TRIM_VSA_BUDGET_POLICY=adaptive\n"
    content = _replace_once(content, f"ENV SLOPTOGETHER_WORKER_ROLE={role}\n", app_env, label=f"{role}_worker_identity_env")
    return content


def _generation_dockerfile() -> str:
    path = REFERENCE / "fasth3-b1" / "Dockerfile"
    content = path.read_text(encoding="utf-8")
    content = _replace_once(
        content,
        "COPY context/comfystream /opt/comfystream\n",
        "COPY context/comfystream /opt/comfystream\nCOPY context/sloptogether-worker /opt/sloptogether-worker\n" + RESTORE_MARKDOWN,
        label="generation_worker_context",
    )
    content = _replace_once(
        content,
        "    && /opt/venv-fasth3/bin/python -m pip check\n",
        "    && /opt/venv-fasth3/bin/python -m pip check\n"
        "RUN /opt/venv-fasth3/bin/python -m pip install --no-deps --no-build-isolation /opt/sloptogether-worker\n",
        label="generation_worker_install",
    )
    content = _replace_once(
        content,
        'CMD ["/opt/fasth3-entrypoint.sh"]',
        'ENV SLOPTOGETHER_WORKER_ROLE=generation\n'
        'CMD ["/opt/venv-fasth3/bin/sloptogether-fal-worker", "--", "/opt/fasth3-entrypoint.sh"]',
        label="generation_worker_entrypoint",
    )
    return _add_fal_users(content, role="generation")


def _upscale_dockerfile() -> str:
    path = REFERENCE / "h3-sol-upscaler" / "Dockerfile"
    content = path.read_text(encoding="utf-8")
    content = content.replace("deploy/fal/h3-sol-upscaler/context/", "context/")
    content = _replace_once(
        content,
        "COPY context/comfystream /opt/comfystream\n",
        "COPY context/comfystream /opt/comfystream\nCOPY context/sloptogether-worker /opt/sloptogether-worker\n" + RESTORE_MARKDOWN,
        label="upscale_worker_context",
    )
    content = _replace_once(
        content,
        "    bash /opt/ComfyUI/custom_nodes/comfystream_sol_refiner_h3/install_runtime.sh --build-only\n",
        "    bash /opt/ComfyUI/custom_nodes/comfystream_sol_refiner_h3/install_runtime.sh --build-only\n"
        "RUN /opt/venv-comfy/bin/python -m pip install --no-deps --no-build-isolation /opt/sloptogether-worker\n",
        label="upscale_worker_install",
    )
    content = _replace_once(
        content,
        'CMD ["/opt/venv-comfy/bin/python", "/opt/ComfyUI/main.py", "--listen", "0.0.0.0", "--port", "8188", "--disable-cuda-malloc"]',
        'ENV SLOPTOGETHER_WORKER_ROLE=upscale\n'
        'CMD ["/opt/venv-comfy/bin/sloptogether-fal-worker", "--", "/opt/venv-comfy/bin/python", "/opt/ComfyUI/main.py", "--listen", "0.0.0.0", "--port", "8188", "--disable-cuda-malloc"]',
        label="upscale_worker_entrypoint",
    )
    content = content.replace('"--disable-cuda-malloc"]', '"--disable-cuda-malloc", "--user-directory", "/opt/ComfyUI/user", "--output-directory", "/opt/ComfyUI/output", "--temp-directory", "/opt/ComfyUI/temp"]', 1)
    content = content.replace(
        'CMD ["/opt/venv-comfy/bin/sloptogether-fal-worker", "--", "/opt/venv-comfy/bin/python",',
        'CMD ["/opt/venv-comfy/bin/sloptogether-fal-worker", "--", "runuser", "--preserve-environment", "--user=sloptogether-comfy", "--", "/opt/venv-comfy/bin/python",',
        1,
    )
    return _add_fal_users(content, role="upscale")


def _file_hashes(root: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("fal_build_context_symlink_rejected")
        if path.is_file() and path.name != "source-manifest.json":
            result[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def _make_app(app_dir: Path, *, role: str, name: str, app: str, profile: str) -> None:
    app_dir.mkdir(parents=True)
    dockerfile = _generation_dockerfile() if role == "generation" else _upscale_dockerfile()
    (app_dir / "Dockerfile").write_text(dockerfile, encoding="utf-8")
    key_name = "SLOPTOGETHER_WORKER_KEY_GENERATION" if role == "generation" else "SLOPTOGETHER_WORKER_KEY_UPSCALE"
    (app_dir / "pyproject.toml").write_text(APP_CONFIG.format(name=name, app=app, worker_key_name=key_name), encoding="utf-8")
    worker_context = app_dir / "context" / "comfystream"
    subprocess_args = [sys.executable, str(RUNTIME / "scripts" / "assemble_worker_artifact.py"), "--profile", profile, "--destination", str(worker_context)]
    result = subprocess.run(subprocess_args, check=False, capture_output=True, text=True)
    if result.returncode != 0:
        raise ValueError(f"comfystream_artifact_assembly_failed:{role}")
    source_manifest = app_dir / "context" / "sloptogether-worker.manifest.json"
    helper_path = Path(__file__).with_name("prepare_fal_worker_context.py")
    spec = importlib.util.spec_from_file_location("sloptogether_fal_worker_context", helper_path)
    if not spec or not spec.loader:
        raise ValueError("fal_worker_context_helper_missing")
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    helper.stage_context(app_dir)
    markdown_context = app_dir / "context" / "sloptogether-markdown"
    markdown_context.mkdir(parents=True, exist_ok=True)
    for source in sorted(worker_context.rglob("*.md")):
        if source.is_symlink():
            raise ValueError("fal_markdown_source_symlink_rejected")
        relative = source.relative_to(worker_context)
        target = markdown_context / Path(f"{relative.as_posix()}.slopdoc")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    hashes = _file_hashes(app_dir)
    provenance = {
        "schema": "sloptogether-fal-worker-app/1",
        "app": app,
        "role": role,
        "comfystream_import_manifest_sha256": hashlib.sha256(IMPORT_MANIFEST.read_bytes()).hexdigest(),
        "files": hashes,
    }
    (app_dir / "source-manifest.json").write_text(json.dumps(provenance, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if not source_manifest.is_file():
        raise ValueError(f"fal_worker_manifest_missing:{role}")


def prepare_apps(output: Path) -> Path:
    output = output.expanduser()
    if output.is_symlink():
        raise ValueError("fal_output_directory_cannot_be_symlink")
    if output.exists() and any(output.iterdir()):
        raise ValueError("fal_output_directory_must_be_empty")
    output.mkdir(parents=True, exist_ok=True)
    staging_parent = output.parent
    with tempfile.TemporaryDirectory(prefix=".sloptogether-fal-apps-", dir=staging_parent) as temporary:
        staged_root = Path(temporary) / "apps"
        staged_root.mkdir()
        _make_app(staged_root / "generation", role="generation", name="sloptogether-h3-generation", app="sloptogether-h3-generation", profile="fasth3")
        _make_app(staged_root / "upscale", role="upscale", name="sloptogether-h3-upscale", app="sloptogether-h3-upscale", profile="h3-upscaler")
        for child in staged_root.iterdir():
            target = output / child.name
            if target.exists():
                raise ValueError(f"fal_output_target_exists:{target.name}")
            child.rename(target)
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build isolated, scale-to-zero Fal app contexts for the shared SlopTogether worker.")
    parser.add_argument("--output", type=Path, default=Path("/tmp/sloptogether-fal-apps"))
    args = parser.parse_args(argv)
    try:
        print(prepare_apps(args.output))
        return 0
    except (OSError, ValueError) as error:
        print(f"fal_app_prepare_error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
