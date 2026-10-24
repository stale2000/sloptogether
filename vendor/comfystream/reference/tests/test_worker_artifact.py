"""Offline worker assembly, drift detection, and ComfyUI identity contracts."""

from __future__ import annotations

import ast
import asyncio
import importlib.util
import json
import shutil
import subprocess
import sys
import types
from collections.abc import Callable, Coroutine
from pathlib import Path
from typing import ClassVar, Protocol

import pytest
from json_test_support import object_value, value_at

from scripts.assemble_worker_artifact import (
    ENVIRONMENT,
    IDENTITY,
    ROOT,
    artifact_inputs,
    assemble,
    check_artifact,
)


class _CompatibilityNode(Protocol):
    DESCRIPTION: ClassVar[str]

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, dict[str, object]]: ...
    def identity(self) -> tuple[str]: ...


type _RouteHandler = Callable[[object], Coroutine[object, object, dict[str, object]]]


@pytest.fixture
def source(tmp_path: Path) -> Path:
    root = tmp_path / "repository"
    files, _ = artifact_inputs(ROOT, "vast")
    for relative in files:
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / relative, target)
    return root


def test_assembly_is_deterministic_and_retains_production_dependency_closure(
    source: Path, tmp_path: Path,
) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    manifest = assemble(first, source, "vast")
    assert manifest == assemble(second, source, "vast")
    check_artifact(first, source, "vast")
    for path in first.rglob("*"):
        if path.is_file():
            assert path.read_bytes() == (second / path.relative_to(first)).read_bytes()
            assert path.stat().st_mtime == 0
    for name in ("benchmark_sampler.py", "benchmark_output.py", "benchmark.py"):
        assert (first / "deploy/custom_nodes/fasth3_deploy" / name).is_file()
    assert (first / "deploy/custom_nodes/comfystream_drama3").is_dir()
    for relative in object_value(manifest["files"]):
        path = Path(relative)
        if path.suffix != ".py":
            continue
        assert (first / path).read_bytes() == (source / path).read_bytes()
        for node in ast.walk(ast.parse((source / path).read_bytes())):
            if not isinstance(node, ast.ImportFrom) or not node.level or not node.module:
                continue
            parent = path.parent
            for _ in range(node.level - 1):
                parent = parent.parent
            module = parent.joinpath(*node.module.split("."))
            for candidate in (module.with_suffix(".py"), module / "__init__.py"):
                if (source / candidate).is_file():
                    assert (first / candidate).is_file(), (path, candidate)
    assert value_at(manifest, 'compatibility', 'generator_node') == "FastH3BenchmarkSampler"
    assert value_at(manifest, 'compatibility', 'output_node') == "FastH3BenchmarkOutput"
    assert value_at(manifest, 'compatibility', 'upscaler_node') == "ComfyStreamMiniMaxH3SoLUpscaler"
    assert value_at(manifest, 'compatibility', 'drama3_package') == "comfystream_drama3"
    assert value_at(manifest, 'assets', 'upscaler', 'MODEL_REVISION')
    assert value_at(manifest, 'assets', 'decoder', 'ARTIFACT_SHA256')


def test_asset_and_code_identities_are_separate(source: Path, tmp_path: Path) -> None:
    destination = tmp_path / "artifact"
    before = assemble(destination, source, "fasth3")
    environment = json.loads((source / ENVIRONMENT).read_text())
    environment["models"]["fixture"] = "a" * 64
    (source / ENVIRONMENT).write_text(json.dumps(environment))
    with pytest.raises(ValueError, match="stale"):
        check_artifact(destination, source, "fasth3")
    after = assemble(destination, source, "fasth3")
    assert after["code_digest"] == before["code_digest"]
    assert after["asset_digest"] != before["asset_digest"]
    sampler = source / "deploy/custom_nodes/fasth3_deploy/benchmark_sampler.py"
    sampler.write_text(sampler.read_text() + "\n# changed source\n")
    changed = assemble(destination, source, "fasth3")
    assert changed["code_digest"] != after["code_digest"]
    assert changed["asset_digest"] == after["asset_digest"]


