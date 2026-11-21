"""Acceso a Cloud Storage con las credenciales de la cuenta del job (metadatos de Cloud Run)."""

from __future__ import annotations

import json
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Sequence

from google.cloud import storage  # type: ignore[import-untyped]

_client: storage.Client | None = None


def client() -> storage.Client:
    global _client
    if _client is None:
        _client = storage.Client()
    return _client


def read_json(bucket: str, name: str) -> Any:
    data = client().bucket(bucket).blob(name).download_as_bytes(timeout=60)
    return json.loads(data.decode("utf-8"))


def download(bucket: str, name: str, dest: str) -> str:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    client().bucket(bucket).blob(name).download_to_filename(dest, timeout=600)
    return dest


def download_many(bucket: str, items: Sequence[tuple[str, str]], workers: int = 16) -> list[str | Exception]:
    """Descarga en paralelo [(objeto, destino)] → por cada uno, la ruta local o la excepción."""

    def one(item: tuple[str, str]) -> str | Exception:
        try:
            return download(bucket, item[0], item[1])
        except Exception as e:  # noqa: BLE001 — se informa por medio, el resto sigue
            return e

    if not items:
        return []
    with ThreadPoolExecutor(max_workers=max(1, min(workers, len(items)))) as pool:
        return list(pool.map(one, items))


def upload_file(bucket: str, name: str, path: str, content_type: str) -> None:
    blob = client().bucket(bucket).blob(name)
    # Subida por partes para el .splat (decenas de MB).
    blob.chunk_size = 16 * 1024 * 1024
    blob.upload_from_filename(path, content_type=content_type, timeout=600)


def upload_json(bucket: str, name: str, data: Any) -> None:
    client().bucket(bucket).blob(name).upload_from_string(
        json.dumps(data, ensure_ascii=False, indent=2), content_type="application/json", timeout=60
    )
