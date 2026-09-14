from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

from needledb.core import Registry
from needledb.server.app import create_app

API_KEY = "test-key"


def clustered(n: int, d: int, seed: int = 0, clusters: int = 32) -> np.ndarray:
    rng = np.random.default_rng(seed)
    centers = rng.normal(size=(clusters, d))
    points = centers[rng.integers(0, clusters, n)] + 0.3 * rng.normal(size=(n, d))
    return points.astype(np.float32)


def brute_force(x: np.ndarray, q: np.ndarray, metric: str, k: int, mask=None) -> list[int]:
    if metric == "cosine":
        x = x / np.linalg.norm(x, axis=1, keepdims=True)
        q = q / np.linalg.norm(q)
    scores = -((x - q) ** 2).sum(axis=1) if metric == "euclidean" else x @ q
    if mask is not None:
        scores = np.where(mask, scores, -np.inf)
    order = np.argsort(-scores, kind="stable")[:k]
    return [int(i) for i in order if np.isfinite(scores[i])]


@pytest.fixture
def registry(tmp_path):
    reg = Registry(tmp_path / "data")
    yield reg
    reg.close()


@pytest.fixture
def app(tmp_path):
    application = create_app(tmp_path / "server-data", api_keys=[API_KEY])
    yield application
    application.state.registry.close()


@pytest.fixture
def client(app):
    with TestClient(app, headers={"Api-Key": API_KEY}) as c:
        yield c
