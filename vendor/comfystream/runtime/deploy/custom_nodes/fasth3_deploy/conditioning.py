"""H3 conditioning with request-scoped Kitchen VAE adapters and evidence."""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, cast

if TYPE_CHECKING:
    from comfy.sd import CLIP, VAE
    from torch import Tensor

    from .benchmark_clock import H3WorkerClock

class ComfyStreamerH3ImageToVideo:
    RETURN_TYPES = ("CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "latent")
    FUNCTION = "execute"
    CATEGORY = "ComfyStreamerH3/Deploy"

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, dict[str, tuple[object, ...]]]:
        return {"required": {
            "clip": ("CLIP",), "vae": ("VAE",), "profile": ("H3_PROFILE",),
            "prompt": ("STRING", {"multiline": True, "dynamicPrompts": True}),
            "width": ("INT", {"default": 512, "min": 32, "max": 16384, "step": 32}),
            "height": ("INT", {"default": 320, "min": 32, "max": 16384, "step": 32}),
            "length": ("INT", {"default": 362, "min": 5, "max": 3600, "step": 17}),
        }, "optional": {
            "run_nonce": ("STRING", {"default": ""}),
            "benchmark_clock": ("H3_BENCHMARK_CLOCK",),
            "audio_vae": ("VAE",),
            "first_frame": ("IMAGE",), "last_frame": ("IMAGE",),
            **{f"ref_image_{index}": ("IMAGE",) for index in range(1, 10)},
            **{f"ref_audio_{index}": ("AUDIO",) for index in range(1, 4)},
            "vae_precision_policy": (["established", "fp16_accum"], {"default": "established"}),
        }}

    def execute(self, clip: CLIP, vae: VAE, profile: dict[str, object], prompt: str, width: int, height: int, length: int,
                first_frame: Tensor | None=None, last_frame: Tensor | None=None, vae_precision_policy: str="established",
                ref_image_1: Tensor | None=None, ref_image_2: Tensor | None=None, ref_image_3: Tensor | None=None,
                ref_image_4: Tensor | None=None, ref_image_5: Tensor | None=None, ref_image_6: Tensor | None=None,
                ref_image_7: Tensor | None=None, ref_image_8: Tensor | None=None, ref_image_9: Tensor | None=None, run_nonce: str="",
                benchmark_clock: H3WorkerClock | None=None, audio_vae: VAE | None=None,
                ref_audio_1: dict[str, object] | None=None, ref_audio_2: dict[str, object] | None=None, ref_audio_3: dict[str, object] | None=None) -> tuple[object, dict[str, object]]:
        from .kitchen_vae import kitchen_vae_mode

        policy = profile.get("kitchen_baseline") if isinstance(profile, dict) else None
        dmad_profile = isinstance(profile, dict) and profile.get("model_family") == "dmad"
        if policy:
            if cast(Mapping[str, object], policy)["vae_precision_policy"] != vae_precision_policy:
                raise ValueError("encoder precision policy differs from loader profile")
            encoder_kitchen_fusions = True
        elif dmad_profile:
            if profile.get("vae_precision_policy", "established") != vae_precision_policy:
                raise ValueError("DMAD encoder precision policy differs from loader profile")
            encoder_kitchen_fusions = bool(profile.get("kitchen_vae_fusions", False))
        else:
            raise ValueError("ComfyStreamerH3 Image to Video requires a Kitchen baseline profile or a DMAD model profile")

        references = {
            f"ref_image_{index}": image
            for index, image in enumerate((
                ref_image_1, ref_image_2, ref_image_3, ref_image_4, ref_image_5,
                ref_image_6, ref_image_7, ref_image_8, ref_image_9,
            ), start=1)
            if image is not None
        }
        audio_references = {
            f"ref_audio_{index}": audio
            for index, audio in enumerate((ref_audio_1, ref_audio_2, ref_audio_3), start=1)
            if audio is not None
        }
        if audio_references and audio_vae is None:
            raise ValueError("H3 audio references require the audio_vae input")
        if dmad_profile and (first_frame is not None or last_frame is not None or references or audio_references):
            raise ValueError("DMAD's original H3 text-to-audio-video model has no qualified frame/reference conditioning")
        with kitchen_vae_mode(vae.first_stage_model, precision_policy=vae_precision_policy,
                              enabled=encoder_kitchen_fusions) as evidence:
            if not references and not audio_references:
                from comfy_extras.nodes_minimax_h3 import MiniMaxH3ImageToVideo

                result = MiniMaxH3ImageToVideo.execute(
                    clip, vae, prompt, width, height, length, first_frame, last_frame,
                )
            else:
                from comfy_extras.nodes_minimax_h3 import (
                    MiniMaxH3AddGuide,
                    MiniMaxH3ReferenceToVideo,
                    _resize,
                )

                reference_inputs = {
                    "ref_image_size": "match", "vae": vae, "ref_images": references,
                }
                if audio_references:
                    reference_inputs.update(audio_vae=audio_vae, ref_audios=audio_references)
                result = MiniMaxH3ReferenceToVideo.execute(
                    clip, prompt, width, height, length, **reference_inputs,
                )
                values = result.args if hasattr(result, "args") else result
                conditioning, latent = values
                if first_frame is not None:
                    # AddGuide center-crops; stretch first so its geometry matches
                    # the legacy first-frame path before that resize is applied.
                    first_frame = _resize(first_frame[:1], width, height, "disabled")
                    guided = MiniMaxH3AddGuide.execute(
                        conditioning, latent, frame_idx=0, vae=vae, image=first_frame,
                    )
                    conditioning = guided.args[0] if hasattr(guided, "args") else guided[0]
                if last_frame is not None:
                    guided = MiniMaxH3AddGuide.execute(
                        conditioning, latent, frame_idx=-1, vae=vae, image=last_frame,
                    )
                    conditioning = guided.args[0] if hasattr(guided, "args") else guided[0]
                result = (conditioning, latent)
        values = result.args if hasattr(result, "args") else result
        conditioning, latent = values
        latent = dict(latent, fasth3_encoder_execution=evidence)
        if benchmark_clock is not None:
            clock_nonce = getattr(benchmark_clock, "nonce", None)
            worker_start = getattr(benchmark_clock, "started_monotonic", None)
            if (not isinstance(clock_nonce, str) or not clock_nonce
                    or type(worker_start) not in (int, float)):
                raise ValueError("ComfyStreamerH3 Benchmark Clock returned an invalid value")
            if run_nonce and run_nonce != clock_nonce:
                raise ValueError("conditioning run_nonce differs from the worker clock nonce")
            assert isinstance(worker_start, (int, float))
            latent["fasth3_worker_clock"] = {
                "nonce": clock_nonce,
                "started_monotonic": float(worker_start),
                "text_cache_policy": str(getattr(benchmark_clock, "text_cache_policy", "")),
                "residency_policy": str(getattr(benchmark_clock, "residency_policy", "")),
                "residency_start": getattr(benchmark_clock, "residency_start", {}),
            }
        return conditioning, latent
