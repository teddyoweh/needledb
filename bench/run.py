"""Run the benchmark suite.

    python -m bench.run --dataset dbpedia-3072 --n 100000 \
        --systems numpy-exact,faiss-hnsw,needledb-embedded,needledb-server

Every system runs in its own process (so memory numbers are its own) against the same
vectors, held-out queries and exact ground truth. For each one:

  1. build   load every vector and wait until all are searchable through the index
  2. sweep   recall@10 and single-client latency at each ef_search
  3. load    throughput with N concurrent clients at the smallest ef reaching 95% recall
  4. filter  recall@10 and latency with metadata filters at 50% / 10% / 1% / 0.1%

Results merge into bench/results/<dataset>-<n>.json; `python -m bench.report` renders them.
"""
from __future__ import annotations

import argparse
import gc
import json
import os
import platform
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter

import numpy as np

from .datasets import FILTERS, load

ROOT = Path(__file__).resolve().parent.parent
RESULTS = Path(__file__).parent / "results"
K = 10
EF_SWEEP = [16, 32, 64, 128, 256, 512]
TARGET_RECALL = 0.95


def measure(search, queries: np.ndarray, gt: np.ndarray) -> dict:
    latencies = np.empty(len(queries))
    hits = 0
    for i, q in enumerate(queries):
        started = perf_counter()
        ids = search(q, K)
        latencies[i] = perf_counter() - started
        hits += len(set(ids) & set(gt[i, :K].tolist()))
    ms = latencies * 1000
    return {
        "recall": hits / (K * len(queries)),
        "p50Ms": float(np.percentile(ms, 50)),
        "p95Ms": float(np.percentile(ms, 95)),
        "p99Ms": float(np.percentile(ms, 99)),
        "meanMs": float(ms.mean()),
        "qps": float(len(queries) / latencies.sum()),
    }


def throughput(system, queries: np.ndarray, threads: int, seconds: float) -> float:
    workers = [system.worker() for _ in range(threads)]
    counts = [0] * threads
    go = threading.Event()
    deadline = [0.0]

    def loop(j: int) -> None:
        search, i = workers[j], j * 97
        go.wait()
        while perf_counter() < deadline[0]:
            search(queries[i % len(queries)], K)
            counts[j] += 1
            i += 1

    pool = [threading.Thread(target=loop, args=(j,)) for j in range(threads)]
    for t in pool:
        t.start()
    started = perf_counter()
    deadline[0] = started + seconds
    go.set()
    for t in pool:
        t.join()
    return sum(counts) / (perf_counter() - started)


