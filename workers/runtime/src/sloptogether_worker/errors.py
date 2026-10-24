from __future__ import annotations


class WorkerError(Exception):
    """An actionable worker error with a safe, non-secret error code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class ApiError(WorkerError):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code, f"Worker service request failed ({status}, {code}).")
        self.status = status
