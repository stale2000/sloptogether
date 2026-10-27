"""Download and verify the pinned P36 decoder assets before serving requests."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path('/data/fasth3-nvfp4-vae')
REPOSITORY = Path('/opt/FastVideo')
RUNNER = REPOSITORY / 'scripts/benchmarks/minimax_h3_vae/bench_decoder.py'
FASTVIDEO_COMMIT = '38fe94d82b84fb142464e90918f850239430457d'
RUNNER_SHA256 = 'd7b9b129c985bb4f38b3e3674df3f12344a455b8d90184cc9eba7c86a5f1c2b5'
FULL_REVISION = '42ed227ee7df40d41602854ae760620d6eb651fe'
DECODER_REVISION = 'ddd17469cab7e490b1a04baaf26b247f0f0dcf0e'
QUALITY_SHA256 = '84a92170f1cf6737f0509f8350cf642832afe3c0c0b1766bf4a0e6e820b62729'
FULL_FILES = {
    'config.json': '78f67deec3d63aae807f2bfe7154bc1e26f6372cb20b63265fcbae1b62bb5745',
    'diffusion_pytorch_model-00001-of-00003.safetensors': '72f4c6be84ac0674f27398cde991dd9d719762f3952c4921aa66b2ce542f6374',
    'diffusion_pytorch_model-00002-of-00003.safetensors': '2e05e8bc23fa4071043e17fd242be8acd0685e781a43987432b2eae925be4198',
    'diffusion_pytorch_model-00003-of-00003.safetensors': 'c05d6ac4b1a33de372799d708531da6320f6a3ce6d1ce6d895e770988e004a39',
    'diffusion_pytorch_model.safetensors.index.json': '15f6d44553c3c616b0dc999920aa784f92ecee7e4201f1f99ac405cfbf3061ca',
}


def digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            sha.update(chunk)
    return sha.hexdigest()


def valid(path: Path, expected: str) -> bool:
    return path.is_file() and not path.is_symlink() and digest(path) == expected


def convert(source: Path, destination: Path) -> None:
    """Convert the verified published safetensors to FastVideo's packed format."""
    import torch
    from safetensors import safe_open
    from safetensors.torch import load_file

    with safe_open(source, framework='pt', device='cpu') as reader:
        metadata = reader.metadata() or {}
    if metadata.get('format') != 'fastvideo_h3_decoder_nvfp4_packed_v1' or 'nvfp4_metadata' not in metadata:
        raise ValueError('P36 checkpoint format or metadata mismatch')
    groups: dict[str, dict[str, torch.Tensor]] = {'decoder': {}, 'post_quant_conv': {}}
    for key, value in load_file(str(source), device='cpu').items():
        for name, group in groups.items():
            prefix = f'{name}.'
            if key.startswith(prefix):
                group[key[len(prefix):]] = value
                break
        else:
            raise ValueError(f'unexpected P36 tensor: {key}')
    if not all(groups.values()):
        raise ValueError('P36 checkpoint is missing a required tensor group')
    descriptor, temp_name = tempfile.mkstemp(prefix='.p36-', suffix='.pt', dir=destination.parent)
    os.close(descriptor)
    temporary = Path(temp_name)
    try:
        torch.save({'format': metadata['format'], 'metadata': json.loads(metadata['nvfp4_metadata']), **groups}, temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def prepare(root: Path = ROOT) -> dict[str, object]:
    from huggingface_hub import hf_hub_download, snapshot_download

    if root.is_symlink():
        raise ValueError('P36 asset root cannot be a symlink')
    root.mkdir(parents=True, exist_ok=True)
    # A receipt from an earlier startup must not attest this failed startup.
    (root / 'comfystream-p36-attestation.json').unlink(missing_ok=True)
    revision = subprocess.run(['git', '-C', str(REPOSITORY), 'rev-parse', 'HEAD'],
                              capture_output=True, text=True, timeout=10, check=True).stdout.strip()
    if revision != FASTVIDEO_COMMIT or not valid(RUNNER, RUNNER_SHA256):
        raise ValueError('FastVideo source or runner identity mismatch')
    full = root / 'full' / 'vae'
    if not all(valid(full / name, sha) for name, sha in FULL_FILES.items()):
        snapshot_download(repo_id='MiniMaxAI/MiniMax-H3', revision=FULL_REVISION,
                          allow_patterns=[f'vae/{name}' for name in FULL_FILES], local_dir=root / 'full')
    for name, sha in FULL_FILES.items():
        if not valid(full / name, sha):
            raise ValueError(f'full VAE asset hash mismatch: {name}')
    source = root / 'decoder' / 'quality-36L' / 'decoder-nvfp4.safetensors'
    if not valid(source, QUALITY_SHA256):
        hf_hub_download(repo_id='FastVideo/FastH3-NVFP4-VAE-Decoder',
                        filename='quality-36L/decoder-nvfp4.safetensors',
                        revision=DECODER_REVISION, local_dir=root / 'decoder')
    if not valid(source, QUALITY_SHA256):
        raise ValueError('P36 source checkpoint SHA-256 mismatch')
    converted = root / 'quality-36L.pt'
    receipt = root / 'quality-36L.source.sha256'
    try:
        conversion = json.loads(receipt.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        conversion = {}
    if (not converted.is_file() or converted.is_symlink() or not isinstance(conversion, dict)
            or conversion.get('source_sha256') != QUALITY_SHA256
            or conversion.get('converted_sha256') != digest(converted)):
        convert(source, converted)
        conversion = {'source_sha256': QUALITY_SHA256, 'converted_sha256': digest(converted)}
        atomic_json(receipt, conversion)
    attestation: dict[str, object] = {
        'schema': 'comfystream-h3-p36-assets/1',
        'fastvideo_commit': FASTVIDEO_COMMIT, 'fastvideo_runner_sha256': RUNNER_SHA256,
        'full_vae_revision': FULL_REVISION, 'decoder_revision': DECODER_REVISION,
        'quality_source_sha256': QUALITY_SHA256,
        'quality_converted_sha256': conversion['converted_sha256'],
        'full_snapshot_file_sha256': FULL_FILES,
    }
    atomic_json(root / 'comfystream-p36-attestation.json', attestation)
    return attestation


def atomic_json(path: Path, value: object) -> None:
    descriptor, name = tempfile.mkstemp(prefix='.p36-', suffix='.json', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, sort_keys=True)
            stream.write('\n')
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    print(json.dumps(prepare(), sort_keys=True))