def run_one(name: str, args) -> dict:
    from .systems import SYSTEMS, process_rss

    rss_before = process_rss()                 # before the dataset is in memory
    ds = load(args.dataset, args.n, args.queries)
    base, queries, labels, gt = ds["base"], ds["queries"], ds["labels"], ds["gt"]
    system = SYSTEMS[name]()
    log = lambda msg: print(f"[{name}] {msg}", flush=True)  # noqa: E731

    started = perf_counter()
    system.setup(base.shape[1], args.m, args.ef_construction)
    system.load(base, labels)
    load_s = perf_counter() - started
    system.ready()
    build_s = perf_counter() - started

    # Drop the benchmark's own copy of the corpus so in-process RSS counts only what the
    # system keeps (NumPy brute force keeps its reference, which is its index).
    del base
    ds.pop("base")
    gc.collect()
    memory = system.memory_bytes()
    if memory is None:
        memory = max(0, process_rss() - rss_before - sum(v.nbytes for v in ds.values()))
    log(f"built in {build_s:.1f}s (load {load_s:.1f}s), memory {memory / 2**30:.2f} GiB")

    sweep = []
    for ef in system.ef_values(EF_SWEEP):
        system.set_ef(ef)
        for q in queries[:100]:
            system.search(q, K)
        point = {"ef": ef, **measure(system.search, queries, gt)}
        sweep.append(point)
        log(f"ef={ef:<4} recall={point['recall']:.4f} p50={point['p50Ms']:.2f}ms "
            f"p99={point['p99Ms']:.2f}ms qps={point['qps']:.0f}")
        if point["recall"] >= 0.999:
            break

    operating = next((p for p in sweep if p["recall"] >= TARGET_RECALL), sweep[-1])
    system.set_ef(operating["ef"])
    concurrent = throughput(system, queries, args.threads, args.seconds) if args.threads else None
    if concurrent:
        log(f"{args.threads} clients at ef={operating['ef']}: {concurrent:.0f} qps")

    filtered = {}
    subset = queries[: args.filter_queries]
    for label, (field, mod) in FILTERS.items():
        search = lambda q, k, flt=(field, mod): system.search(q, k, flt)  # noqa: E731
        for q in subset[:20]:
            search(q, K)
        filtered[label] = measure(search, subset, ds[f"gt_{field}"])
        log(f"filter {label:>5}: recall={filtered[label]['recall']:.4f} p50={filtered[label]['p50Ms']:.2f}ms")

    info = system.info()
    system.close()
    return {
        "system": name, "name": system.name, "transport": system.transport,
        "loadSeconds": load_s, "buildSeconds": build_s, "memoryBytes": memory,
        "sweep": sweep, "operatingPoint": operating, "concurrentQps": concurrent,
        "threads": args.threads, "filtered": filtered, "info": info,
        "finishedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def environment() -> dict:
    import faiss

    env = {"platform": platform.platform(), "python": platform.python_version(), "cpuCount": os.cpu_count(),
           "faiss": faiss.__version__, "numpy": np.__version__}
    try:
        env["cpu"] = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True,
                                    text=True).stdout.strip() or platform.processor()
    except OSError:
        env["cpu"] = platform.processor()
    try:
        import psutil
        env["memoryBytes"] = psutil.virtual_memory().total
    except ImportError:
        pass
    try:
        out = subprocess.run(["docker", "info", "--format", "{{.NCPU}} {{.MemTotal}} {{.ServerVersion}}"],
                             capture_output=True, text=True, timeout=20).stdout.split()
        if len(out) == 3:
            env["docker"] = {"cpus": int(out[0]), "memoryBytes": int(out[1]), "version": out[2]}
    except (OSError, subprocess.TimeoutExpired):
        pass
    return env


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--n", type=int, default=100_000)
    parser.add_argument("--queries", type=int, default=1000)
    parser.add_argument("--filter-queries", type=int, default=300)
    parser.add_argument("--systems", default="numpy-exact,faiss-hnsw,needledb-embedded,needledb-server")
    parser.add_argument("--m", type=int, default=16)
    parser.add_argument("--ef-construction", type=int, default=200)
    parser.add_argument("--threads", type=int, default=16)
    parser.add_argument("--seconds", type=float, default=10.0)
    parser.add_argument("--one", help=argparse.SUPPRESS)
    parser.add_argument("--out", help=argparse.SUPPRESS)
    args = parser.parse_args()

    if args.one:
        Path(args.out).write_text(json.dumps(run_one(args.one, args)))
        return

    ds = load(args.dataset, args.n, args.queries)      # prepare once; children reuse the cache
    RESULTS.mkdir(parents=True, exist_ok=True)
    path = RESULTS / f"{args.dataset}-{args.n}.json"
    data = json.loads(path.read_text()) if path.exists() else {"systems": {}}
    data.update(dataset=args.dataset, n=args.n, dimension=int(ds["base"].shape[1]), queries=args.queries,
                filterQueries=args.filter_queries, k=K, m=args.m, efConstruction=args.ef_construction,
                environment=environment())

    for name in [s.strip() for s in args.systems.split(",") if s.strip()]:
        part = RESULTS / f".{args.dataset}-{args.n}-{name}.json"
        cmd = [sys.executable, "-m", "bench.run", "--one", name, "--out", str(part)]
        for flag in ("dataset", "n", "queries", "filter_queries", "m", "ef_construction", "threads", "seconds"):
            cmd += [f"--{flag.replace('_', '-')}", str(getattr(args, flag))]
        print(f"=== {name}", flush=True)
        code = subprocess.run(cmd, cwd=ROOT).returncode
        if code != 0 or not part.exists():
            print(f"=== {name} failed (exit {code})", flush=True)
            continue
        data["systems"][name] = json.loads(part.read_text())
        part.unlink()
        path.write_text(json.dumps(data, indent=2))
    print(f"results: {path}")


if __name__ == "__main__":
    main()
