"""Request-owned H3 invariant-work experiments; native source stays untouched."""

from __future__ import annotations

import inspect
import sys
import textwrap
import types
import weakref
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from typing import TYPE_CHECKING, cast

if TYPE_CHECKING:
    from comfy.ldm.minimax.model import MiniMaxH3Model
    from comfy.model_patcher import ModelPatcher


import torch

try:
    from . import memory_features as mf
except ImportError:
    import memory_features as mf  # type: ignore[no-redef]

type _Modulation = Callable[[torch.Tensor, torch.Tensor, torch.Tensor, Sequence[tuple[int, int, int | torch.Tensor]]], torch.Tensor]


FLAGS = ('share_timestep_silu', 'cache_inference_rope', 'cache_text_tag_runs',
         'cache_reference_rows', 'release_dit_attention_input', 'profile_modulation',
         'fuse_modulation_segments', 'cache_fixed_adaln', 'fuse_modulation_kernel',
         'rounded_modulation_scale_shift')


def _eager_if_transformer_compiled[**P, T](model: object, function: Callable[P, T]) -> Callable[P, T]:
    """Keep request-scoped Python cache bookkeeping outside a compiled graph."""
    if not getattr(model, '_comfystreamerh3_compile_forward', False):
        return function
    disable = getattr(getattr(torch, '_dynamo', None), 'disable', None)
    if not callable(disable):
        raise TypeError('compiled inference features require torch._dynamo.disable')
    wrapped = disable(function)
    report = getattr(model, '_comfystreamerh3_compile_report', None)
    if isinstance(report, dict):
        helpers = report.setdefault('request_scoped_eager_helpers', [])
        name = getattr(function, '__name__', type(function).__name__)
        if name not in helpers:
            helpers.append(name)
    return cast(Callable[P, T], wrapped)


class TensorMemo[T]:
    """One bounded entry. Content checks handle inference tensors without versions.

    Equality can synchronize CUDA. Reported hits are correctness evidence, not
    proof of faster execution; price this cost in the real benchmark.
    """
    def __init__(self, max_bytes: int=64 * 1024 * 1024) -> None:
        self.entry: tuple[object, list[tuple[object, ...]], list[torch.Tensor], T, tuple[torch.Tensor, ...]] | None = None
        self.max_bytes = max_bytes

    def get(self, tensors: Iterable[torch.Tensor], metadata: object, compute: Callable[[], T], flag: str) -> T:
        tensors = tuple(tensors)
        if sum(t.numel() * t.element_size() for t in tensors) > self.max_bytes:
            return compute()
        signatures: list[tuple[object, ...]] = []
        for t in tensors:
            try:
                version = t._version
            except RuntimeError:
                version = None
            signatures.append((id(t), version, tuple(t.shape), t.dtype, t.device))
        entry = self.entry
        if (entry and entry[0] == metadata and entry[1] == signatures
                and all(sig[1] is not None or torch.equal(t, snap)
                        for t, snap, sig in zip(tensors, entry[2], signatures))):
            mf.hit(flag)
            return entry[3]
        value = compute()
        value_bytes = value.numel() * value.element_size() if isinstance(value, torch.Tensor) else 0
        if value_bytes + sum(t.numel() * t.element_size() for t in tensors) <= self.max_bytes:
            # Retain originals to prevent id reuse, plus snapshots for inference tensors.
            self.entry = (metadata, signatures, [t.clone() if s[1] is None else t for t, s in zip(tensors, signatures)], value, tensors)
        else:
            self.entry = None
        return value


