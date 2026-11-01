"""Persistent FastVideo P36 decoder worker, isolated from Comfy's Python runtime.

The caller owns the exchange directory and the worker process. Protocol messages
are newline-delimited JSON; model loading and library diagnostics go to stderr.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Protocol, cast

import torch
from safetensors.torch import load_file, save_file

ROOT = Path('/data/fasth3-nvfp4-vae')
REPOSITORY = Path('/opt/FastVideo')
RUNNER = REPOSITORY / 'scripts/benchmarks/minimax_h3_vae/bench_decoder.py'
ATTESTATION = ROOT / 'comfystream-p36-attestation.json'
COMMIT = '38fe94d82b84fb142464e90918f850239430457d'
RUNNER_SHA256 = 'd7b9b129c985bb4f38b3e3674df3f12344a455b8d90184cc9eba7c86a5f1c2b5'
SOURCE_SHA256 = '84a92170f1cf6737f0509f8350cf642832afe3c0c0b1766bf4a0e6e820b62729'
FULL_REVISION = '42ed227ee7df40d41602854ae760620d6eb651fe'
DECODER_REVISION = 'ddd17469cab7e490b1a04baaf26b247f0f0dcf0e'
FULL_FILES = frozenset({'config.json', 'diffusion_pytorch_model.safetensors.index.json',
                        *(f'diffusion_pytorch_model-{i:05}-of-00003.safetensors' for i in (1, 2, 3))})
HEX = re.compile(r'[0-9a-f]{64}\Z')
REQUEST_ID = re.compile(r'[A-Za-z0-9_-]{1,80}\Z')
MEAN = [0.858090341091156, -0.9606591463088989, 1.0661640167236328, -0.5090325474739075,
        -0.2727581858634949, -1.3675414323806763, -0.2553254961967468, -0.26907554268836975,
        -0.5376840829849243, -0.0464097298681736, 0.6657370328903198, 0.19690127670764923,
        -0.5460608005523682, -0.4035342037677765, -0.23683024942874908, 0.25928452610969543,
        -0.30133944749832153, 0.211341992020607, -1.1206848621368408, 0.3581933379173279,
        -0.04225143790245056, 0.2604829967021942, 0.22864092886447906, 0.7056031823158264]
STD = [1.2223774194717407, 1.2767263650894165, 1.68317747116088865, 1.7549455165863037,
       1.5636216402053833, 2.194143533706665, 0.96531379222869875, 1.05698859691619875,
       0.841948926448822, 0.7729952931404114, 1.8955937623977661, 0.946841835975647,
       0.7996809482574463, 0.44988900423049925, 0.7197399735450745, 0.69362932443618775,
       2.961095094680786, 2.7694199085235595, 3.0496184825897215, 2.1088054180145265,
       3.276226282119751, 3.1627357006073, 2.28168129920959475, 2.6127843856811525]


def digest(path: Path) -> str:
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def verified_assets(root: Path = ROOT, runner: Path = RUNNER,
                    attestation: Path = ATTESTATION, repository: Path = REPOSITORY) -> None:
    """Verify pinned sources and immutable artifacts before unpickling weights."""
    data = json.loads(attestation.read_text(encoding='utf-8'))
    expected = {'schema': 'comfystream-h3-p36-assets/1', 'fastvideo_commit': COMMIT,
                'fastvideo_runner_sha256': RUNNER_SHA256, 'full_vae_revision': FULL_REVISION,
                'decoder_revision': DECODER_REVISION, 'quality_source_sha256': SOURCE_SHA256}
    if any(data.get(key) != value for key, value in expected.items()):
        raise ValueError('P36 asset attestation identity mismatch')
    revision = subprocess.run(['git', '-C', str(repository), 'rev-parse', 'HEAD'],
                              check=True, capture_output=True, text=True, timeout=10).stdout.strip()
    if revision != COMMIT or digest(runner) != RUNNER_SHA256:
        raise ValueError('P36 FastVideo revision or runner mismatch')
    files = data.get('full_snapshot_file_sha256')
    if not isinstance(files, dict) or set(files) != FULL_FILES:
        raise ValueError('P36 full VAE snapshot is incomplete')
    for name, expected_sha in files.items():
        path = root / 'full/vae' / name
        if not isinstance(expected_sha, str) or not HEX.fullmatch(expected_sha) or path.is_symlink() or digest(path) != expected_sha:
            raise ValueError(f'P36 full VAE snapshot hash mismatch: {name}')
    for path, expected_sha in ((root / 'quality-36L.pt', data.get('quality_converted_sha256')),
                               (root / 'decoder/quality-36L/decoder-nvfp4.safetensors', SOURCE_SHA256)):
        if not isinstance(expected_sha, str) or not HEX.fullmatch(expected_sha) or path.is_symlink() or digest(path) != expected_sha:
            raise ValueError(f'P36 decoder hash mismatch: {path.name}')


class VAE(Protocol):
    latents_mean: torch.Tensor
    latents_std: torch.Tensor
    tile_sample_min_overlap_height: int
    tile_sample_min_overlap_width: int

    def decode(self, raw: torch.Tensor, *, return_dict: bool) -> tuple[torch.Tensor, ...]: ...

    def denormalize_pixels(self, pixels: torch.Tensor) -> torch.Tensor: ...


class P36Decoder:
    """Own one loaded P36 VAE for the lifetime of a worker."""

    def __init__(self, vae: VAE, device: torch.device,
                 grid_tiles: Callable[[VAE, torch.Size], int]) -> None:
        self.vae, self.device, self.grid_tiles = vae, device, grid_tiles
        if not torch.equal(vae.latents_mean.detach().float().view(-1).cpu(), torch.tensor(MEAN)):
            raise ValueError('P36 latent mean differs from pinned Comfy H3')
        if not torch.equal(vae.latents_std.detach().float().view(-1).cpu(), torch.tensor(STD)):
            raise ValueError('P36 latent standard deviation differs from pinned Comfy H3')
        vae.tile_sample_min_overlap_height = 64
        vae.tile_sample_min_overlap_width = 64

    def decode(self, latent: torch.Tensor, dtype_name: str, expected_frames: int) -> torch.Tensor:
        dtypes = {'torch.float16': torch.float16, 'torch.bfloat16': torch.bfloat16,
                  'torch.float32': torch.float32}
        if dtype_name not in dtypes:
            raise ValueError('unsupported Comfy VAE input dtype')
        if (latent.ndim != 5 or latent.shape[0] != 1 or latent.shape[1] != 24
                or any(value <= 0 for value in latent.shape) or not latent.is_floating_point()
                or not bool(torch.isfinite(latent).all())):
            raise ValueError('P36 input must be a finite single-batch normalized H3 latent')
        if not isinstance(expected_frames, int) or isinstance(expected_frames, bool) or expected_frames < 1:
            raise ValueError('expected_frames must be a positive integer')
        os.environ['FASTVIDEO_H3_VAE_TILE_BATCH'] = str(self.grid_tiles(self.vae, latent.shape))
        normalized = latent.to(device=self.device, dtype=dtypes[dtype_name])
        raw = (normalized * self.vae.latents_std.to(normalized)
               + self.vae.latents_mean.to(normalized)).float()
        with torch.no_grad(), torch.autocast(device_type='cuda', dtype=torch.bfloat16,
                                             enabled=self.device.type == 'cuda'):
            sample = self.vae.decode(raw, return_dict=False)[0]
        pixels = self.vae.denormalize_pixels(sample.float()).clamp_(0, 1)
        if (pixels.ndim != 5 or tuple(pixels.shape[:3]) != (1, 3, expected_frames)
                or tuple(pixels.shape[-2:]) != (latent.shape[-2] * 16, latent.shape[-1] * 16)
                or not bool(torch.isfinite(pixels).all())):
            raise ValueError('P36 output has invalid shape or values')
        return pixels.to(device='cpu', dtype=torch.float32).contiguous()


def load_decoder() -> P36Decoder:
    verified_assets()
    if not torch.cuda.is_available() or torch.cuda.device_count() != 1 or torch.cuda.get_device_capability()[0] != 12:
        raise RuntimeError('P36 requires one visible Blackwell CUDA GPU')
    spec = importlib.util.spec_from_file_location('comfystream_p36_fastvideo_runner', RUNNER)
    if spec is None or spec.loader is None:
        raise RuntimeError('P36 FastVideo benchmark loader is unavailable')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    args = SimpleNamespace(full_vae_dir=str(ROOT / 'full/vae'), light_vae_dir=None, latents=None,
                           checkpoint=[f'full_nvfp4_unit={ROOT / "quality-36L.pt"}'], nvfp4_checkpoint=None)
    device = torch.device('cuda:0')
    vae, autocast = module.build_variant('full_nvfp4_unit', args, device, {})
    if autocast != torch.bfloat16:
        raise RuntimeError('P36 benchmark autocast differs from expected BF16')
    return P36Decoder(cast(VAE, vae), device, cast(Callable[[VAE, torch.Size], int], module.grid_tiles))


def exchange_path(directory: Path, raw: object, *, exists: bool) -> Path:
    if not isinstance(raw, str):
        raise TypeError('exchange paths must be strings')
    path = Path(raw)
    if not path.is_absolute() or path.parent.resolve() != directory or path.is_symlink():
        raise ValueError('exchange paths must be regular files directly inside the owned directory')
    if exists != path.is_file() or (not exists and path.exists()):
        raise ValueError('exchange input missing or output already exists')
    return path


def execute(decoder: P36Decoder, directory: Path, request: dict[str, object]) -> dict[str, object]:
    identity = request.get('id')
    if not isinstance(identity, str) or not REQUEST_ID.fullmatch(identity):
        raise ValueError('invalid request id')
    source = exchange_path(directory, request.get('input'), exists=True)
    output = exchange_path(directory, request.get('output'), exists=False)
    expected = request.get('input_sha256')
    if not isinstance(expected, str) or not HEX.fullmatch(expected) or digest(source) != expected:
        raise ValueError('input latent SHA-256 mismatch')
    tensors = load_file(str(source), device='cpu')
    if set(tensors) != {'latent'}:
        raise ValueError('expected exactly one input latent tensor')
    input_dtype, frames = request.get('vae_input_dtype'), request.get('expected_frames')
    if not isinstance(input_dtype, str) or not isinstance(frames, int) or isinstance(frames, bool):
        raise TypeError('VAE input dtype and expected frame count are required')
    pixels = decoder.decode(tensors['latent'], input_dtype, frames)
    save_file({'pixels': pixels}, str(output), metadata={'layout': 'NCTHW', 'domain': 'RGB01'})
    return {'id': identity, 'status': 'ok', 'output_sha256': digest(output), 'shape': list(pixels.shape)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exchange-dir', type=Path, required=True)
    args = parser.parse_args()
    if args.exchange_dir.is_symlink() or not args.exchange_dir.is_dir():
        raise ValueError('exchange directory must be an existing non-symlink directory')
    directory = args.exchange_dir.resolve(strict=True)
    # Python and native library output must not corrupt the JSON protocol.
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), 'w', buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    with contextlib.redirect_stdout(sys.stderr):
        decoder = load_decoder()
        print(json.dumps({'status': 'ready', 'protocol': 'comfystream-h3-p36/1'}), file=protocol, flush=True)
        for line in sys.stdin:
            identity: object = None
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise TypeError('request must be an object')
                identity = request.get('id')
                if request.get('op') == 'shutdown':
                    print(json.dumps({'id': identity, 'status': 'stopped'}), file=protocol, flush=True)
                    return
                if request.get('op') != 'decode':
                    raise ValueError('unknown worker operation')
                response = execute(decoder, directory, request)
            except Exception as error:  # noqa: BLE001 - isolate each protocol request
                response = {'id': identity, 'status': 'error', 'error': f'{type(error).__name__}: {error}'}
            print(json.dumps(response), file=protocol, flush=True)


if __name__ == '__main__':
    main()
