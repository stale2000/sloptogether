from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path
from typing import TYPE_CHECKING, cast

import pytest

if TYPE_CHECKING:
    from torch import Tensor

torch = pytest.importorskip('torch')
pytest.importorskip('safetensors')


def module() -> types.ModuleType:
    name = 'h3_p36_node_test'
    package = types.ModuleType(name)
    package.__path__ = [str(Path(__file__).parents[1] / 'deploy/custom_nodes/fasth3_deploy')]
    sys.modules.setdefault(name, package)
    return importlib.import_module(f'{name}.p36_node')


def fake_worker(path: Path) -> None:
    path.write_text('''import hashlib,json,sys,torch
from safetensors.torch import load_file,save_file
print(json.dumps({"status":"ready","protocol":"comfystream-h3-p36/1"}),flush=True)
for line in sys.stdin:
 r=json.loads(line)
 if r["op"]=="shutdown": break
 x=load_file(r["input"])["latent"]
 y=torch.ones((1,3,r["expected_frames"],x.shape[3]*16,x.shape[4]*16),dtype=torch.float32)*0.5
 save_file({"pixels":y},r["output"])
 with open(r["output"],"rb") as f: h=hashlib.sha256(f.read()).hexdigest()
 print(json.dumps({"id":r["id"],"status":"ok","shape":list(y.shape),"output_sha256":h}),flush=True)
''')


