from __future__ import annotations

import re
from typing import Any

from .errors import WorkerError

SCENE_FIELDS = {
    "visual_action": 900,
    "camera": 200,
    "speaker_character": 100,
    "voice_description": 140,
    "dialogue": 300,
    "soundscape": 240,
}

SCENE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": list(SCENE_FIELDS),
    "properties": {
        name: {"type": "string", **({"minLength": 1} if name != "soundscape" else {}), "maxLength": maximum}
        for name, maximum in SCENE_FIELDS.items()
    },
}

def validate_scene(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != set(SCENE_FIELDS):
        raise WorkerError("story_schema_invalid", "Story planner output does not match the H3 scene contract.")
    result: dict[str, str] = {}
    for field, limit in SCENE_FIELDS.items():
        item = value[field]
        if not isinstance(item, str) or len(item) > limit:
            raise WorkerError("story_field_invalid", f"Story planner field {field} is invalid.")
        text = item.strip()
        if (field != "soundscape" and not text) or any(mark in text for mark in ("\r", "\n", "<", ">")):
            raise WorkerError("story_markup_invalid", "Planner output must be plain text without line breaks or tag delimiters.")
        result[field] = text
    word_count = len(re.findall(r"[^\W_]+(?:['’][^\W_]+)*", result["dialogue"]))
    if word_count > 20:
        raise WorkerError("story_dialogue_too_long", "Generated dialogue exceeds the short spoken-line limit.")
    return result


def compile_h3_prompt(scene: dict[str, str], *, on_camera: bool = True) -> str:
    values = validate_scene(scene)
    dialogue = values["dialogue"]
    if dialogue[-1] not in ".?!":
        dialogue += "."
    speaker = values["speaker_character"]
    speech = (
        f"At the beginning of this shot, {speaker} (S1), {values['voice_description']}, says: "
        f"<d>[English] {dialogue}</d> Their mouth movements follow these exact words."
        if on_camera
        else f"An off-screen narrator (S1), {values['voice_description']}, says: <d>[English] {dialogue}</d>"
    )
    return (
        f"integrated_multimodal_description: [Shot 1] {values['visual_action']} "
        f"Camera: {values['camera']} {speech}\n\n"
        f"overall_soundscape: {values['soundscape']} Everyone stays silent after the single line.\n\n"
        "non_diegetic_music: N/A"
    )
