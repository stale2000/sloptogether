"""Diagnostic captures of real H3 attention, MLP and modulation boundaries."""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Protocol, TypedDict, cast

if TYPE_CHECKING:
    from comfy.model_patcher import ModelPatcher

import torch

type SnapshotValue = torch.Tensor | str | int | float | bool | None | list[SnapshotValue] | tuple[SnapshotValue, ...]


class _ReplayOperation(Protocol):
    def __call__(self, *args: SnapshotValue, **kwargs: object) -> SnapshotValue: ...


class CaptureEntry(TypedDict, total=False):
    input: str
    input_sha256: str
    input_metadata: dict[str, object]
    required_context: list[str]
    required_context_descriptor: dict[str, dict[str, object]]
    status: str
    output: str
    output_sha256: str
    output_metadata: dict[str, object]


class CaptureReport(TypedDict):
    schema: str
    diagnostic_only: bool
    node_fingerprint: str
    block_index: int
    invocation: int
    provenance: dict[str, object]
    directory: str
    captures: dict[str, CaptureEntry]
    complete: bool


class InputFixture(TypedDict):
    args: tuple[SnapshotValue, ...]
    kwargs: dict[str, SnapshotValue]

try:
    from .build_identity import node_fingerprint
    from .decoder_replay import _hash
except ImportError:
    from build_identity import node_fingerprint  # type: ignore[no-redef]
    from decoder_replay import _hash  # type: ignore[no-redef]


def snapshot(value: object, budget: list[int], meta: dict[str, object], path: str='input') -> SnapshotValue:
    if isinstance(value, torch.Tensor):
        size = value.numel() * value.element_size()
        budget[0] -= size
        if budget[0] < 0:
            raise ValueError('intermediate capture byte budget exceeded')
        meta[path] = {'shape': list(value.shape), 'stride': list(value.stride()),
                      'dtype': str(value.dtype), 'device': str(value.device)}
        return value.detach().cpu().clone()
    if isinstance(value, (tuple, list)):
        return type(value)(snapshot(v, budget, meta, f'{path}.{i}') for i,v in enumerate(value))
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError(f'unsupported captured value at {path}')


