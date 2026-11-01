"""Allow the pinned upstream decoder benchmark to encode multiple source clips."""

from __future__ import annotations

import sys
import textwrap
from pathlib import Path


def patch_source(source: str, *, sampler_fixtures: bool = True) -> str:
    replacements = (
        (
            'source.add_argument("--video", help="encode this clip with the full VAE encoder")',
            (
                'source.add_argument("--video", action="append", default=[], '
                'help="encode one source clip; repeat to benchmark several clips")'
            ),
        ),
        (
            (
                '    if args.video:\n'
                '        pixels = read_video(args.video, args.num_frames, args.height, args.width)\n'
                '        with torch.no_grad():\n'
                '            z = vae.encode_pixels(pixels).latent_dist.mode().cpu()\n'
                '        torch.save(z, out_dir / "latents.pt")\n'
                '        return [Clip(Path(args.video).stem, z, pixels)]'
            ),
            (
                '    if args.video:\n'
                '        clips = []\n'
                '        for video_path in args.video:\n'
                '            pixels = read_video(video_path, args.num_frames, args.height, args.width)\n'
                '            with torch.no_grad():\n'
                '                z = vae.encode_pixels(pixels).latent_dist.mode().cpu()\n'
                '            torch.save(z, out_dir / f"{Path(video_path).stem}__latents.pt")\n'
                '            clips.append(Clip(Path(video_path).stem, z, pixels))\n'
                '        return clips'
            ),
        ),
        (
            (
                '        if "nvfp4" in mods:\n'
                '            from fastvideo.models.vaes.minimax_h3_nvfp4_decoder import convert_decoder_to_nvfp4\n'
                '\n'
                '            rotation = next((int(m[1:]) for m in mods if m.startswith("r") and m[1:].isdigit()), None)\n'
                '            act_scale = "unit" if "unit" in mods else "static" if "static" in mods else "dynamic"\n'
                '            convert_decoder_to_nvfp4(vae.decoder,\n'
                '                                     rotation_group=rotation,\n'
                '                                     compute_dtype=torch.bfloat16,\n'
                '                                     act_scale=act_scale)\n'
                '            checkpoint = variant_checkpoint(name, args)\n'
                '            if checkpoint:\n'
                '                state = torch.load(checkpoint, map_location=device)\n'
                '                vae.decoder.load_state_dict(state["decoder"], strict=True)\n'
                '                vae.post_quant_conv.load_state_dict(state["post_quant_conv"], strict=True)\n'
                '            vae.requires_grad_(False)'
            ),
            (
                '        if "nvfp4" in mods:\n'
                '            checkpoint = variant_checkpoint(name, args)\n'
                '            packed_checkpoint = None\n'
                '            if checkpoint:\n'
                '                packed_checkpoint = torch.load(checkpoint, map_location=device, weights_only=True)\n'
                '            if packed_checkpoint and packed_checkpoint.get("format") == "fastvideo_h3_decoder_nvfp4_packed_v1":\n'
                '                from fastvideo.models.vaes.minimax_h3_nvfp4_checkpoint import apply_packed_nvfp4_decoder\n'
                '\n'
                '                apply_packed_nvfp4_decoder(vae, packed_checkpoint)\n'
                '            else:\n'
                '                from fastvideo.models.vaes.minimax_h3_nvfp4_decoder import convert_decoder_to_nvfp4\n'
                '\n'
                '                rotation = next((int(m[1:]) for m in mods if m.startswith("r") and m[1:].isdigit()), None)\n'
                '                act_scale = "unit" if "unit" in mods else "static" if "static" in mods else "dynamic"\n'
                '                convert_decoder_to_nvfp4(vae.decoder,\n'
                '                                         rotation_group=rotation,\n'
                '                                         compute_dtype=torch.bfloat16,\n'
                '                                         act_scale=act_scale)\n'
                '                if packed_checkpoint:\n'
                '                    vae.decoder.load_state_dict(packed_checkpoint["decoder"], strict=True)\n'
                '                    vae.post_quant_conv.load_state_dict(packed_checkpoint["post_quant_conv"], strict=True)\n'
                '            vae.requires_grad_(False)'
            ),
        ),
    )
    for old, new in replacements:
        if old not in source:
            raise RuntimeError(f"Pinned FastVideo benchmark source did not contain expected text: {old[:100]!r}")
        source = source.replace(old, new, 1)
    return patch_sampler_fixtures(source) if sampler_fixtures else source


