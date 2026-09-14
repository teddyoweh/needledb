"""Benchmark datasets, cached as bench/data/<name>-<n>-<queries>.npz.

Real data: DBpedia entities embedded with OpenAI text-embedding-3-large — Qdrant's
public copies on Hugging Face, at 1536 and 3072 dimensions. The first `n` rows are
the corpus and the next `queries` rows are held-out queries from the same
distribution, so no query is also in the corpus.

Synthetic data (`synthetic-<dim>`): Gaussian clusters with a decaying spectrum, for
shapes the real sets don't cover.

Every corpus vector gets a uniform label in [0, 1000). Filters select
`label % mod == 0`, stored as metadata fields, so `{"s1": 0}` matches 1% of the
corpus independently of the embedding. Ground truth is exact (brute force) top-100,
unfiltered and for each filter.
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np

DATA = Path(__file__).parent / "data"
REAL = {
    "dbpedia-1536": ("Qdrant/dbpedia-entities-openai3-text-embedding-3-large-1536-1M", 26),
    "dbpedia-3072": ("Qdrant/dbpedia-entities-openai3-text-embedding-3-large-3072-1M", 63),
}
# label: (metadata field, modulus) — the filter {field: 0} keeps 1/modulus of the corpus.
FILTERS = {"50%": ("s50", 2), "10%": ("s10", 10), "1%": ("s1", 100), "0.1%": ("s01", 1000)}
GT_K = 100


def metadata(label: int) -> dict:
    return {"s50": label % 2, "s10": label % 10, "s1": label % 100, "s01": label % 1000}


def _shard(name: str, i: int) -> Path:
    dest = DATA / "raw" / name / f"train-{i:05d}.parquet"
    if dest.exists():
        return dest
    import httpx

    repo, total = REAL[name]
    url = f"https://huggingface.co/datasets/{repo}/resolve/main/data/train-{i:05d}-of-{total:05d}.parquet"
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".download")
    print(f"downloading {url}", flush=True)
    with httpx.stream("GET", url, follow_redirects=True, timeout=None) as resp:
        resp.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in resp.iter_bytes(1 << 20):
                f.write(chunk)
    tmp.rename(dest)
    return dest


def _read_real(name: str, rows: int) -> np.ndarray:
    import pyarrow.parquet as pq

    parts, have, i = [], 0, 0
    while have < rows:
        table = pq.read_table(_shard(name, i))
        # The 3072-d files also carry an older ada-002 column; take the text-embedding-3-large one.
        dim = name.rsplit("-", 1)[1]
        column = next(c for c in table.column_names if c == f"text-embedding-3-large-{dim}-embedding")
        values = table.column(column).combine_chunks()
        flat = np.asarray(values.flatten().to_numpy(zero_copy_only=False), dtype=np.float32)
        parts.append(flat.reshape(len(values), -1))
        have += len(values)
        i += 1
    return np.concatenate(parts)[:rows]


def _synthetic(dim: int, rows: int, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    centers = rng.normal(size=(256, dim)).astype(np.float32)
    spectrum = (3.0 / np.sqrt(np.arange(1, dim + 1))).astype(np.float32)
    noise = rng.standard_normal(size=(rows, dim), dtype=np.float32) * spectrum
    return centers[rng.integers(0, 256, rows)] * 0.6 + noise


def exact_top_k(base: np.ndarray, queries: np.ndarray, k: int) -> np.ndarray:
    import faiss

    index = faiss.IndexFlatIP(base.shape[1])
    index.add(base)
    _, ids = index.search(queries, k)
    return ids.astype(np.int64)


def load(name: str, n: int, queries: int = 1000) -> dict[str, np.ndarray]:
    path = DATA / f"{name}-{n}-{queries}.npz"
    if path.exists():
        with np.load(path) as f:
            return {k: f[k] for k in f.files}

    started = time.time()
    if name in REAL:
        vectors = _read_real(name, n + queries)
    elif name.startswith("synthetic-"):
        vectors = _synthetic(int(name.split("-", 1)[1]), n + queries)
    else:
        raise SystemExit(f"unknown dataset {name!r}: use {', '.join(REAL)} or synthetic-<dim>")
    if len(vectors) < n + queries:
        raise SystemExit(f"{name} has only {len(vectors)} rows")
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)       # cosine everywhere

    base = np.ascontiguousarray(vectors[:n])
    held_out = np.ascontiguousarray(vectors[n:n + queries])
    labels = np.random.default_rng(42).integers(0, 1000, n).astype(np.int32)
    out = {"base": base, "queries": held_out, "labels": labels, "gt": exact_top_k(base, held_out, GT_K)}
    for field, mod in FILTERS.values():
        subset = np.flatnonzero(labels % mod == 0)
        local = exact_top_k(np.ascontiguousarray(base[subset]), held_out, min(GT_K, len(subset)))
        out[f"gt_{field}"] = subset[local]

    DATA.mkdir(parents=True, exist_ok=True)
    np.savez(path, **out)
    print(f"prepared {path.name}: {n:,} x {base.shape[1]}d, {queries} queries, "
          f"exact ground truth in {time.time() - started:.1f}s", flush=True)
    return out


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Download and prepare a benchmark dataset.")
    parser.add_argument("name")
    parser.add_argument("--n", type=int, default=100_000)
    parser.add_argument("--queries", type=int, default=1000)
    args = parser.parse_args()
    ds = load(args.name, args.n, args.queries)
    print({k: v.shape for k, v in ds.items()})