def context_descriptor(value: object) -> dict[str, object]:
    """Describe non-tensor replay state without serializing live Comfy objects."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return {"kind": type(value).__name__, "value": value}
    if isinstance(value, (tuple, list)):
        return {"kind": type(value).__name__, "length": len(value),
                "items": [context_descriptor(item) for item in value]}
    if isinstance(value, dict):
        return {"kind": "dict", "keys": sorted(str(key) for key in value),
                "values": {str(key): context_descriptor(item)
                           for key, item in value.items()
                           if item is None or isinstance(item, (str, int, float, bool))}}
    return {"kind": type(value).__name__, "replay_required": True}


@contextmanager
def capture_intermediates(patcher: ModelPatcher, root: str | Path, *, block_index: int=0, invocation: int=0, max_bytes: int=8*1024**3, provenance: dict[str, object] | None=None) -> Iterator[CaptureReport]:
    model = getattr(getattr(patcher, 'model', None), 'diffusion_model', None)
    if model is None or not hasattr(model, 'blocks') or not 0 <= block_index < len(model.blocks):
        raise ValueError('capture requires an existing H3 block')
    if invocation < 0 or max_bytes <= 0:
        raise ValueError('invalid capture invocation or budget')
    block = model.blocks[block_index]
    root = Path(root) / uuid.uuid4().hex
    root.mkdir(parents=True, exist_ok=False)
    report: CaptureReport = {'schema':'fasth3-intermediates/1', 'diagnostic_only':True,
              'node_fingerprint':node_fingerprint(), 'block_index':block_index,
              'invocation':invocation, 'provenance':provenance or {},
              'directory':str(root), 'captures':{}, 'complete':False}
    handles: list[torch.utils.hooks.RemovableHandle] = []
    budget = [max_bytes]
    try:
        for label, module in (('attention',block.attn), ('mlp',block.mlp), ('modulation',block.adaln_proj)):
            state = {'calls':0, 'selected':False}
            def before(module: torch.nn.Module,args: tuple[object, ...],kwargs: dict[str, object],label: str=label,state: dict[str, int | bool]=state) -> None:
                index = state['calls']; state['calls'] += 1
                state['selected'] = index == invocation
                if not state['selected']: return
                meta: dict[str, object] = {}
                # Full model configuration objects remain external to this
                # tensor fixture and must be supplied explicitly when replaying.
                tensor_kwargs = {k:v for k,v in kwargs.items() if isinstance(v,torch.Tensor)}
                required = [k for k,v in kwargs.items() if not isinstance(v,torch.Tensor)]
                payload = {'args':snapshot(args,budget,meta),
                           'kwargs':{k:snapshot(v,budget,meta,k) for k,v in tensor_kwargs.items()}}
                path = root / (label+'-input.pt')
                torch.save(payload,path)
                report['captures'][label] = {'input':path.name,'input_sha256':_hash(path),
                    'input_metadata':meta,'required_context':required,
                    'required_context_descriptor': {key: context_descriptor(kwargs[key]) for key in required},
                    'status':'input_saved'}
            def after(module: torch.nn.Module,args: tuple[object, ...],kwargs: dict[str, object],output: object,label: str=label,state: dict[str, int | bool]=state) -> None:
                if not state['selected']: return
                meta: dict[str, object] = {}
                path = root / (label+'-output.pt')
                torch.save(snapshot(output,budget,meta,'output'),path)
                report['captures'][label].update({'output': path.name, 'output_sha256': _hash(path),
                                                 'output_metadata': meta, 'status': 'complete'})
            handles.append(module.register_forward_pre_hook(before,with_kwargs=True))
            handles.append(module.register_forward_hook(after,with_kwargs=True))
        yield report
        report['complete'] = len(report['captures']) == 3 and all(r['status']=='complete' for r in report['captures'].values())
    finally:
        for handle in handles: handle.remove()
        (root/'manifest.json').write_text(json.dumps(report,indent=2))


def load_intermediate(root: str | Path, label: str) -> tuple[InputFixture, SnapshotValue, CaptureEntry]:
    if label not in ('attention','mlp','modulation'):
        raise ValueError('unknown intermediate label')
    root = Path(root)
    report: object = json.loads((root/'manifest.json').read_text())
    if not isinstance(report, dict) or not isinstance(report.get('captures'), dict):
        raise TypeError('invalid intermediate manifest')
    raw_entry: object = report['captures'][label]
    if not isinstance(raw_entry, dict):
        raise TypeError('invalid intermediate capture entry')
    for key in ('input', 'output', 'input_sha256', 'output_sha256', 'status'):
        if not isinstance(raw_entry.get(key), str):
            raise TypeError('invalid intermediate capture field: ' + key)
    required = raw_entry.get('required_context')
    if not isinstance(required, list) or not all(isinstance(key, str) for key in required):
        raise ValueError('invalid intermediate context keys')
    entry = cast(CaptureEntry, raw_entry)
    if entry.get('status') != 'complete': raise ValueError('incomplete intermediate')
    for kind in ('input','output'):
        expected = label+'-'+kind+'.pt'
        if raw_entry[kind] != expected or _hash(root/expected) != raw_entry[kind+'_sha256']:
            raise ValueError('intermediate identity/hash mismatch')
    return (cast(InputFixture, torch.load(root/entry['input'],map_location='cpu',weights_only=True)),
            cast(SnapshotValue, torch.load(root/entry['output'],map_location='cpu',weights_only=True)),entry)


def replay_intermediate(root: str | Path,label: str,operation: _ReplayOperation,*,context: dict[str, object] | None=None,device: str | torch.device='cpu') -> tuple[SnapshotValue, SnapshotValue]:
    inputs,reference,entry = load_intermediate(root,label)
    context = context or {}
    if set(context) != set(entry['required_context']):
        raise ValueError('supply exactly the recorded non-tensor context')
    def move(x: SnapshotValue) -> SnapshotValue:
        if isinstance(x,torch.Tensor): return x.to(device).clone()
        if isinstance(x,(tuple,list)): return type(x)(move(v) for v in x)
        return x
    with torch.inference_mode():
        output = operation(*cast(tuple[SnapshotValue, ...], move(inputs['args'])),**{k:move(v) for k,v in inputs['kwargs'].items()},**context)
    return output,reference