@pytest.mark.parametrize(("profile", "host_lock"), [
    ("fasth3", "deploy/fal/fasth3-b1/requirements.lock"),
    ("h3-upscaler", "deploy/fal/h3-sol-upscaler/requirements.lock"),
])
def test_host_lock_and_comfy_snapshot_are_bound_to_worker_build(
    source: Path, profile: str, host_lock: str,
) -> None:
    files, before = artifact_inputs(source, profile)
    assert Path(host_lock) in files
    assert Path(host_lock.replace("requirements.lock", "requirements.in")) in files
    app = "fasth3-b1" if profile == "fasth3" else "h3-sol-upscaler"
    assert Path(f"deploy/fal/{app}/comfyui-requirements.txt") in files
    target = source / host_lock
    target.write_text(target.read_text() + "\n# changed lock input\n")
    _, changed = artifact_inputs(source, profile)
    assert changed["code_digest"] != before["code_digest"]


@pytest.mark.parametrize("profile", ["fasth3", "h3-upscaler"])
def test_fal_build_dockerfile_is_tracked_by_deployment_manifest_not_runtime_artifact(
    source: Path, profile: str
) -> None:
    files, _manifest = artifact_inputs(source, profile)
    app = "fasth3-b1" if profile == "fasth3" else "h3-sol-upscaler"

    assert Path(f"deploy/fal/{app}/Dockerfile") not in files
    assert Path(f"deploy/fal/{app}/requirements.lock") in files


@pytest.mark.parametrize("drift", ["content", "extra", "removed", "mode", "symlink"])
def test_freshness_fails_closed_for_staged_drift(source: Path, tmp_path: Path, drift: str) -> None:
    destination = tmp_path / "artifact"
    assemble(destination, source, "h3-upscaler")
    target = destination / "deploy/custom_nodes/comfystream_sol_refiner_h3/worker.py"
    if drift == "content":
        target.write_text("changed\n")
    elif drift == "extra":
        (destination / "extra.py").write_text("extra\n")
    elif drift == "removed":
        target.unlink()
    elif drift == "mode":
        target.chmod(0o755)
    else:
        target.unlink()
        target.symlink_to(source / "deploy/custom_nodes/comfystream_sol_refiner_h3/worker.py")
    with pytest.raises(ValueError, match="stale|symlinks"):
        check_artifact(destination, source, "h3-upscaler")


def test_assembly_excludes_weights_credentials_and_caches(source: Path, tmp_path: Path) -> None:
    node = source / "deploy/custom_nodes/fasth3_deploy"
    for name in (".env", "credentials.json", "model.safetensors", "model.pth", "cache.pyc"):
        (node / name).write_text("do not copy")
    runtime = node / ".worker"
    runtime.mkdir()
    (runtime / "secret.py").write_text("do not copy")
    manifest = assemble(tmp_path / "artifact", source, "fasth3")
    assert all(not any(word in path for word in (
        ".env", "credentials", ".safetensors", ".pth", ".pyc", ".worker/"))
        for path in object_value(manifest["files"]))


def test_assembly_rejects_symlinks_and_source_overlap(source: Path, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="overlaps"):
        assemble(source / "deploy/custom_nodes", source, "fasth3")
    node = source / "deploy/custom_nodes/fasth3_deploy"
    (node / "linked.py").symlink_to(tmp_path / "outside.py")
    with pytest.raises(ValueError, match="symlink"):
        assemble(tmp_path / "artifact", source, "fasth3")


def test_assembly_preserves_unrelated_destination(source: Path, tmp_path: Path) -> None:
    destination = tmp_path / "unrelated"
    destination.mkdir()
    sentinel = destination / "keep.txt"
    sentinel.write_text("preserve")
    with pytest.raises(ValueError, match="refusing"):
        assemble(destination, source, "fasth3")
    assert sentinel.read_text() == "preserve"


