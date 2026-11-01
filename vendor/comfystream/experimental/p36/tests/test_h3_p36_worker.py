"""Tests for the isolated persistent P36 worker's data and identity contract."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
import torch
from safetensors.torch import load_file, save_file

PATH = Path(__file__).resolve().parents[1] / 'deploy/custom_nodes/fasth3_deploy/p36_worker.py'
SPEC = importlib.util.spec_from_file_location('p36_worker_under_test', PATH)
assert SPEC and SPEC.loader
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class FakeVAE:
    def __init__(self) -> None:
        self.latents_mean = torch.tensor(worker.MEAN).view(1, 24, 1, 1, 1)
        self.latents_std = torch.tensor(worker.STD).view(1, 24, 1, 1, 1)
        self.inputs: list[torch.Tensor] = []

    def decode(self, raw: torch.Tensor, *, return_dict: bool) -> tuple[torch.Tensor]:
        assert not return_dict
        self.inputs.append(raw.clone())
        return (torch.full((1, 3, 1, 16, 16), 0.25),)

    def denormalize_pixels(self, sample: torch.Tensor) -> torch.Tensor:
        return sample


def test_resident_model_reused_and_normalization_matches_comfy() -> None:
    vae = FakeVAE()
    decoder = worker.P36Decoder(vae, torch.device('cpu'), lambda _vae, _shape: 6)
    latent = torch.full((1, 24, 1, 1, 1), 0.33331)
    one = decoder.decode(latent, 'torch.float16', 1)
    two = decoder.decode(latent, 'torch.float16', 1)
    normalized = latent.to(torch.float16)
    expected = (normalized * vae.latents_std.to(normalized) + vae.latents_mean.to(normalized)).float()
    assert torch.equal(vae.inputs[0], expected)
    assert len(vae.inputs) == 2 and torch.equal(one, two)
    assert tuple(one.shape) == (1, 3, 1, 16, 16)


def test_invalid_latents_and_statistics_are_rejected() -> None:
    vae = FakeVAE()
    vae.latents_mean[0, 0] += 1
    with pytest.raises(ValueError, match='latent mean'):
        worker.P36Decoder(vae, torch.device('cpu'), lambda *_args: 6)
    decoder = worker.P36Decoder(FakeVAE(), torch.device('cpu'), lambda *_args: 6)
    with pytest.raises(ValueError, match='finite'):
        decoder.decode(torch.full((1, 24, 1, 1, 1), float('nan')), 'torch.float16', 1)
    with pytest.raises(ValueError, match='output'):
        decoder.decode(torch.zeros((1, 24, 1, 1, 1)), 'torch.float16', 2)


def test_loader_passes_pinned_fastvideo_build_arguments(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(worker, 'verified_assets', lambda: None)
    monkeypatch.setattr(worker.torch.cuda, 'is_available', lambda: True)
    monkeypatch.setattr(worker.torch.cuda, 'device_count', lambda: 1)
    monkeypatch.setattr(worker.torch.cuda, 'get_device_capability', lambda: (12, 0))
    seen: dict[str, object] = {}

    def build_variant(name: str, args: object, device: object, cache: object) -> tuple[FakeVAE, torch.dtype]:
        seen.update({key: getattr(args, key) for key in
                     ('full_vae_dir', 'light_vae_dir', 'latents', 'checkpoint', 'nvfp4_checkpoint')})
        assert name == 'full_nvfp4_unit' and str(device) == 'cuda:0' and cache == {}
        return FakeVAE(), torch.bfloat16

    module = SimpleNamespace(build_variant=build_variant, grid_tiles=lambda *_args: 6)
    loader = SimpleNamespace(exec_module=lambda _module: None)
    spec = SimpleNamespace(name='p36_fake_runner', loader=loader)
    monkeypatch.setattr(worker.importlib.util, 'spec_from_file_location', lambda *_args: spec)
    monkeypatch.setattr(worker.importlib.util, 'module_from_spec', lambda _spec: module)
    worker.load_decoder()
    assert seen['latents'] is None
    assert seen['checkpoint'] == [f'full_nvfp4_unit={worker.ROOT / "quality-36L.pt"}']


def test_protocol_roundtrip_checks_hash_and_paths(tmp_path: Path) -> None:
    decoder = worker.P36Decoder(FakeVAE(), torch.device('cpu'), lambda *_args: 6)
    latent_path, output_path = tmp_path / 'input.safetensors', tmp_path / 'output.safetensors'
    save_file({'latent': torch.zeros((1, 24, 1, 1, 1))}, str(latent_path))
    request = {'id': 'one', 'op': 'decode', 'input': str(latent_path), 'output': str(output_path),
               'input_sha256': worker.digest(latent_path), 'vae_input_dtype': 'torch.float16',
               'expected_frames': 1}
    result = worker.execute(decoder, tmp_path.resolve(), request)
    assert result['output_sha256'] == worker.digest(output_path)
    assert tuple(load_file(str(output_path))['pixels'].shape) == (1, 3, 1, 16, 16)
    with pytest.raises(ValueError, match='already exists'):
        worker.execute(decoder, tmp_path.resolve(), request)
    request['output'] = str(tmp_path.parent / 'escape.safetensors')
    with pytest.raises(ValueError, match='owned directory'):
        worker.execute(decoder, tmp_path.resolve(), request)
    request.update(output=str(tmp_path / 'second.safetensors'), input_sha256='0' * 64)
    with pytest.raises(ValueError, match='SHA-256'):
        worker.execute(decoder, tmp_path.resolve(), request)


def test_asset_attestation_detects_changed_checkpoint(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / 'assets'
    full = root / 'full/vae'
    full.mkdir(parents=True)
    for name in worker.FULL_FILES:
        (full / name).write_bytes(name.encode())
    source = root / 'decoder/quality-36L/decoder-nvfp4.safetensors'
    source.parent.mkdir(parents=True)
    source.write_bytes(b'source')
    checkpoint = root / 'quality-36L.pt'
    checkpoint.write_bytes(b'converted')
    runner = tmp_path / 'runner.py'
    runner.write_text('runner')
    monkeypatch.setattr(worker, 'RUNNER_SHA256', worker.digest(runner))
    monkeypatch.setattr(worker, 'SOURCE_SHA256', worker.digest(source))
    monkeypatch.setattr(worker.subprocess, 'run', lambda *_args, **_kwargs: SimpleNamespace(stdout=worker.COMMIT))
    attestation = tmp_path / 'attestation.json'
    attestation.write_text(json.dumps({'schema': 'comfystream-h3-p36-assets/1',
        'fastvideo_commit': worker.COMMIT, 'fastvideo_runner_sha256': worker.RUNNER_SHA256,
        'full_vae_revision': worker.FULL_REVISION, 'decoder_revision': worker.DECODER_REVISION,
        'quality_source_sha256': worker.SOURCE_SHA256, 'quality_converted_sha256': worker.digest(checkpoint),
        'full_snapshot_file_sha256': {name: worker.digest(full / name) for name in worker.FULL_FILES}}))
    worker.verified_assets(root, runner, attestation, tmp_path)
    checkpoint.write_bytes(b'tampered')
    with pytest.raises(ValueError, match='decoder hash mismatch'):
        worker.verified_assets(root, runner, attestation, tmp_path)