def test_worker_reuses_process_and_validates_output(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    m = module()
    worker_script = tmp_path / 'worker.py'
    fake_worker(worker_script)
    monkeypatch.setattr(m, '_PYTHON', Path(sys.executable))
    monkeypatch.setattr(m, '_WORKER', worker_script)
    worker = m.P36Worker()
    try:
        z = torch.zeros((1, 24, 1, 1, 1))
        result = worker.decode(z, 'torch.float16', 1)
        pid = worker._process.pid
        again = worker.decode(z, 'torch.float16', 1)
        assert worker._process.pid == pid
        assert result.shape == (1, 16, 16, 3)
        assert torch.equal(result, again)
        assert list(Path(worker._dir.name).iterdir()) == []
    finally:
        worker.close()
    assert worker._process is None


def test_worker_rejects_bad_output_and_cleans_up(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    m = module()
    script = tmp_path / 'worker.py'
    fake_worker(script)
    content = script.read_text().replace('"output_sha256":h', '"output_sha256":"bad"')
    script.write_text(content)
    monkeypatch.setattr(m, '_PYTHON', Path(sys.executable))
    monkeypatch.setattr(m, '_WORKER', script)
    worker = m.P36Worker()
    with pytest.raises(RuntimeError, match='hash'):
        worker.decode(torch.zeros((1, 24, 1, 1, 1)), 'torch.float16', 1)
    assert worker._process is None
    assert worker._dir is None


def test_worker_startup_timeout_kills_and_removes_exchange_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    m = module()
    script = tmp_path / 'worker.py'
    script.write_text('import time; time.sleep(20)')
    monkeypatch.setattr(m, '_PYTHON', Path(sys.executable))
    monkeypatch.setattr(m, '_WORKER', script)
    monkeypatch.setattr(m, '_STARTUP_TIMEOUT', 0.1)
    worker = m.P36Worker()
    with pytest.raises(TimeoutError, match='timed out'):
        worker.decode(torch.zeros((1, 24, 1, 1, 1)), 'torch.float16', 1)
    assert worker._process is None and worker._dir is None


def test_worker_exit_includes_stderr(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    m = module()
    script = tmp_path / 'worker.py'
    script.write_text('import sys; print("asset missing", file=sys.stderr); raise SystemExit(1)')
    monkeypatch.setattr(m, '_PYTHON', Path(sys.executable))
    monkeypatch.setattr(m, '_WORKER', script)
    worker = m.P36Worker()
    with pytest.raises(RuntimeError, match='asset missing'):
        worker.decode(torch.zeros((1, 24, 1, 1, 1)), 'torch.float16', 1)
    assert worker._process is None and worker._dir is None


@pytest.mark.parametrize(('target_rate', 'expected_rate'), [(None, 44100), (48000, 48000), (1, 44100)])
def test_node_preserves_audio_for_serial_output_and_sets_report(
    monkeypatch: pytest.MonkeyPatch, target_rate: int | None, expected_rate: int,
) -> None:
    m = module()
    video = importlib.import_module('h3_p36_node_test.benchmark_video')
    fake = types.ModuleType('h3_p36_node_test.benchmark_report')
    fake.__dict__['_decode_report'] = lambda report, stage, operation, cuda_sync: (operation(), dict(report, status='DECODED'))
    monkeypatch.setitem(sys.modules, fake.__name__, fake)
    created: list[tuple[str, float, int] | tuple[str, int]] = []
    class Session:
        frame_count = 0
        def push_nhwc(self, images: Tensor) -> None:
            self.frame_count = len(images)
        def abandon(self) -> None:
            raise AssertionError('successful session should not be abandoned')
    stream = types.ModuleType('h3_p36_node_test.decoder_stream')
    def start_stream_session(*, encode_backend: str, fps: float, audio_sample_rate: int) -> tuple[Session, dict[str, object]]:
        created.append((encode_backend, fps, audio_sample_rate))
        return Session(), {'enabled': True, 'audio_sample_rate': audio_sample_rate}
    stream.__dict__['start_stream_session'] = start_stream_session
    stream.__dict__['register_stream_session'] = lambda nonce, session: created.append((nonce, session.frame_count))
    monkeypatch.setitem(sys.modules, stream.__name__, stream)
    monkeypatch.setitem(sys.modules, 'h3_p36_node_test.benchmark_video', video)
    worker = types.SimpleNamespace(decode=lambda latent, dtype, frames: torch.zeros((frames, 16, 16, 3)))
    monkeypatch.setattr(m, '_WORKER_INSTANCE', worker)
    model = types.SimpleNamespace(decode_output_shape=lambda shape: (1, 3, 1, 16, 16))
    vae = types.SimpleNamespace(first_stage_model=model, vae_dtype=torch.float16)
    source_report: dict[str, object] = {'run_nonce': 'example'}
    if target_rate is not None:
        source_report['audio_target_sample_rate'] = target_rate
    result, report = m.FastH3P36VAEDecode().decode({'samples': torch.zeros((1, 24, 1, 1, 1))}, vae,
                                                    source_report, audio_vae=object())
    assert result.shape == (1, 16, 16, 3)
    assert report['decoder_mode'] == 'p36_nvfp4'
    assert report['audio_overlap']['mode'] == 'serial'
    assert report['stream_encode']['mode'] == 'p36_full_frame'
    assert created[0] == ('nvenc', 24.0, expected_rate)
    assert created[1] == ('example', 1)
    assert 'decoded_image_retention' not in report


def test_node_rejects_bad_latent_or_missing_dtype() -> None:
    m = module()
    vae = types.SimpleNamespace(vae_dtype=None)
    with pytest.raises(ValueError, match='actual conditioning'):
        m.FastH3P36VAEDecode().decode({'samples': torch.zeros((1, 24, 1, 1, 1))}, vae, {'run_nonce': 'n'})
    with pytest.raises(ValueError, match='expects one'):
        m.FastH3P36VAEDecode().decode({'samples': torch.zeros((2, 24, 1, 1, 1))}, vae, {'run_nonce': 'n'})


def test_node_extracts_video_from_comfy_joint_av_nested_wrapper(monkeypatch: pytest.MonkeyPatch) -> None:
    m = module()
    video_module = importlib.import_module('h3_p36_node_test.benchmark_video')
    fake = types.ModuleType('h3_p36_node_test.benchmark_report')
    fake.__dict__['_decode_report'] = lambda report, stage, operation, cuda_sync: (operation(), dict(report))
    monkeypatch.setitem(sys.modules, fake.__name__, fake)
    stream = types.ModuleType('h3_p36_node_test.decoder_stream')
    class Session:
        frame_count = 0
        def push_nhwc(self, images: Tensor) -> None:
            self.frame_count = len(images)
    stream.__dict__['start_stream_session'] = lambda **kwargs: (Session(), {})
    stream.__dict__['register_stream_session'] = lambda nonce, session: None
    monkeypatch.setitem(sys.modules, stream.__name__, stream)
    monkeypatch.setitem(sys.modules, 'h3_p36_node_test.benchmark_video', video_module)
    seen = []
    def decode(latent: Tensor, dtype: str, frames: int) -> Tensor:
        seen.append(latent)
        return cast('Tensor', torch.zeros((frames, 16, 16, 3)))
    monkeypatch.setattr(m, '_WORKER_INSTANCE', types.SimpleNamespace(decode=decode))
    video, audio = torch.zeros((1, 24, 1, 1, 1)), torch.ones((1, 8, 2))
    class Nested:
        is_nested = True
        def unbind(self) -> list[Tensor]:
            return [video, audio]
    vae = types.SimpleNamespace(first_stage_model=types.SimpleNamespace(
        decode_output_shape=lambda shape: (1, 3, 1, 16, 16)), vae_dtype=torch.float16)
    result, _ = m.FastH3P36VAEDecode().decode({'samples': Nested()}, vae, {'run_nonce': 'n'})
    assert result.shape == (1, 16, 16, 3)
    assert len(seen) == 1 and seen[0] is video


@pytest.mark.parametrize(('target_rate', 'expected_rate'), [(None, 44100), (48000, 48000)])
def test_real_stream_encoder_preserves_target_audio_rate(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, target_rate: int | None, expected_rate: int,
) -> None:
    av = pytest.importorskip('av')
    m = module()
    importlib.import_module('h3_p36_node_test.benchmark_video')
    stream = importlib.import_module('h3_p36_node_test.decoder_stream')
    fake = types.ModuleType('h3_p36_node_test.benchmark_report')
    fake.__dict__['_decode_report'] = lambda report, stage, operation, cuda_sync: (operation(), dict(report))
    monkeypatch.setitem(sys.modules, fake.__name__, fake)
    monkeypatch.setattr(m, '_WORKER_INSTANCE', types.SimpleNamespace(
        decode=lambda latent, dtype, frames: torch.zeros((frames, 16, 16, 3))))
    vae = types.SimpleNamespace(first_stage_model=types.SimpleNamespace(
        decode_output_shape=lambda shape: (1, 3, 24, 16, 16)), vae_dtype=torch.float16)
    nonce = f'test-p36-audio-{expected_rate}'
    report: dict[str, object] = {'run_nonce': nonce}
    if target_rate is not None:
        report['audio_target_sample_rate'] = target_rate
    m.FastH3P36VAEDecode().decode({'samples': torch.zeros((1, 24, 1, 1, 1))}, vae,
                                  report, encode_backend='parallel')
    session = stream.take_stream_session(nonce)
    assert session is not None
    try:
        result = session.finish({'waveform': torch.ones((1, 1, 32000)) * 0.01, 'sample_rate': 32000})
        with av.open(result['path']) as media:
            assert media.streams.audio[0].codec_context.name == 'aac'
            assert media.streams.audio[0].codec_context.sample_rate == expected_rate
            assert media.streams.audio[0].codec_context.channels == 2
            assert media.streams.video[0].frames == 24
            assert media.streams.audio[0].duration is not None
            assert media.streams.audio[0].time_base is not None
            assert abs(float(media.streams.audio[0].duration * media.streams.audio[0].time_base) - 1.0) < 0.03
    finally:
        Path(session.path).unlink(missing_ok=True)