@pytest.mark.parametrize("profile", ["fasth3", "h3-upscaler", "vast"])
def test_staged_manifest_is_self_verifying_without_repository(
    source: Path, tmp_path: Path, profile: str,
) -> None:
    destination = tmp_path / "artifact"
    assemble(destination, source, profile)
    # Docker runs this exact check before dependency installation; no repository,
    # Git metadata, GPU libraries, dependency downloads, or credentials required.
    result = subprocess.run([
        sys.executable, str(destination / "scripts/assemble_worker_artifact.py"),
        "--profile", profile, "--destination", str(destination), "--check",
    ], capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr


def test_comfyui_identity_is_metadata_only_and_unassembled_is_explicit(
    source: Path, tmp_path: Path,
) -> None:
    def load(path: Path) -> type[_CompatibilityNode]:
        spec = importlib.util.spec_from_file_location("artifact_identity_test", path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        node: type[_CompatibilityNode] = module.NODE_CLASS_MAPPINGS["ComfyStreamWorkerCompatibility"]
        return node

    assert json.loads(load(source / IDENTITY / "__init__.py").DESCRIPTION)["status"] == "unassembled"
    destination = tmp_path / "artifact"
    manifest = assemble(destination, source, "h3-upscaler")
    node = load(destination / IDENTITY / "__init__.py")
    identity = json.loads(node.DESCRIPTION)
    assert node.INPUT_TYPES() == {"required": {}}
    assert node().identity() == (node.DESCRIPTION,)
    assert identity["artifact_digest"] == manifest["artifact_digest"]
    assert "generator_node" not in identity["compatibility"]


def test_targeted_docker_and_vast_profiles_consume_canonical_stage() -> None:
    for app in ("fasth3-b1", "h3-sol-upscaler"):
        dockerfile = (ROOT / "deploy/fal" / app / "Dockerfile").read_text()
        source_prefix = (
            "COPY deploy/fal/h3-sol-upscaler/context/comfystream"
            if app == "h3-sol-upscaler"
            else "COPY context/comfystream"
        )
        assert f"{source_prefix} /opt/comfystream" in dockerfile
        assert "assemble_worker_artifact.py" in dockerfile
        if app == "fasth3-b1":
            assert "--destination /tmp/comfystream-fasth3-worker-artifact" in dockerfile
            assert "mv /tmp/comfystream-fasth3-worker-artifact /opt/comfystream" in dockerfile
        else:
            assert "--destination /opt/comfystream --check" in dockerfile
        assert "COPY custom_nodes/" not in dockerfile
        assert "comfystream_worker_identity" in dockerfile
    fasth3 = (ROOT / "deploy/fal/fasth3-b1/Dockerfile").read_text()
    assert "COPY context/comfystream/deploy/fal/fasth3-b1/entrypoint.sh" in fasth3
    bootstrap = (ROOT / "scripts/vast_fasth3_bootstrap.sh").read_text()
    assert "--profile vast --destination" in bootstrap
    assert '"$worker_artifact/deploy/custom_nodes/fasth3_deploy"' in bootstrap
    assert '"$worker_artifact/deploy/custom_nodes/comfystream_sol_refiner_h3"' in bootstrap
    assert '"$worker_artifact/deploy/custom_nodes/comfystream_drama3"' in bootstrap


def test_identity_registers_on_existing_comfyui_server(
    source: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    destination = tmp_path / "artifact"
    manifest = assemble(destination, source, "h3-upscaler")
    registered: dict[str, _RouteHandler] = {}

    class Routes:
        def get(self, path: str) -> Callable[[_RouteHandler], _RouteHandler]:
            def register(handler: _RouteHandler) -> _RouteHandler:
                registered[path] = handler
                return handler
            return register

    server = types.ModuleType("server")
    server.__dict__["PromptServer"] = types.SimpleNamespace(instance=types.SimpleNamespace(routes=Routes()))
    aiohttp = types.ModuleType("aiohttp")
    aiohttp.__dict__["web"] = types.SimpleNamespace(json_response=lambda value: value)
    monkeypatch.setitem(sys.modules, "server", server)
    monkeypatch.setitem(sys.modules, "aiohttp", aiohttp)
    spec = importlib.util.spec_from_file_location(
        "comfyui_identity_routes", destination / IDENTITY / "__init__.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    response = asyncio.run(registered["/comfystream/worker_identity"](None))
    assert response["artifact_digest"] == manifest["artifact_digest"]
    assert response["runtime_instance_id"] == module.RUNTIME_INSTANCE_ID
    assert response["asset_binding"] == "declared-build-inputs"
    # Reading the identity endpoint neither changes it nor starts an inference job.
    assert asyncio.run(registered["/comfystream/worker_identity"](None)) == response
