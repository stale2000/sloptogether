"""Drama 3 TTS through a separately installed, resident CUDA audio.cpp runtime."""

from .node import ComfyStreamDrama3TTS, ComfyStreamDrama3TTSBatch

NODE_CLASS_MAPPINGS = {
    "ComfyStreamDrama3TTS": ComfyStreamDrama3TTS,
    "ComfyStreamDrama3TTSBatch": ComfyStreamDrama3TTSBatch,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "ComfyStreamDrama3TTS": "Drama 3 Speech",
    "ComfyStreamDrama3TTSBatch": "Drama 3 Speech Pair",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