class FixedAdalnCache:
    """Bounded per-model cache for AdaLN projections at a fixed H3 schedule."""

    def __init__(self, entries_per_projection: int=4) -> None:
        self.entries_per_projection = entries_per_projection
        self._entries: weakref.WeakKeyDictionary[torch.nn.Module, dict[tuple[object, ...], torch.Tensor]] = weakref.WeakKeyDictionary()
        self._key: tuple[float, ...] | None = None

    @staticmethod
    def _weight_version(projection: torch.nn.Module) -> tuple[int | None, ...]:
        linear = getattr(projection, 'linear', projection)
        versions = []
        for name in ('weight', 'bias'):
            tensor = getattr(linear, name, None)
            try:
                versions.append(getattr(tensor, '_version', None))
            except RuntimeError:
                # Comfy inference tensors deliberately do not expose version
                # counters. The projection object itself remains the cache owner;
                # a changed/replaced model owns a different cache instance.
                versions.append(None)
        return tuple(versions)

    def begin(self, values: Iterable[float]) -> None:
        # ``unique_t`` is made from Python scalars by native H3, avoiding a
        # synchronization/hash of the GPU projection tensor for every block.
        self._key = tuple(float(value) for value in values)

    def clear_current_key(self) -> None:
        self._key = None

    def get(self, projection: torch.nn.Module, t_emb: torch.Tensor, compute: Callable[[], torch.Tensor]) -> torch.Tensor:
        if self._key is None:
            return compute()
        key = (self._key, str(t_emb.device), t_emb.dtype, tuple(t_emb.shape),
               self._weight_version(projection))
        entries = self._entries.setdefault(projection, {})
        value = entries.get(key)
        if value is not None:
            entries.pop(key)
            entries[key] = value
            mf.hit('cache_fixed_adaln')
            mf.metric('cache_fixed_adaln_rows', t_emb.shape[0])
            return value
        value = compute()
        entries[key] = value
        while len(entries) > self.entries_per_projection:
            entries.pop(next(iter(entries)))
        mf.metric('cache_fixed_adaln_misses', 1)
        return value


def tag_runs(tags: torch.Tensor, length: int) -> list[tuple[int, int, int]]:
    values = tags.view(-1).tolist()
    if len(values) < length:
        raise ValueError('text tag length does not cover text segment')
    runs, start = [], 0
    for i in range(1, length + 1):
        if i == length or values[i] != values[start]:
            runs.append((start, i, int(values[start])))
            start = i
    return runs


def rewrite_method[**P, T](method: Callable[P, T], replacements: Sequence[tuple[str, str]], helpers: Mapping[str, object]) -> Callable[P, T]:
    """Clone only known native bodies, preserving the installed layout wrapper.

    Refuse unexpected source instead of dropping wrapper/patch semantics. No
    global monkey-patch or core-file edit is performed.
    """
    fn = cast(types.FunctionType, getattr(method, '__func__', method))
    closure = fn.__closure__
    if closure and 'original_forward' in fn.__code__.co_freevars:
        cells = list(closure)
        i = fn.__code__.co_freevars.index('original_forward')
        replaced = rewrite_method(cells[i].cell_contents, replacements, helpers)
        def capture(value: object) -> types.FunctionType:
            return cast(types.FunctionType, lambda: value)
        cells[i] = cast(tuple[types.CellType, ...], capture(replaced).__closure__)[0]
        result = types.FunctionType(fn.__code__, fn.__globals__, fn.__name__, fn.__defaults__, tuple(cells))
        result.__kwdefaults__ = fn.__kwdefaults__
    else:
        if fn.__module__ != 'comfy.ldm.minimax.model' or closure:
            code = getattr(fn, '__code__', None)
            closure_names = () if not closure or code is None else code.co_freevars
            cell_types = () if not closure else tuple(
                type(cell.cell_contents).__module__ + '.' + type(cell.cell_contents).__qualname__
                for cell in closure
            )
            raise ValueError(
                'unsupported inference forward override: '
                f'module={getattr(fn, "__module__", None)!r}, '
                f'function={getattr(fn, "__qualname__", type(fn).__qualname__)!r}, '
                f'freevars={closure_names!r}, cell_types={cell_types!r}'
            )
        source = textwrap.dedent(inspect.getsource(fn))
        for old, new in replacements:
            if source.count(old) != 1:
                raise ValueError('native H3 source changed; experiment requires a new parity review')
            source = source.replace(old, new)
        namespace = dict(fn.__globals__, **helpers)
        exec(compile(source, '<fasth3-inference-experiment>', 'exec'), namespace)  # noqa: S102
        result = namespace[fn.__name__]
    return cast(Callable[P, T], types.MethodType(result, method.__self__) if inspect.ismethod(method) else result)


