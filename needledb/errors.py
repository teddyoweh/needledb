"""Errors shared by the engine, the server and both SDK clients (no heavy imports)."""
from __future__ import annotations


class NeedleError(Exception):
    code = "INTERNAL"
    status = 500

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class InvalidArgument(NeedleError):
    code = "INVALID_ARGUMENT"
    status = 400


class Unauthenticated(NeedleError):
    code = "UNAUTHENTICATED"
    status = 401


class PermissionDenied(NeedleError):
    code = "PERMISSION_DENIED"
    status = 403


class NotFound(NeedleError):
    code = "NOT_FOUND"
    status = 404


class AlreadyExists(NeedleError):
    code = "ALREADY_EXISTS"
    status = 409


class PayloadTooLarge(NeedleError):
    code = "PAYLOAD_TOO_LARGE"
    status = 413


class ResourceExhausted(NeedleError):
    code = "RESOURCE_EXHAUSTED"
    status = 429


class FailedPrecondition(NeedleError):
    """The request is valid, but the server isn't set up for it (e.g. no provider key)."""
    code = "FAILED_PRECONDITION"
    status = 400


class Unavailable(NeedleError):
    """An upstream service, such as an embedding provider, failed."""
    code = "UNAVAILABLE"
    status = 502


BY_CODE = {cls.code: cls for cls in (NeedleError, InvalidArgument, Unauthenticated, PermissionDenied,
                                     NotFound, AlreadyExists, PayloadTooLarge, ResourceExhausted,
                                     FailedPrecondition, Unavailable)}
