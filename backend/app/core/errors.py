"""Domain error taxonomy. Maps to the RU error contract {code,message,details?}."""
from __future__ import annotations

from fastapi import HTTPException, status

# code -> (http_status, default RU message)
ERROR_CATALOG = {
    "VALIDATION": (status.HTTP_422_UNPROCESSABLE_ENTITY, "Ошибка валидации данных"),
    "UNAUTHENTICATED": (status.HTTP_401_UNAUTHORIZED, "Требуется аутентификация"),
    "FORBIDDEN": (status.HTTP_403_FORBIDDEN, "Недостаточно прав"),
    "NOT_FOUND": (status.HTTP_404_NOT_FOUND, "Ресурс не найден"),
    "VERSION_CONFLICT": (status.HTTP_409_CONFLICT, "Задача изменена другим пользователем"),
    "RATE_LIMITED": (status.HTTP_429_TOO_MANY_REQUESTS, "Слишком много запросов"),
    "PAYLOAD_TOO_LARGE": (status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Файл слишком большой"),
    "UNSUPPORTED_MEDIA": (status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Неподдерживаемый тип файла"),
}


class AppError(HTTPException):
    def __init__(self, code: str, message: str | None = None, details=None):
        http_status, default_msg = ERROR_CATALOG[code]
        super().__init__(status_code=http_status, detail={
            "code": code,
            "message": message or default_msg,
            "details": details,
        })
        self.code = code


# convenience constructors
def not_found(msg: str | None = None) -> AppError:
    # 404 used both for missing AND for forbidden-without-leak per spec
    return AppError("NOT_FOUND", msg)


def forbidden(msg: str | None = None) -> AppError:
    return AppError("FORBIDDEN", msg)


def version_conflict() -> AppError:
    return AppError("VERSION_CONFLICT")


def unauthenticated() -> AppError:
    return AppError("UNAUTHENTICATED")