@contextmanager
def inference_experiments(patcher: ModelPatcher) -> Iterator[None]:
    if not any(mf.enabled(f) for f in FLAGS):
        yield
        return
    if (mf.enabled('fuse_modulation_kernel')
            and mf.enabled('rounded_modulation_scale_shift')):
        raise ValueError('rounded modulation and killed B15 kernel are mutually exclusive')
    model = getattr(getattr(patcher, 'model', None), 'diffusion_model', None)
    if model is None or not any(c.__name__ == 'MiniMaxH3Model' and c.__module__ == 'comfy.ldm.minimax.model' for c in type(model).__mro__):
        raise ValueError('inference experiments require native H3 model')
    restores = []
    def install(obj: object, name: str, value: object) -> None:
        restores.append((obj, name, name in obj.__dict__, obj.__dict__.get(name)))
        setattr(obj, name, value)
    silu: TensorMemo[torch.Tensor] = TensorMemo()
    rope: TensorMemo[torch.Tensor] = TensorMemo()
    tags: TensorMemo[list[tuple[int, int, int]]] = TensorMemo()
    fixed_adaln = None
    try:
        native_model = None
        if (mf.enabled('profile_modulation') or mf.enabled('fuse_modulation_segments')
                or mf.enabled('fuse_modulation_kernel')
                or mf.enabled('rounded_modulation_scale_shift')):
            native_model = sys.modules.get('comfy.ldm.minimax.model')
            if native_model is None:
                import comfy.ldm.minimax.model as _native_model
                native_model = _native_model
        if mf.enabled('profile_modulation'):
            try:
                from . import nvtx
            except ImportError:  # pragma: no cover - standalone tests
                import nvtx  # type: ignore[no-redef]
            for name, stage in (('_mod_scale_shift', 'mod_scale_shift'), ('_mod_gate', 'mod_gate')):
                operation = getattr(native_model, name, None)
                if not callable(operation):
                    continue
                operation_fn = cast(_Modulation, operation)
                def timed_for[**P](original: Callable[P, torch.Tensor], stage: str) -> Callable[P, torch.Tensor]:
                    def timed(*args: P.args, **kwargs: P.kwargs) -> torch.Tensor:
                        segments = cast(Sequence[object], args[3])
                        mf.hit('profile_modulation')
                        mf.metric(stage + '_segments', len(segments))
                        with nvtx.nvtx_range(stage):
                            return original(*args, **kwargs)
                    return timed
                install(native_model, name, timed_for(operation_fn, stage))
        if mf.enabled('fuse_modulation_segments'):
            try:
                from . import modulation_fusion
            except ImportError:  # pragma: no cover - standalone tests
                import modulation_fusion  # type: ignore[no-redef]
            native_scale = getattr(native_model, '_mod_scale_shift', None)
            native_gate = getattr(native_model, '_mod_gate', None)
            if callable(native_scale) and callable(native_gate):
                def fused_scale(h: torch.Tensor, shift: torch.Tensor, scale: torch.Tensor, segments: Sequence[tuple[int, int, int | torch.Tensor]]) -> torch.Tensor:
                    result, used = modulation_fusion.scale_shift(h, shift, scale, segments, cast(_Modulation, native_scale))
                    if used:
                        mf.hit('fuse_modulation_segments')
                    return result
                def fused_gate(x: torch.Tensor, gate: torch.Tensor, other: torch.Tensor, segments: Sequence[tuple[int, int, int | torch.Tensor]]) -> torch.Tensor:
                    result, used = modulation_fusion.gate(x, gate, other, segments, cast(_Modulation, native_gate))
                    if used:
                        mf.hit('fuse_modulation_segments')
                    return result
                install(native_model, '_mod_scale_shift', fused_scale)
                install(native_model, '_mod_gate', fused_gate)
        if mf.enabled('fuse_modulation_kernel'):
            try:
                from . import modulation_fusion
            except ImportError:  # pragma: no cover - standalone tests
                import modulation_fusion  # type: ignore[no-redef]
            native_scale = getattr(native_model, '_mod_scale_shift', None)
            native_gate = getattr(native_model, '_mod_gate', None)
            if callable(native_scale) and callable(native_gate):
                def kernel_scale(h: torch.Tensor, shift: torch.Tensor, scale: torch.Tensor, segments: Sequence[tuple[int, int, int | torch.Tensor]]) -> torch.Tensor:
                    result, used = modulation_fusion.scale_shift_kernel(
                        h, shift, scale, segments, cast(_Modulation, native_scale))
                    if used:
                        mf.hit('fuse_modulation_kernel')
                    return result
                def kernel_gate(x: torch.Tensor, gate: torch.Tensor, other: torch.Tensor, segments: Sequence[tuple[int, int, int | torch.Tensor]]) -> torch.Tensor:
                    result, used = modulation_fusion.gate_kernel(
                        x, gate, other, segments, cast(_Modulation, native_gate))
                    if used:
                        mf.hit('fuse_modulation_kernel')
                    return result
                install(native_model, '_mod_scale_shift', kernel_scale)
                install(native_model, '_mod_gate', kernel_gate)
        if mf.enabled('rounded_modulation_scale_shift'):
            try:
                from . import modulation_fusion
            except ImportError:  # pragma: no cover - standalone tests
                import modulation_fusion  # type: ignore[no-redef]
            native_scale = getattr(native_model, '_mod_scale_shift', None)
            if callable(native_scale):
                def staged_scale(h: torch.Tensor, shift: torch.Tensor, scale: torch.Tensor, segments: Sequence[tuple[int, int, int | torch.Tensor]]) -> torch.Tensor:
                    result, used = modulation_fusion.scale_shift_staged_kernel(
                        h, shift, scale, segments, cast(_Modulation, native_scale))
                    if used:
                        mf.hit('rounded_modulation_scale_shift')
                        mf.metric('rounded_modulation_scale_shift_segments', len(segments))
                    return result
                install(native_model, '_mod_scale_shift', staged_scale)
        if mf.enabled('share_timestep_silu'):
            def shared(t: torch.Tensor) -> torch.Tensor:
                return silu.get((t,), (), lambda: torch.nn.functional.silu(t), 'share_timestep_silu')
            shared = _eager_if_transformer_compiled(model, shared)
            for block in model.blocks:
                proj = block.adaln_proj
                if getattr(proj, 'apply_silu', False):
                    install(proj, 'forward', rewrite_method(proj.forward,
                        [('nn.functional.silu(t_emb)', '_shared_silu(t_emb)')], {'_shared_silu': shared}))
        replacements: list[tuple[str, str]] = []
        helpers: dict[str, object] = {}
        if mf.enabled('cache_fixed_adaln'):
            fixed_adaln = getattr(model, '_fasth3_fixed_adaln_cache', None)
            if fixed_adaln is None:
                fixed_adaln = FixedAdalnCache()
                # Deliberately persists across requests while the same model is
                # resident; ownership follows the model object, not a global.
                model._fasth3_fixed_adaln_cache = fixed_adaln
            for block in model.blocks:
                projection = block.adaln_proj
                projection_forward = projection.forward
                def cached_projection(t_emb: torch.Tensor, _projection: torch.nn.Module=projection, _original: Callable[[torch.Tensor], torch.Tensor]=projection_forward) -> torch.Tensor:
                    return fixed_adaln.get(_projection, t_emb, lambda: _original(t_emb))
                install(projection, 'forward', _eager_if_transformer_compiled(model, cached_projection))
            replacements.append((
                '# blocks\n    patches_replace =',
                '# blocks\n    _fixed_adaln_begin(unique_t)\n    patches_replace =',
            ))
            helpers['_fixed_adaln_begin'] = _eager_if_transformer_compiled(model, fixed_adaln.begin)
        if mf.enabled('cache_inference_rope'):
            from comfy.ldm.minimax.model import rope_rotation_table
            def cached_rope(owner: MiniMaxH3Model, position_ids: torch.Tensor, device: torch.device, dtype: torch.dtype) -> torch.Tensor:
                # Always execute the installed layout-publication hook.
                angles = owner.rope_freqs(position_ids, device)
                return rope.get((position_ids, owner.rope.inv_freq), (str(device), dtype),
                    lambda: rope_rotation_table(angles, dtype), 'cache_inference_rope')
            replacements.append(('rope_rotation_table(self.rope_freqs(layout.position_ids, device), dtype)',
                                 '_cached_rope(self, layout.position_ids, device, dtype)'))
            helpers['_cached_rope'] = _eager_if_transformer_compiled(model, cached_rope)
        if mf.enabled('cache_text_tag_runs'):
            old = '''tags = text_tags.view(-1).tolist()
                run_start = 0
                for i in range(1, b - a + 1):
                    if i == b - a or tags[i] != tags[run_start]:
                        mod_segments.append((a + run_start, a + i, row_base + int(tags[run_start])))
                        run_start = i'''
            # Dedented method body has twelve spaces at this nesting depth.
            old = old.replace('\n                ', '\n            ')
            replacements.append((old, 'mod_segments.extend((a + lo, a + hi, row_base + tag) for lo, hi, tag in _tag_runs(text_tags, b - a))'))
            def cached_tag_runs(t: torch.Tensor, n: int) -> list[tuple[int, int, int]]:
                return tags.get((t,), n, lambda: tag_runs(t, n), 'cache_text_tag_runs')
            helpers['_tag_runs'] = _eager_if_transformer_compiled(model, cached_tag_runs)
        current = model._forward
        if replacements:
            core = getattr(model, '_sol_core_forward', None)
            if callable(core):
                # The layout shell and compiler receipt both dispatch through
                # this native core. Preserve their context/cleanup callbacks.
                install(model, '_sol_core_forward', rewrite_method(core, replacements, helpers))
            else:
                current = rewrite_method(current, replacements, helpers)
        def forward(*args: object, **kwargs: object) -> list[torch.Tensor]:
            silu.entry = None  # never reuse timestep activation across Euler evaluations
            try:
                if torch.is_grad_enabled():
                    raise ValueError('inference experiments require inference/no-grad execution')
                return cast(list[torch.Tensor], current(*args, **kwargs))
            finally:
                silu.entry = None
                if fixed_adaln is not None:
                    fixed_adaln.clear_current_key()
        install(model, '_forward', forward)
        if mf.enabled('cache_reference_rows'):
            for method_name, list_key, aug_key in (
                ('_cond_video_rows', 'cond_video_latents', 'visual_cond_noise_aug'),
                ('_cond_audio_rows', 'cond_audio_latents', 'audio_cond_noise_aug')):
                rows_forward = getattr(model, method_name)
                memo: TensorMemo[torch.Tensor | None] = TensorMemo()
                def cached(payload: dict[str, object], device: torch.device, original: Callable[[dict[str, object], torch.device], torch.Tensor | None]=rows_forward, memo: TensorMemo[torch.Tensor | None]=memo, list_key: str=list_key, aug_key: str=aug_key) -> torch.Tensor | None:
                    inputs = cast(Sequence[torch.Tensor], payload.get(list_key, []))
                    if not inputs:
                        return original(payload, device)
                    meta = (payload.get('seed', 0), payload.get(aug_key), str(device), tuple(model.patch_size))
                    return memo.get(inputs, meta, lambda: original(payload, device), 'cache_reference_rows')
                install(model, method_name, _eager_if_transformer_compiled(model, cached))
        if mf.enabled('release_dit_attention_input'):
            for block in model.blocks:
                install(block, 'forward', rewrite_method(block.forward,
                    [('h = _mod_scale_shift(self.norm2(x), shift_mlp, scale_mlp, mod_segments)',
                      "del h\n    _release_hit('release_dit_attention_input')\n    h = _mod_scale_shift(self.norm2(x), shift_mlp, scale_mlp, mod_segments)")],
                    {'_release_hit': _eager_if_transformer_compiled(model, mf.hit)}))
        yield
    finally:
        for obj, name, had, value in reversed(restores):
            if had:
                setattr(obj, name, value)
            else:
                obj.__dict__.pop(name, None)
