# Maintained fused NVFP4 preprocessing fork

Source: https://github.com/ByronLeeeee/ComfyUI-MiniMax-H3-Optimization-Suite
Commit: de62f42e0f597c23cb44abca0940a6a89089bad5
Original path: plugins/ComfyUI-H3-NVFP4-Fused-MLP/kernels.py
Local path: kernel.py. This repository maintains a modified fork, so its Python
files are included in the strict deployment typecheck. Upstream MIT license
and attribution remain in LICENSE.
The source comments retain its comfy-kitchen quantizer attribution.

Local changes include the reusable `fused_swiglu_nvfp4_tensor_scale` entrypoint
for full-layout calibration, dynamic `packed_rows` store bounds to avoid
recompiling for each active-token count, and explicit Tensor/Triton typing.
The existing precision modes, quantization arithmetic, packing layout,
`tl.constexpr` parameters, and launch defaults remain intact.

The fused MLP bridge imports this kernel when selected by the model loader.
Triton and a supported CUDA runtime are required. Inclusion does not establish
successful JIT compilation or performance on Comfy Deploy. The adapter raises
on unsupported execution instead of silently falling back.
