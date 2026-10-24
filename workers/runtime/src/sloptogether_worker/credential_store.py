from __future__ import annotations

import os
import sys
from pathlib import Path


def save_secret(path: Path, secret: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        data = _dpapi_protect(secret.encode("utf-8"))
        path.write_bytes(b"SLP1" + data)
    else:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(secret.encode("utf-8"))
        path.chmod(0o600)


def load_secret(path: Path) -> str:
    data = path.read_bytes()
    if os.name == "nt":
        if not data.startswith(b"SLP1"):
            raise ValueError("worker_key_file_is_not_dpapi_protected")
        return _dpapi_unprotect(data[4:]).decode("utf-8")
    info = path.stat()
    if info.st_mode & 0o077:
        raise ValueError("worker_key_file_permissions_must_be_0600")
    return data.decode("utf-8").strip()


def _dpapi_transform(data: bytes, *, protect: bool) -> bytes:
    if sys.platform != "win32":
        raise ValueError("windows_dpapi_is_unavailable")
    import ctypes
    from ctypes import wintypes

    class DataBlob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]

    input_buffer = ctypes.create_string_buffer(data, len(data))
    source = DataBlob(len(data), ctypes.cast(input_buffer, ctypes.POINTER(ctypes.c_ubyte)))
    target = DataBlob()
    crypt = ctypes.WinDLL("Crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("Kernel32", use_last_error=True)
    if protect:
        call = crypt.CryptProtectData
        ok = call(ctypes.byref(source), "SlopTogether worker key", None, None, None, 0x1, ctypes.byref(target))
    else:
        call = crypt.CryptUnprotectData
        ok = call(ctypes.byref(source), None, None, None, None, 0x1, ctypes.byref(target))
    if not ok:
        raise OSError(ctypes.get_last_error(), "Windows credential protection failed")
    try:
        return ctypes.string_at(target.pbData, target.cbData)
    finally:
        kernel.LocalFree(target.pbData)


def _dpapi_protect(data: bytes) -> bytes:
    return _dpapi_transform(data, protect=True)


def _dpapi_unprotect(data: bytes) -> bytes:
    return _dpapi_transform(data, protect=False)
