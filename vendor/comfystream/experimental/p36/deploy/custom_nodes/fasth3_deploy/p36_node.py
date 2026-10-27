"""Live P36 decoder using a resident FastVideo sidecar.

The sidecar uses an isolated Python environment; full RGB frames are returned
on the host, so normal output encoding and audio execute after video decoding.
"""
from __future__ import annotations

import atexit
import hashlib
import json
import os
import select
import signal
import subprocess
import tempfile
import threading
import time
import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import BinaryIO, cast

import torch
from safetensors.torch import load_file, save_file

_PYTHON = Path('/opt/venv-fastvideo/bin/python')
_WORKER = Path('/opt/comfystream/deploy/custom_nodes/fasth3_deploy/p36_worker.py')
_STARTUP_TIMEOUT = 600.0
_DECODE_TIMEOUT = 300.0
_MAX_LINE = 65536


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def _expected_video_frames(vae: object, shape: tuple[int, ...]) -> int:
    model = getattr(vae, 'first_stage_model', None)
    if model is None:
        raise ValueError('conditioning VAE is missing its video model')
    shape_fn = getattr(model, 'decode_output_shape', None)
    if callable(shape_fn):
        result = shape_fn(shape)
        if len(result) != 5 or int(result[0]) != 1 or int(result[1]) != 3:
            raise ValueError('invalid conditioning VAE output shape')
        frames = int(result[2])
    else:
        from .decoder_stream import decode_temporal_chunks, decode_temporal_frame_plan
        pad, chunks = decode_temporal_chunks(model, shape[2])
        frames = decode_temporal_frame_plan(model, shape[2] + pad, chunks, pad)
    if frames <= 0:
        raise ValueError('invalid expected frame count')
    return frames


