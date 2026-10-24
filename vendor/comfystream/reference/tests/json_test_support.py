"""Assert JSON structure before inspecting nested contract fixture values."""

from __future__ import annotations

from collections.abc import Mapping, Sequence


def value_at(value: object, *path: str | int) -> object:
    for key in path:
        if isinstance(key, str):
            assert isinstance(value, Mapping), f"expected JSON object at {key!r}"
            value = value[key]
        else:
            assert isinstance(value, Sequence) and not isinstance(value, str)
            value = value[key]
    return value


def object_value(value: object) -> Mapping[str, object]:
    assert isinstance(value, Mapping), "expected JSON object"
    return value


def array_value(value: object) -> Sequence[object]:
    assert isinstance(value, Sequence) and not isinstance(value, str), "expected JSON array"
    return value


def string_value(value: object) -> str:
    assert isinstance(value, str), "expected JSON string"
    return value


def mutable_object(value: object) -> dict[str, object]:
    assert isinstance(value, dict), "expected mutable JSON object"
    return value


def mutable_array(value: object) -> list[object]:
    assert isinstance(value, list), "expected mutable JSON array"
    return value


def integer_value(value: object) -> int:
    assert isinstance(value, int) and not isinstance(value, bool), "expected JSON integer"
    return value
