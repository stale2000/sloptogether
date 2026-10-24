"""Independent MiniMax-H3 SoL video-refinement node."""

from .node import (
    MiniMaxH3SoLParallelBenchmark,
    MiniMaxH3SoLSharedVAEBenchmark,
    MiniMaxH3SoLUpscaler,
)

NODE_CLASS_MAPPINGS = {
    "ComfyStreamMiniMaxH3SoLUpscaler": MiniMaxH3SoLUpscaler,
    "ComfyStreamMiniMaxH3SoLParallelBenchmark": MiniMaxH3SoLParallelBenchmark,
    "ComfyStreamMiniMaxH3SoLSharedVAEBenchmark": MiniMaxH3SoLSharedVAEBenchmark,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "ComfyStreamMiniMaxH3SoLUpscaler": "MiniMax-H3 SoL Upscaler (LTX-2.5)",
    "ComfyStreamMiniMaxH3SoLParallelBenchmark": "MiniMax-H3 SoL Upscaler (Multi-GPU Benchmark)",
    "ComfyStreamMiniMaxH3SoLSharedVAEBenchmark": "MiniMax-H3 SoL Upscaler (Shared VAE GPU Benchmark)",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