def patch_sampler_fixtures(source: str) -> str:
    """Bridge trusted normalized Comfy captures into FastVideo's raw latent domain.

    Exact source anchors deliberately fail closed when the pinned upstream
    implementation changes. MP4 mode retains its original timing path.
    """
    fixture_loader = textwrap.dedent('''\
        if args.latents:
            from safetensors import safe_open
            from safetensors.torch import load_file

            # Pinned Comfy MiniMaxH3VideoVAE.decode expects normalized NCTHW and
            # applies z * latents_std + latents_mean before decode. FastVideo's
            # decoder expects the resulting raw NCTHW. Verify all 24 statistics
            # against the pinned Comfy implementation, never infer the domain.
            expected_mean = torch.tensor([
                0.858090341091156, -0.9606591463088989, 1.0661640167236328, -0.5090325474739075,
                -0.2727581858634949, -1.3675414323806763, -0.2553254961967468, -0.26907554268836975,
                -0.5376840829849243, -0.0464097298681736, 0.6657370328903198, 0.19690127670764923,
                -0.5460608005523682, -0.4035342037677765, -0.23683024942874908, 0.25928452610969543,
                -0.30133944749832153, 0.211341992020607, -1.1206848621368408, 0.3581933379173279,
                -0.04225143790245056, 0.2604829967021942, 0.22864092886447906, 0.7056031823158264,
            ], dtype=torch.float32)
            expected_std = torch.tensor([
                1.2223774194717407, 1.2767263650894165, 1.68317747116088865, 1.7549455165863037,
                1.5636216402053833, 2.194143533706665, 0.96531379222869875, 1.05698859691619875,
                0.841948926448822, 0.7729952931404114, 1.8955937623977661, 0.946841835975647,
                0.7996809482574463, 0.44988900423049925, 0.7197399735450745, 0.69362932443618775,
                2.961095094680786, 2.7694199085235595, 3.0496184825897215, 2.1088054180145265,
                3.276226282119751, 3.1627357006073, 2.28168129920959475, 2.6127843856811525,
            ], dtype=torch.float32)
            mean = vae.latents_mean.detach().float().view(-1).cpu()
            std = vae.latents_std.detach().float().view(-1).cpu()
            if not torch.equal(mean, expected_mean) or not torch.equal(std, expected_std):
                raise ValueError("FastVideo VAE latent statistics differ from pinned Comfy H3")
            paths = sorted(glob.glob(args.latents))
            if not paths:
                raise FileNotFoundError(args.latents)
            clips = []
            for path in paths:
                if Path(path).suffix != ".safetensors":
                    raise ValueError("sampler fixtures must use safetensors, never torch pickle")
                with safe_open(path, framework="pt", device="cpu") as reader:
                    metadata = reader.metadata() or {}
                decode_dtype = metadata.get("vae_decode_dtype")
                if decode_dtype not in ("torch.float16", "torch.bfloat16", "torch.float32"):
                    raise ValueError("sampler fixture VAE decode input dtype is missing or unsupported")
                tensors = load_file(path, device="cpu")
                if set(tensors) != {"latent"}:
                    raise ValueError("sampler fixture must contain exactly one latent tensor")
                normalized = tensors["latent"]
                if (tuple(normalized.shape) != (1, 24, 107, 20, 32)
                        or not normalized.is_floating_point() or not torch.isfinite(normalized).all()):
                    raise ValueError("incompatible or non-finite normalized sampler latent")
                SAMPLER_DTYPE_BY_CLIP[Path(path).stem] = decode_dtype
                clips.append(Clip(Path(path).stem, normalized, None))
            return clips
    ''')
    fixture_timing = textwrap.dedent('''\
        def select_benchmark_variants(requested: list[str], *, skip_reference: bool, fixture_mode: bool) -> list[str]:
            """The optional fixture diagnostic loads reference stats without decoding it."""
            variants = [name.strip() for name in requested if name.strip() and name.strip() != REFERENCE]
            if fixture_mode and any(name == "taeh3" or name.startswith("taeh3_") for name in variants):
                raise ValueError("TAEH3 sampler fixtures require the native Comfy decoder adapter")
            if skip_reference:
                if not fixture_mode:
                    raise ValueError("skipping the reference decode requires sampler fixtures")
                if not variants:
                    raise ValueError("at least one candidate is required when skipping the reference decode")
                return variants
            return [REFERENCE, *variants]


        def fixture_rgb24(out: torch.Tensor) -> torch.Tensor:
            """Use production's clamped uint8 truncation and return owned THWC pixels."""
            return (out[0].clamp(0, 1).mul(255).to(torch.uint8)
                    .permute(1, 2, 3, 0).contiguous().to(device="cpu", copy=True))


        def save_fixture_float_pixels(video: torch.Tensor, path: Path) -> str:
            """Write unclipped-precision, clamped RGB pixels after timing on the worker."""
            import hashlib
            from safetensors.torch import save_file
            if video.ndim != 5 or video.shape[0] != 1 or video.shape[1] != 3:
                raise ValueError("float pixel artifact must have [1,3,T,H,W] shape")
            if path.exists():
                raise FileExistsError(path)
            pixels = video.detach().to(device="cpu", dtype=torch.float32).contiguous()
            if not torch.isfinite(pixels).all() or pixels.min().item() < 0 or pixels.max().item() > 1:
                raise ValueError("float pixel artifact must contain finite RGB in [0,1]")
            save_file({"pixels": pixels}, str(path), metadata={"layout": "NCTHW", "domain": "RGB01"})
            digest = hashlib.sha256()
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            return digest.hexdigest()


        def timed_sampler_fixture(fn: Callable[[], torch.Tensor], repeats: int, bridge_events: list):
            """Decode and reach owned host RGB24; GPU event timing excludes packing."""
            import hashlib
            for _ in range(2):
                warm = fn()
                torch.cuda.synchronize()
                del warm
            decode_times, boundary_times, gpu_ms, bridge_gpu_ms, rgb_hashes, pixel_mins, pixel_maxs = [], [], [], [], [], [], []
            out = rgb = None
            for _ in range(repeats):
                if out is not None:
                    del out
                    out = None
                if rgb is not None:
                    del rgb
                    rgb = None
                torch.cuda.synchronize()
                begin, end = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
                start = time.perf_counter()
                begin.record()
                out = fn()
                end.record()
                torch.cuda.synchronize()
                decode_times.append(time.perf_counter() - start)
                gpu_ms.append(begin.elapsed_time(end))
                bridge_gpu_ms.append(bridge_events[-1][0].elapsed_time(bridge_events[-1][1]))
                if out.ndim != 5 or tuple(out.shape) != (1, 3, 362, 320, 512):
                    raise ValueError(f"decoded output has unexpected shape: {tuple(out.shape)}")
                rgb = fixture_rgb24(out)
                torch.cuda.synchronize()
                boundary_times.append(time.perf_counter() - start)
                if not bool(torch.isfinite(out).all().item()):
                    raise ValueError("candidate produced non-finite pixels before clamping")
                pixel_mins.append(float(out.min().item()))
                pixel_maxs.append(float(out.max().item()))
                rgb_hashes.append(hashlib.sha256(memoryview(rgb.numpy())).hexdigest())
            assert out is not None and rgb is not None
            return out.clamp(0, 1), decode_times, boundary_times, gpu_ms, bridge_gpu_ms, pixel_mins, pixel_maxs, rgb_hashes


    ''')
    old_latents = (
        '    if args.latents:\n'
        '        paths = sorted(glob.glob(args.latents))\n'
        '        if not paths:\n'
        '            raise FileNotFoundError(args.latents)\n'
        '        return [Clip(Path(path).stem, torch.load(path, map_location="cpu").float(), None) for path in paths]'
    )
    substitutions = (
        ('REFERENCE = "full_fp32"', 'REFERENCE = "full_fp32"\nSAMPLER_DTYPE_BY_CLIP = {}'),
        ('source.add_argument("--latents", help="glob of raw (denormalized) NCTHW latents saved with torch.save")',
         'source.add_argument("--latents", help="glob of checksum-validated Comfy normalized H3 safetensors fixtures")'),
        ('    parser.add_argument("--save-videos", action="store_true")',
         ('    parser.add_argument("--save-videos", action="store_true")\n'
          '    parser.add_argument("--save-float-pixels", action="store_true", help="save fixture RGB float32 safetensors after timing")\n'
          '    parser.add_argument("--skip-reference-decode", action="store_true", help="fixture diagnostic: load reference for stats but do not decode it")')),
        (old_latents, textwrap.indent(fixture_loader.rstrip(), '    ')),
        ('\ndef psnr(a: torch.Tensor, b: torch.Tensor) -> float:',
         '\n' + fixture_timing + 'def psnr(a: torch.Tensor, b: torch.Tensor) -> float:'),
        (('    variants = [v.strip() for v in args.variants.split(",") if v.strip()]\n'
          '    if REFERENCE in variants:\n'
          '        variants.remove(REFERENCE)\n'
          '    variants.insert(0, REFERENCE)'),
         '    variants = select_benchmark_variants(args.variants.split(","), skip_reference=args.skip_reference_decode, fixture_mode=bool(args.latents))'),
        ('def decode_fn(vae: nn.Module, z: torch.Tensor, *, autocast: torch.dtype | None) -> Callable[[], torch.Tensor]:',
         'def decode_fn(vae: nn.Module, z: torch.Tensor, *, autocast: torch.dtype | None, clamp_output: bool = True, vae_input_dtype: torch.dtype | None = None, bridge_events: list | None = None, target_device: torch.device | None = None) -> Callable[[], torch.Tensor]:'),
        ('        with ctx:\n            sample = vae.decode(z, return_dict=False)[0]',
         ('        raw_z = z\n'
          '        if vae_input_dtype is not None:\n'
          '            bridge_begin, bridge_end = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)\n'
          '            bridge_begin.record()\n'
          '            if target_device is None or z.device.type != "cpu" or target_device.type != "cuda":\n'
          '                raise ValueError("fixture decode requires CPU latents and a CUDA target")\n'
          '            normalized = z.to(device=target_device, dtype=vae_input_dtype)\n'
          '            raw_z = (normalized * vae.latents_std.to(normalized) + vae.latents_mean.to(normalized)).float()\n'
          '            bridge_end.record()\n'
          '            if bridge_events is None:\n'
          '                raise ValueError("bridge timing events are required")\n'
          '            bridge_events.append((bridge_begin, bridge_end))\n'
          '        with ctx:\n            sample = vae.decode(raw_z, return_dict=False)[0]')),
        ('        return vae.denormalize_pixels(sample.float()).clamp_(0, 1)',
         ('        pixels = vae.denormalize_pixels(sample.float())\n'
          '        return pixels.clamp_(0, 1) if clamp_output else pixels')),
        ('        z = clip.latents.to(device=device, dtype=torch.float32)',
         '        z = clip.latents if args.latents else clip.latents.to(device=device, dtype=torch.float32)'),
        ('                        fn = decode_fn(vae, z, autocast=autocast)',
         ('                        bridge_events = []\n'
          '                        input_dtype = None\n'
          '                        if args.latents:\n'
          '                            input_dtype = {"torch.float16": torch.float16, "torch.bfloat16": torch.bfloat16, "torch.float32": torch.float32}[SAMPLER_DTYPE_BY_CLIP[clip.name]]\n'
          '                        fn = decode_fn(vae, z, autocast=autocast, clamp_output=not bool(args.latents), vae_input_dtype=input_dtype, bridge_events=bridge_events, target_device=device if args.latents else None)')),
        ('    if name not in cache:\n        vae = load_h3_vae(',
         ('    if args.latents:\n'
         '        for cached_name, cached_vae in cache.items():\n'
         '            if cached_name != name:\n'
         '                cached_vae.to("cpu")\n'
         '        if name in cache:\n'
         '            cache[name].to(device)\n'
          '    if name not in cache:\n        vae = load_h3_vae(')),
        ('                          int8_overlay="int8" in mods)\n        for mod in mods:',
         ('                          int8_overlay="int8" in mods)\n'
         '        if args.latents and name != REFERENCE:\n'
         '            source_vae = cache.get(REFERENCE)\n'
         '            if source_vae is None:\n'
         '                raise ValueError("missing source VAE for latent-domain compatibility")\n'
         '            for buffer_name in ("latents_mean", "latents_std"):\n'
         '                actual = getattr(vae, buffer_name).detach().float().cpu()\n'
         '                expected = getattr(source_vae, buffer_name).detach().float().cpu()\n'
         '                if actual.shape != expected.shape or not torch.equal(actual, expected):\n'
         '                    raise ValueError(f"candidate VAE {buffer_name} differs from source")\n'
          '        for mod in mods:')),
        ('                    video, times = timed(fn, args.repeats)',
         ('                    if args.latents:\n'
         '                        video, times, boundary_times, gpu_ms, bridge_gpu_ms, pixel_mins, pixel_maxs, rgb_hashes = timed_sampler_fixture(fn, args.repeats, bridge_events)\n'
         '                    else:\n'
          '                        video, times = timed(fn, args.repeats)')),
        ('                    if reference is None:\n                        reference = video',
         ('                    if args.latents:\n'
         '                        import hashlib\n'
         '                        row.update(decode_seconds=times, common_boundary_seconds=boundary_times, gpu_ms=gpu_ms, bridge_gpu_ms=bridge_gpu_ms,\n'
         '                                   preclamp_min=pixel_mins, preclamp_max=pixel_maxs, preclamp_scope="each_repeat",\n'
         '                                   rgb24_sha256=rgb_hashes, repeatable_rgb=len(set(rgb_hashes)) == 1,\n'
         '                                   normalized_latent_sha256=hashlib.sha256(memoryview(clip.latents.contiguous().numpy())).hexdigest(),\n'
         '                                   latent_dtype=str(clip.latents.dtype), vae_decode_dtype=SAMPLER_DTYPE_BY_CLIP[clip.name],\n'
         '                                   latent_conversion="cast to VAE dtype; normalized * std + mean; float32 on every timed call",\n'
         '                                   input_h2d_included=True, input_h2d_scope="cpu_to_cuda_each_timed_decode",\n'
         '                                   output_boundary="owned_host_rgb24_uint8_thwc",\n'
         '                                   peak_scope="decode_and_rgb_pack",\n'
         '                                   reference_decode_skipped=args.skip_reference_decode,\n'
         '                                   quality_status="unqualified_no_comfy_control_or_human_review")\n'
          '                    if args.skip_reference_decode:\n'
          '                        pass\n'
          '                    elif reference is None:\n                        reference = video.cpu() if args.latents else video')),
        ('                        row["vs_full_fp32"] = fidelity(video, reference)',
         '                        row["vs_full_fp32"] = fidelity(video, reference.to(video.device) if args.latents else reference)'),
        ('                    # Compiled variants decode the same numbers as their eager form; save one copy.',
         ('                    if args.save_float_pixels:\n'
          '                        if not args.latents:\n'
          '                            raise ValueError("float pixel artifacts require sampler fixtures")\n'
          '                        output_path = out_dir / f"{clip.name}__{name}.safetensors"\n'
          '                        row["float_pixels_sha256"] = save_fixture_float_pixels(video, output_path)\n'
          '                        row["float_pixels_file"] = output_path.name\n'
          '                    # Compiled variants decode the same numbers as their eager form; save one copy.')),
        ('                        torch.save((video * 255).round().to(torch.uint8).cpu(), out_dir / f"{clip.name}__{name}.pt")',
         ('                        if args.latents:\n'
          '                            torch.save(video.mul(255).to(torch.uint8).cpu(), out_dir / f"{clip.name}__{name}.pt")\n'
          '                        else:\n'
          '                            torch.save((video * 255).round().to(torch.uint8).cpu(), out_dir / f"{clip.name}__{name}.pt")')),
    )
    for old, new in substitutions:
        if old not in source:
            raise RuntimeError(f"Pinned FastVideo benchmark source did not contain expected text: {old[:100]!r}")
        source = source.replace(old, new, 1)
    return source


def main() -> None:
    path = Path(sys.argv[1])
    source = patch_source(path.read_text(encoding="utf-8"))
    path.write_text(source, encoding="utf-8")


if __name__ == "__main__":
    main()
