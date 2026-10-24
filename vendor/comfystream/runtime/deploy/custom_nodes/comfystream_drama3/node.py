"""Synchronous audio.cpp process: release TTS GPU memory before downstream H3 runs."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path
from typing import TYPE_CHECKING, TypedDict

if TYPE_CHECKING:
    import torch


class Audio(TypedDict):
    waveform: torch.Tensor
    sample_rate: int

MODEL_FILENAME = "drama-3-backbone-8bit-experts-Q4_K_S.gguf"
SERVER_URL = "http://127.0.0.1:8035"
SERVER_MODEL = "drama3"
_EXECUTION_LOCK = threading.Lock()


def runtime_paths() -> tuple[Path, Path]:
    root = Path(os.environ.get(
        "COMFYSTREAM_DRAMA3_RUNTIME", str(Path(__file__).resolve().parent / ".runtime"),
    )).expanduser().resolve()
    cli = Path(os.environ.get(
        "COMFYSTREAM_DRAMA3_CLI",
        str(root / "audio.cpp/build/linux-cuda-release/bin/audiocpp_cli"),
    )).expanduser().resolve()
    model = Path(os.environ.get(
        "COMFYSTREAM_DRAMA3_MODEL", str(root / "models" / MODEL_FILENAME),
    )).expanduser().resolve()
    if not cli.is_file() or not os.access(cli, os.X_OK):
        raise ValueError("Drama 3 CLI is missing or not executable; run install_runtime.py --install "
                         "or set COMFYSTREAM_DRAMA3_CLI")
    if not model.is_file() or model.stat().st_size == 0:
        raise ValueError("Drama 3 GGUF is missing or empty; run install_runtime.py --install "
                         "or set COMFYSTREAM_DRAMA3_MODEL")
    return cli, model


def normalize_audio(waveform: object, sample_rate: object) -> Audio:
    """Produce finite float32 Comfy AUDIO, retaining channels and sample rate."""
    import torch

    if not isinstance(sample_rate, int) or isinstance(sample_rate, bool) or sample_rate <= 0:
        raise ValueError("Drama 3 audio sample_rate must be a positive integer")
    if not isinstance(waveform, torch.Tensor):
        raise TypeError("Drama 3 audio waveform must be a tensor")
    tensor: torch.Tensor = waveform
    tensor = tensor.detach().cpu()
    if tensor.ndim == 1:
        tensor = tensor.unsqueeze(0).unsqueeze(0)
    elif tensor.ndim == 2:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 3 or tensor.shape[0] != 1 or tensor.numel() == 0:
        raise ValueError("Drama 3 audio must contain one nonempty [batch, channels, samples] item")
    if tensor.dtype == torch.bool or tensor.is_complex():
        raise ValueError("Drama 3 audio must contain real PCM samples")
    if not tensor.is_floating_point():
        limits = torch.iinfo(tensor.dtype)
        if limits.min >= 0:
            raise ValueError("Drama 3 audio requires signed PCM or floating-point samples")
        tensor = tensor.to(torch.float32) / max(abs(limits.min), limits.max)
    else:
        tensor = tensor.to(torch.float32)
    if not bool(torch.isfinite(tensor).all()):
        raise ValueError("Drama 3 audio contains nonfinite samples")
    peak = float(tensor.abs().max())
    if peak <= 1e-7:
        raise ValueError("Drama 3 audio is silent")
    tensor = (tensor / max(1.0, peak)).contiguous()
    return {"waveform": tensor, "sample_rate": sample_rate}


def _read_audio(path: Path) -> Audio:
    # ComfyUI's PyAV helper handles both PCM and IEEE-float WAV output.
    from comfy_extras.nodes_audio import load

    waveform, sample_rate = load(str(path))
    return normalize_audio(waveform, sample_rate)


def _write_reference(path: Path, audio: Audio) -> None:
    import torch

    samples = audio["waveform"][0].transpose(0, 1)
    pcm = (samples * 32767).round().to(dtype=torch.int16)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(samples.shape[1])
        output.setsampwidth(2)
        output.setframerate(audio["sample_rate"])
        output.writeframes(pcm.numpy().astype("<i2", copy=False).tobytes())


def _release_comfy_models() -> None:
    import comfy.model_management

    comfy.model_management.unload_all_models()
    comfy.model_management.soft_empty_cache()


def _cuda_memory_mib() -> tuple[int, int]:
    """Return device-wide free/total memory, including other CUDA processes."""
    import torch

    free_bytes, total_bytes = torch.cuda.mem_get_info()
    return round(free_bytes / (1024 * 1024)), round(total_bytes / (1024 * 1024))


def _prepare_tts_vram(correlation_id: str = "") -> dict[str, str | int | None]:
    """Keep H3 cached only when device-wide headroom is safely above the TTS reserve."""
    try:
        minimum_free_mib = int(os.environ.get("COMFYSTREAM_DRAMA3_MIN_FREE_VRAM_MIB", "32768"))
    except ValueError as exc:
        raise ValueError("COMFYSTREAM_DRAMA3_MIN_FREE_VRAM_MIB must be an integer") from exc
    if not 0 <= minimum_free_mib <= 1_000_000:
        raise ValueError("COMFYSTREAM_DRAMA3_MIN_FREE_VRAM_MIB is out of range")
    free_before = total = None
    memory_query_error = None
    try:
        free_before, total = _cuda_memory_mib()
    except Exception as exc:  # noqa: BLE001 - fail closed to the current unload behavior.
        memory_query_error = type(exc).__name__
    started = time.monotonic()
    action = (
        "retain_comfy_models"
        if free_before is not None and free_before >= minimum_free_mib
        else "unload_comfy_models"
    )
    if action == "unload_comfy_models":
        _release_comfy_models()
    policy_elapsed = time.monotonic() - started
    free_after = None
    try:
        free_after, total = _cuda_memory_mib()
    except Exception as exc:  # noqa: BLE001 - preserve the policy event for diagnosis.
        memory_query_error = memory_query_error or type(exc).__name__
    print(json.dumps({
        "event": "comfystream_drama3_vram_policy",
        "correlation_id": correlation_id,
        "action": action,
        "free_before_mib": free_before,
        "free_after_mib": free_after,
        "total_mib": total,
        "minimum_free_mib": minimum_free_mib,
        "policy_elapsed_seconds": round(policy_elapsed, 4),
        "memory_query_error": memory_query_error,
    }), flush=True)
    return {
        "action": action,
        "free_before_mib": free_before,
        "free_after_mib": free_after,
        "total_mib": total,
        "minimum_free_mib": minimum_free_mib,
    }


def cli_command(
    cli: Path, model: Path, text: str, seed: int, max_tokens: int, output: Path,
    reference: Path | None = None, reference_text: str = "",
) -> list[str]:
    command = [
        str(cli), "--task", "tts", "--family", "fish_drama3", "--backend", "cuda",
        "--mode", "offline", "--model", str(model), "--text", text,
        "--seed", str(seed), "--max-tokens", str(max_tokens), "--top-k", "4097",
        "--out", str(output),
    ]
    for option in (
        "cpu_expert_layers=0", "disk_experts=false", "pin_experts=false", "codec_backend=same",
        "context_length=4096",
    ):
        command.extend(["--session-option", f"fish_drama3.{option}"])
    if reference is not None:
        command.extend([
            "--voice-ref", str(reference), "--request-option", f"reference_text={reference_text}",
        ])
    return command


def cli_sequence_command(cli: Path, model: Path, sequence: Path, output_dir: Path) -> list[str]:
    """Run paired dialogue through one audio.cpp session/model load."""
    command = [
        str(cli), "--task", "tts", "--family", "fish_drama3", "--backend", "cuda",
        "--mode", "offline", "--model", str(model),
        "--request-sequence", str(sequence), "--out-dir", str(output_dir),
    ]
    for option in (
        "cpu_expert_layers=0", "disk_experts=false", "pin_experts=false", "codec_backend=same",
        "context_length=4096",
    ):
        command.extend(["--session-option", f"fish_drama3.{option}"])
    return command


def _timeout_seconds() -> int:
    try:
        timeout = int(os.environ.get("COMFYSTREAM_DRAMA3_TIMEOUT_S", "600"))
    except ValueError as exc:
        raise ValueError("COMFYSTREAM_DRAMA3_TIMEOUT_S must be an integer from 1 to 3600") from exc
    if not 1 <= timeout <= 3600:
        raise ValueError("COMFYSTREAM_DRAMA3_TIMEOUT_S must be an integer from 1 to 3600")
    return timeout


def _run_cli(command: list[str], timeout: int) -> None:
    try:
        subprocess.run(command, check=True, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"Drama 3 CUDA generation timed out after {timeout}s") from exc
    except subprocess.CalledProcessError as exc:
        details = (exc.stderr or exc.stdout or "no diagnostic output")[-4000:]
        raise RuntimeError(f"Drama 3 generation failed ({exc.returncode}): {details}") from exc


def _request_server(
    text: str, seed: int, max_tokens: int, output: Path, speaker_id: int,
    delivery: str, timeout: int,
) -> None:
    """Use the resident audio.cpp session so adjacent clips do not reload weights."""
    server_url = os.environ.get("COMFYSTREAM_DRAMA3_SERVER_URL", SERVER_URL).rstrip("/")
    model = os.environ.get("COMFYSTREAM_DRAMA3_SERVER_MODEL", SERVER_MODEL)
    marked_text = f"<|speaker:{speaker_id}|> [{delivery}] {text}"
    payload = json.dumps({
        "model": model,
        "input": marked_text,
        "seed": seed,
        "max_tokens": max_tokens,
    }).encode("utf-8")
    request = urllib.request.Request(
        f"{server_url}/v1/audio/speech", data=payload,
        headers={"Content-Type": "application/json", "Accept": "audio/wav"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status != 200:
                raise RuntimeError(f"Drama 3 server returned HTTP {response.status}")
            audio_bytes = response.read()
    except urllib.error.HTTPError as exc:
        details = exc.read()[-4000:].decode("utf-8", errors="replace")
        raise RuntimeError(f"Drama 3 server returned HTTP {exc.code}: {details}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError(f"Drama 3 resident server unavailable: {exc}") from exc
    if len(audio_bytes) < 44 or audio_bytes[:4] != b"RIFF" or audio_bytes[8:12] != b"WAVE":
        raise RuntimeError("Drama 3 server returned an invalid or empty WAV response")
    output.write_bytes(audio_bytes)


class ComfyStreamDrama3TTS:
    CATEGORY = "ComfyStream/Audio"
    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "generate"

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, dict[str, tuple[object, ...]]]:
        return {
            "required": {
                "text": ("STRING", {"multiline": True, "default": "Hello from Drama Three."}),
                "seed": ("INT", {"default": 123, "min": 0, "max": 0xFFFFFFFF}),
                "max_tokens": ("INT", {"default": 1024, "min": 1, "max": 2048}),
            },
            "optional": {
                "voice_reference": ("AUDIO",),
                "reference_text": ("STRING", {"default": "", "multiline": True}),
            },
        }

    def generate(
        self, text: str, seed: int, max_tokens: int, voice_reference: Audio | None = None,
        reference_text: str = "",
    ) -> tuple[Audio]:
        if not isinstance(text, str) or not text.strip() or "\x00" in text:
            raise ValueError("Drama 3 text must be nonempty and contain no NUL bytes")
        for name, value, maximum in (("seed", seed, 0xFFFFFFFF), ("max_tokens", max_tokens, 2048)):
            minimum = 1 if name == "max_tokens" else 0
            if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
                raise ValueError(f"Drama 3 {name} must be an integer from {minimum} to {maximum}")
        if not isinstance(reference_text, str) or "\x00" in reference_text:
            raise ValueError("Drama 3 reference_text must be a string without NUL bytes")
        if (voice_reference is not None) != bool(reference_text.strip()):
            raise ValueError("Drama 3 voice_reference and reference_text must be supplied together")
        cli, model = runtime_paths()
        try:
            timeout = int(os.environ.get("COMFYSTREAM_DRAMA3_TIMEOUT_S", "600"))
        except ValueError as exc:
            raise ValueError("COMFYSTREAM_DRAMA3_TIMEOUT_S must be an integer from 1 to 3600") from exc
        if not 1 <= timeout <= 3600:
            raise ValueError("COMFYSTREAM_DRAMA3_TIMEOUT_S must be an integer from 1 to 3600")
        reference_audio = None
        if voice_reference is not None:
            reference_audio = normalize_audio(
                voice_reference["waveform"], voice_reference["sample_rate"],
            )
        with _EXECUTION_LOCK, tempfile.TemporaryDirectory(prefix="comfystream-drama3-") as temporary:
            output = Path(temporary) / "speech.wav"
            reference = Path(temporary) / "reference.wav" if reference_audio is not None else None
            if reference is not None and reference_audio is not None:
                _write_reference(reference, reference_audio)
            command = cli_command(cli, model, text, seed, max_tokens, output, reference, reference_text)
            _release_comfy_models()
            started = time.monotonic()
            try:
                subprocess.run(command, check=True, capture_output=True, text=True, timeout=timeout)
            except subprocess.TimeoutExpired as exc:
                raise RuntimeError(f"Drama 3 CUDA generation timed out after {timeout}s") from exc
            except subprocess.CalledProcessError as exc:
                details = (exc.stderr or exc.stdout or "no diagnostic output")[-4000:]
                raise RuntimeError(f"Drama 3 CUDA generation failed ({exc.returncode}): {details}") from exc
            # subprocess.run has reaped the child, releasing its CUDA context before H3 loads.
            if not output.is_file() or output.stat().st_size == 0:
                raise RuntimeError("Drama 3 generation produced no WAV output")
            audio = _read_audio(output)
            audio_seconds = audio["waveform"].shape[-1] / audio["sample_rate"]
            print(json.dumps({
                "event": "comfystream_drama3_complete",
                "seed": seed,
                "elapsed_seconds": round(time.monotonic() - started, 4),
                "audio_seconds": round(audio_seconds, 4),
            }), flush=True)
            return (audio,)


class ComfyStreamDrama3TTSBatch:
    """Generate two expressive reference WAVs through the resident Drama 3 session."""

    CATEGORY = "ComfyStream/Audio"
    RETURN_TYPES = ("AUDIO", "AUDIO")
    RETURN_NAMES = ("speech_0", "speech_1")
    FUNCTION = "generate"

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, dict[str, tuple[object, ...]]]:
        return {
            "required": {
                "text_0": ("STRING", {"multiline": True, "default": "Hello from Drama Three."}),
                "text_1": ("STRING", {"multiline": True, "default": "Hello again from Drama Three."}),
                "seed": ("INT", {"default": 123, "min": 0, "max": 0xFFFFFFFF}),
                "max_tokens": ("INT", {"default": 1024, "min": 1, "max": 2048}),
            },
            "optional": {
                "correlation_id": ("STRING", {"default": "", "multiline": False}),
            },
        }

    def generate(
        self, text_0: str, text_1: str, seed: int, max_tokens: int, correlation_id: str = "",
    ) -> tuple[Audio, ...]:
        texts = (text_0, text_1)
        if any(not isinstance(text, str) or not text.strip() or "\x00" in text for text in texts):
            raise ValueError("Drama 3 pair text must contain two nonempty strings without NUL bytes")
        for name, value, maximum in (("seed", seed, 0xFFFFFFFF), ("max_tokens", max_tokens, 2048)):
            minimum = 1 if name == "max_tokens" else 0
            if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
                raise ValueError(f"Drama 3 {name} must be an integer from {minimum} to {maximum}")
        if not isinstance(correlation_id, str) or len(correlation_id) > 128 or "\x00" in correlation_id:
            raise ValueError("Drama 3 correlation_id must be a string up to 128 characters")
        timeout = _timeout_seconds()
        with _EXECUTION_LOCK, tempfile.TemporaryDirectory(prefix="comfystream-drama3-pair-") as temporary:
            root = Path(temporary)
            output_dir = root / "outputs"
            output_dir.mkdir()
            vram = _prepare_tts_vram(correlation_id)
            started = time.monotonic()
            paths = tuple(output_dir / f"speech_{index}.wav" for index in range(2))
            for index, (text, path) in enumerate(zip(texts, paths)):
                request_started = time.monotonic()
                # Reuse the same voice identity and delivery for both narration
                # references so paired shots sound like one continuous storyteller.
                _request_server(
                    text, seed, max_tokens, path,
                    speaker_id=0, delivery="clear, natural voice", timeout=timeout,
                )
                print(json.dumps({
                    "event": "comfystream_drama3_voice_complete",
                    "correlation_id": correlation_id,
                    "speaker": index,
                    "elapsed_seconds": round(time.monotonic() - request_started, 4),
                }), flush=True)
            if any(not path.is_file() or path.stat().st_size == 0 for path in paths):
                raise RuntimeError("Drama 3 paired generation did not produce both WAV outputs")
            decode_started = time.monotonic()
            audios = tuple(_read_audio(path) for path in paths)
            decode_seconds = time.monotonic() - decode_started
            durations = [round(audio["waveform"].shape[-1] / audio["sample_rate"], 4) for audio in audios]
            print(json.dumps({
                "event": "comfystream_drama3_pair_complete",
                "correlation_id": correlation_id,
                "seed": seed,
                "elapsed_seconds": round(time.monotonic() - started, 4),
                "decode_seconds": round(decode_seconds, 4),
                "vram": vram,
                "audio_seconds": durations,
                "resident_session": True,
            }), flush=True)
            return audios