class P36Worker:
    """One serial, resident process and private exchange directory per Comfy process."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._process: subprocess.Popen[bytes] | None = None
        self._dir: tempfile.TemporaryDirectory[str] | None = None
        self._stderr: BinaryIO | None = None

    def _receive(self, timeout: float) -> dict[str, object]:
        proc = self._process
        if proc is None or proc.stdout is None:
            raise RuntimeError('P36 worker is not running')
        # Use one-byte reads after select: buffered readline can block after a
        # partial line and conceal additional data from select().
        deadline = time.monotonic() + timeout
        line = bytearray()
        fd = proc.stdout.fileno()
        while len(line) < _MAX_LINE:
            left = deadline - time.monotonic()
            if left <= 0 or not select.select([fd], [], [], max(0.0, left))[0]:
                raise TimeoutError('P36 worker response timed out')
            byte = os.read(fd, 1)
            if not byte:
                raise RuntimeError('P36 worker exited before response')
            if byte == b'\n':
                break
            line.extend(byte)
        else:
            raise RuntimeError('P36 worker response exceeded limit')
        try:
            msg = json.loads(line)
        except (ValueError, UnicodeError) as exc:
            raise RuntimeError('invalid P36 worker response') from exc
        if not isinstance(msg, dict):
            raise TypeError('invalid P36 worker message')
        return cast(dict[str, object], msg)

    def _stop(self) -> None:
        proc, self._process = self._process, None
        if proc is not None:
            if proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    proc.wait(timeout=5)
                except ProcessLookupError:
                    pass
            if proc.stdin is not None:
                proc.stdin.close()
            if proc.stdout is not None:
                proc.stdout.close()
        if self._stderr is not None:
            self._stderr.close()
            self._stderr = None
        if self._dir is not None:
            self._dir.cleanup()
            self._dir = None

    def close(self) -> None:
        with self._lock:
            self._stop()

    def _diagnostic(self) -> str:
        if self._stderr is None:
            return ''
        self._stderr.flush()
        self._stderr.seek(0, os.SEEK_END)
        size = self._stderr.tell()
        self._stderr.seek(max(0, size - 4096))
        return self._stderr.read().decode('utf-8', errors='replace').strip()

    def _start(self) -> None:
        if self._process is not None and self._process.poll() is None:
            return
        self._stop()
        if not _PYTHON.is_file() or not _WORKER.is_file():
            raise RuntimeError('P36 runtime is not installed in this worker image')
        self._dir = tempfile.TemporaryDirectory(prefix='comfystream-p36-')
        self._stderr = tempfile.TemporaryFile()  # noqa: SIM115 - closed with the owned worker
        self._process = subprocess.Popen(
            [str(_PYTHON), '-u', str(_WORKER), '--exchange-dir', self._dir.name],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self._stderr,
            start_new_session=True, bufsize=0,
        )
        msg = self._receive(_STARTUP_TIMEOUT)
        if msg.get('status') != 'ready' or msg.get('protocol') != 'comfystream-h3-p36/1':
            raise RuntimeError('P36 worker failed to initialize')

    def decode(self, latent: torch.Tensor, dtype: str, frames: int) -> torch.Tensor:
        with self._lock:
            try:
                self._start()
                assert self._dir is not None and self._process is not None
                root = Path(self._dir.name)
                token = uuid.uuid4().hex
                source, target = root / f'{token}.input.safetensors', root / f'{token}.output.safetensors'
                try:
                    save_file({'latent': latent.detach().to('cpu').contiguous()}, str(source))
                    msg = {'id': token, 'op': 'decode', 'input': str(source), 'output': str(target),
                           'input_sha256': _sha256(source), 'vae_input_dtype': dtype,
                           'expected_frames': frames}
                    if self._process.stdin is None:
                        raise RuntimeError('P36 worker input unavailable')
                    self._process.stdin.write((json.dumps(msg) + '\n').encode())
                    self._process.stdin.flush()
                    reply = self._receive(_DECODE_TIMEOUT)
                    if reply.get('id') != token or reply.get('status') != 'ok':
                        raise RuntimeError(f'P36 decode failed: {reply.get("error", "invalid response")}')
                    if not target.is_file() or target.is_symlink() or _sha256(target) != reply.get('output_sha256'):
                        raise RuntimeError('P36 output file hash or type mismatch')
                    data = load_file(str(target), device='cpu')
                    if set(data) != {'pixels'}:
                        raise RuntimeError('P36 output tensor key mismatch')
                    pixels = data['pixels']
                    expected = (1, 3, frames, latent.shape[3] * 16, latent.shape[4] * 16)
                    if tuple(pixels.shape) != expected or reply.get('shape') != list(expected):
                        raise RuntimeError('P36 output shape mismatch')
                    if pixels.dtype != torch.float32 or not bool(torch.isfinite(pixels).all()):
                        raise RuntimeError('P36 output contains invalid pixels')
                    if float(pixels.min()) < 0.0 or float(pixels.max()) > 1.0:
                        raise RuntimeError('P36 output pixels outside RGB range')
                    return pixels[0].permute(1, 2, 3, 0).contiguous()
                finally:
                    source.unlink(missing_ok=True)
                    target.unlink(missing_ok=True)
            except Exception as exc:
                diagnostic = self._diagnostic()
                self._stop()
                if diagnostic:
                    raise RuntimeError(f'{exc}; P36 worker stderr: {diagnostic}') from exc
                raise
            except BaseException:
                self._stop()
                raise


_WORKER_INSTANCE = P36Worker()
atexit.register(_WORKER_INSTANCE.close)


class FastH3P36VAEDecode:
    RETURN_TYPES = ('IMAGE', 'H3_RUN_REPORT')
    RETURN_NAMES = ('images', 'report')
    FUNCTION = 'decode'
    CATEGORY = 'ComfyStreamerH3/Deploy'

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, object]:
        return {'required': {'samples': ('LATENT',), 'vae': ('VAE',), 'report': ('H3_RUN_REPORT',)},
                'optional': {'audio_vae': ('VAE',), 'encode_backend': (['nvenc', 'parallel'], {'default': 'nvenc'}),
                             'stream_fps': ('FLOAT', {'default': 24.0, 'min': 22.0, 'max': 24.0})}}

    def decode(self, samples: Mapping[str, object], vae: object, report: dict[str, object],
               audio_vae: object | None = None, encode_backend: str = 'nvenc',
               stream_fps: float = 24.0) -> tuple[torch.Tensor, dict[str, object]]:
        if encode_backend not in ('nvenc', 'parallel') or float(stream_fps) not in (22.0, 24.0):
            raise ValueError('invalid P36 output backend or fps')
        if not isinstance(report, dict) or not report.get('run_nonce'):
            raise ValueError('P36 decode requires an identified run')
        latent = samples.get('samples')
        if getattr(latent, 'is_nested', False):
            unbind = getattr(latent, 'unbind', None)
            if not callable(unbind):
                raise TypeError('nested samples must support unbind')
            components = unbind()
            if not isinstance(components, (list, tuple)) or not components:
                raise ValueError('nested samples contain no video latent')
            latent = components[0]
        if not isinstance(latent, torch.Tensor):
            raise TypeError('samples must contain a video latent tensor')
        if latent.ndim != 5 or latent.shape[0] != 1 or latent.shape[1] != 24:
            raise ValueError('P36 expects one [1,24,T,H,W] video latent')
        dtype = str(getattr(vae, 'vae_dtype', None))
        if dtype not in ('torch.float16', 'torch.bfloat16', 'torch.float32'):
            raise ValueError('P36 requires the actual conditioning VAE decode dtype')
        expected = _expected_video_frames(vae, tuple(latent.shape))
        from .benchmark_report import _decode_report
        decoded, updated = _decode_report(report, 'video_decode',
                                           lambda: _WORKER_INSTANCE.decode(latent, dtype, expected),
                                           cuda_sync=False)
        if not isinstance(decoded, torch.Tensor):
            raise TypeError('P36 decode returned non-tensor output')
        # Use the same audio rate and channel contract as the legacy temporal
        # encoder. The full P36 output arrives at once, so this does not
        # overlap encoding with decoding, but it preserves mux semantics.
        from .benchmark_video import _stream_audio_sample_rate
        from .decoder_stream import register_stream_session, start_stream_session

        session, stream = start_stream_session(
            encode_backend=encode_backend,
            fps=float(stream_fps),
            audio_sample_rate=_stream_audio_sample_rate(updated),
        )
        if session is None:
            raise RuntimeError('P36 requires a supported stream encoder')
        try:
            session.push_nhwc(decoded)
            if int(session.frame_count) != int(decoded.shape[0]):
                raise RuntimeError('P36 encoder did not accept all decoded frames')
            register_stream_session(str(report['run_nonce']), session)
        except BaseException:
            session.abandon()
            raise
        updated['decoder_mode'] = 'p36_nvfp4'
        updated['video_decode_output_device'] = 'cpu'
        updated['frames'] = int(decoded.shape[0])
        updated['fps'] = float(stream_fps)
        updated['stream_finalized_tiles'] = False
        updated['overlap_output'] = False
        updated['stream_encode'] = {**stream, 'mode': 'p36_full_frame',
                                    'frames': int(session.frame_count), 'encode_backend': encode_backend}
        updated['audio_overlap'] = {'enabled': False, 'mode': 'serial', 'reason': 'p36_full_frame'}
        return decoded, updated
