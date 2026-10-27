"""P36 asset bootstrap fails closed and avoids unnecessary network transfers."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
import types
from pathlib import Path

import pytest

SOURCE = Path(__file__).resolve().parents[1] / 'deploy/fal/fasth3-b1/bootstrap_p36.py'
SPEC = importlib.util.spec_from_file_location('bootstrap_p36', SOURCE)
assert SPEC is not None and SPEC.loader is not None
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def setup_assets(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / 'assets'
    full = root / 'full/vae'
    full.mkdir(parents=True)
    (full / 'config.json').write_bytes(b'full-vae')
    source = root / 'decoder/quality-36L/decoder-nvfp4.safetensors'
    source.parent.mkdir(parents=True)
    source.write_bytes(b'published')
    runner = tmp_path / 'runner.py'
    runner.write_bytes(b'runner')
    monkeypatch.setattr(module, 'RUNNER', runner)
    monkeypatch.setattr(module, 'RUNNER_SHA256', sha(b'runner'))
    monkeypatch.setattr(module, 'QUALITY_SHA256', sha(b'published'))
    monkeypatch.setattr(module, 'FULL_FILES', {'config.json': sha(b'full-vae')})
    monkeypatch.setattr(module.subprocess, 'run', lambda *args, **kwargs: subprocess.CompletedProcess(
        args[0], 0, stdout=module.FASTVIDEO_COMMIT + '\n'))
    def unavailable(*args: object, **kwargs: object) -> None:
        raise AssertionError('unexpected network download')
    monkeypatch.setitem(sys.modules, 'huggingface_hub', types.SimpleNamespace(
        hf_hub_download=unavailable, snapshot_download=unavailable))
    monkeypatch.setattr(module, 'convert', lambda source, destination: destination.write_bytes(b'converted'))
    return root


def test_verified_cached_assets_are_converted_and_attested(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = setup_assets(tmp_path, monkeypatch)
    attestation = module.prepare(root)
    assert attestation['quality_source_sha256'] == sha(b'published')
    assert attestation['quality_converted_sha256'] == sha(b'converted')
    assert attestation['full_snapshot_file_sha256'] == {'config.json': sha(b'full-vae')}
    assert json.loads((root / 'comfystream-p36-attestation.json').read_text()) == attestation
    assert module.prepare(root) == attestation


def test_failed_runner_identity_invalidates_previous_attestation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = setup_assets(tmp_path, monkeypatch)
    module.prepare(root)
    module.RUNNER.write_bytes(b'tampered')
    with pytest.raises(ValueError, match='identity mismatch'):
        module.prepare(root)
    assert not (root / 'comfystream-p36-attestation.json').exists()


def test_corrupt_cached_full_vae_cannot_be_attested(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = setup_assets(tmp_path, monkeypatch)
    (root / 'full/vae/config.json').write_bytes(b'tampered')
    monkeypatch.setitem(sys.modules, 'huggingface_hub', types.SimpleNamespace(
        hf_hub_download=lambda **kwargs: None, snapshot_download=lambda **kwargs: None))
    with pytest.raises(ValueError, match='full VAE asset hash mismatch'):
        module.prepare(root)
    assert not (root / 'comfystream-p36-attestation.json').exists()


def test_corrupt_converted_checkpoint_is_rebuilt(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = setup_assets(tmp_path, monkeypatch)
    module.prepare(root)
    (root / 'quality-36L.pt').write_bytes(b'tampered')
    assert module.prepare(root)['quality_converted_sha256'] == sha(b'converted')


def test_worker_image_provisions_the_pinned_runtime_before_serving() -> None:
    root = SOURCE.parents[3]
    dockerfile = (root / 'deploy/fal/fasth3-b1/Dockerfile').read_text()
    entrypoint = (root / 'deploy/fal/fasth3-b1/entrypoint.sh').read_text()
    assert module.FASTVIDEO_COMMIT in dockerfile
    assert module.RUNNER_SHA256 in dockerfile
    assert '/opt/venv-fastvideo/bin/python' in dockerfile
    assert 'bootstrap_p36.py' in entrypoint
    assert 'torch.cuda.get_device_capability(0)[0] == 12' in entrypoint
    assert entrypoint.index('bootstrap_p36.py') < entrypoint.index('exec /opt/venv-fasth3/bin/python')
    assert 'refusing to serve with unverified assets' in entrypoint
