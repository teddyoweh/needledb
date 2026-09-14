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


class NotFound(NeedleError):
    code = "NOT_FOUND"
    status = 404


class AlreadyExists(NeedleError):
    code = "ALREADY_EXISTS"
    status = 409


BY_CODE = {cls.code: cls for cls in
           (NeedleError, InvalidArgument, Unauthenticated, NotFound, AlreadyExists)}
