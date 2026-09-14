"""Render bench/results/*.json into bench/REPORT.md and charts.

    python -m bench.report
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent
RESULTS = HERE / "results"

# Fixed order and colours (Okabe–Ito, colour-blind safe): a system keeps its colour in every chart.
ORDER = ["needledb-embedded", "needledb-server", "needledb-docker", "faiss-hnsw", "qdrant-docker",
         "pgvector-docker", "numpy-exact"]
COLORS = {
    "needledb-embedded": "#0072B2", "needledb-server": "#56B4E9", "needledb-docker": "#009E73",
    "faiss-hnsw": "#999999", "qdrant-docker": "#D55E00", "pgvector-docker": "#CC79A7", "numpy-exact": "#000000",
}


def gib(b):
    return "—" if b is None else f"{b / 2**30:.2f} GiB"


def ms(v):
    return "—" if v is None else (f"{v:.2f} ms" if v < 10 else f"{v:.1f} ms")


def qps(v):
    return "—" if v is None else f"{v:,.0f}"


def ordered(systems: dict) -> list[tuple[str, dict]]:
    return sorted(systems.items(), key=lambda kv: ORDER.index(kv[0]) if kv[0] in ORDER else len(ORDER))


def chart(result: dict, path: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(1, 2, figsize=(12, 4.6), dpi=150)
    for key, sysres in ordered(result["systems"]):
        sweep = [p for p in sysres["sweep"]]
        color = COLORS.get(key, "#444444")
        recall = [p["recall"] for p in sweep]
        style = dict(color=color, marker="o", markersize=5, linewidth=2, label=sysres["name"])
        axes[0].plot(recall, [p["qps"] for p in sweep], **style)
        axes[1].plot(recall, [p["p99Ms"] for p in sweep], **style)
    for ax, ylabel, title in ((axes[0], "queries / s (1 client, log)", "Throughput vs recall"),
                              (axes[1], "p99 latency, ms (log)", "Tail latency vs recall")):
        ax.set_yscale("log")
        ax.set_xlabel("recall@10")
        ax.set_ylabel(ylabel)
        ax.set_title(title, loc="left", fontsize=11, fontweight="bold")
        ax.grid(True, which="major", color="#e5e5e5", linewidth=0.8)
        ax.spines[["top", "right"]].set_visible(False)
    axes[0].legend(frameon=False, fontsize=8, loc="lower left")
    fig.suptitle(f"{result['dataset']} · {result['n']:,} vectors · {result['dimension']}-d · "
                 f"HNSW m={result['m']} ef_construction={result['efConstruction']}", fontsize=10, x=0.01, ha="left")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def section(result: dict, chart_name: str) -> str:
    lines = [f"## {result['dataset']} — {result['n']:,} × {result['dimension']}-d", ""]
    lines += [f"![recall vs throughput and latency](results/{chart_name})", ""]

    lines += ["### At ≥ 95% recall@10", "",
              "The smallest `ef_search` in the sweep that reaches 95% recall (or the best reached).", "",
              "| System | Transport | Build | Memory | ef | Recall@10 | p50 | p99 | QPS, 1 client | QPS, "
              f"{next(iter(result['systems'].values()))['threads']} clients |",
              "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for key, s in ordered(result["systems"]):
        op = s["operatingPoint"]
        lines.append(f"| **{s['name']}** | {s['transport']} | {s['buildSeconds']:.1f} s | {gib(s['memoryBytes'])} | "
                     f"{op['ef'] or '—'} | {op['recall']:.3f} | {ms(op['p50Ms'])} | {ms(op['p99Ms'])} | "
                     f"{qps(op['qps'])} | {qps(s['concurrentQps'])} |")

    lines += ["", "### Filtered queries", "",
              "Recall@10 against exact filtered ground truth, and p50 latency, at the same `ef_search`. "
              "The filter keeps the stated share of the corpus, uncorrelated with the vectors.", "",
              "| System | 50% | 10% | 1% | 0.1% |", "|---|---:|---:|---:|---:|"]
    for key, s in ordered(result["systems"]):
        cells = [f"{f['recall']:.3f} · {ms(f['p50Ms'])}" for f in (s["filtered"][k] for k in ("50%", "10%", "1%", "0.1%"))]
        lines.append(f"| **{s['name']}** | " + " | ".join(cells) + " |")

    lines += ["", "<details><summary>Full ef_search sweep</summary>", "",
              "| System | ef | Recall@10 | p50 | p95 | p99 | QPS |", "|---|---:|---:|---:|---:|---:|---:|"]
    for key, s in ordered(result["systems"]):
        for p in s["sweep"]:
            lines.append(f"| {s['name']} | {p['ef'] or '—'} | {p['recall']:.4f} | {ms(p['p50Ms'])} | "
                         f"{ms(p['p95Ms'])} | {ms(p['p99Ms'])} | {qps(p['qps'])} |")
    lines += ["", "</details>", ""]

    versions = {k: v for s in result["systems"].values() for k, v in s.get("info", {}).items()
                if k in ("needledb", "faiss", "qdrant", "pgvector", "postgres", "vectorType")}
    env = result["environment"]
    docker = env.get("docker")
    lines += [f"Machine: {env.get('cpu')} · {env.get('cpuCount')} cores · {gib(env.get('memoryBytes'))} RAM · "
              f"Python {env.get('python')} · FAISS {env.get('faiss')}"
              + (f" · Docker VM {docker['cpus']} CPUs / {gib(docker['memoryBytes'])}" if docker else ""),
              "", "Versions: " + ", ".join(f"{k} {v}" for k, v in versions.items()), ""]
    return "\n".join(lines)


def main() -> None:
    results = [json.loads(p.read_text()) for p in sorted(RESULTS.glob("*.json"))]
    results = [r for r in results if r.get("systems")]
    parts = [HEADER.format(date=datetime.now().strftime("%Y-%m-%d"))]
    for result in sorted(results, key=lambda r: (-r["dimension"], r["n"])):
        name = f"{result['dataset']}-{result['n']}.png"
        chart(result, RESULTS / name)
        parts.append(section(result, name))
    parts.append(METHOD)
    (HERE / "REPORT.md").write_text("\n".join(parts))
    print(f"wrote {HERE / 'REPORT.md'}")


HEADER = """# NeedleDB benchmarks

Generated {date} by `python -m bench.report` from `bench/results/*.json`.
Reproduce with the commands under [Method](#method).
"""

METHOD = """## Method

**Data.** Real OpenAI `text-embedding-3-large` embeddings of DBpedia entities (Qdrant's public
copies on Hugging Face) at 1536 and 3072 dimensions, unit-normalised, cosine similarity. The
first *n* rows are the corpus; the next 1,000 rows are held-out queries, so no query is in the
corpus. Ground truth is exact brute force.

**Index.** Every graph index is HNSW with the same `m` and `ef_construction`. `ef_search` is
swept; the headline row for each system is the smallest value reaching 95% recall@10.

**Latency.** Single client, sequential, measured end to end by the benchmark process — in-process
calls for the embedded engines, a real network round trip (with serialization) for servers.
Concurrent throughput runs N client threads for 10 seconds.

**Build.** Wall time from an empty index to every vector searchable through the index: all writes,
the durable log (NeedleDB and Postgres), and graph construction.

**Memory.** Embedded engines: resident memory the process gained while loading. NeedleDB server:
server process RSS. Docker services: `docker stats` for the container.

**Filters.** Each vector carries four integer fields; `{"s1": 0}` keeps 1% of the corpus, etc.
Qdrant fields are payload-indexed before loading, pgvector uses a b-tree per field and
`hnsw.iterative_scan = relaxed_order`, NeedleDB uses its own planner (exact scan of the
matching subset when small, otherwise filtered HNSW with a widened beam).

**Fairness notes.**
- Docker services run in the same Docker Desktop VM with identical CPU and memory limits and
  are reached over the VM's port forwarding; compare `needledb-docker` with Qdrant and pgvector
  for a like-for-like view. Embedded and native-server rows run on the host with all cores.
- Qdrant is reached over gRPC (its fastest client); NeedleDB over HTTP/JSON; Postgres over its
  binary protocol with prepared statements.
- pgvector's `vector` type indexes at most 2,000 dimensions, so the 3072-d run uses `halfvec`
  (float16), which is lossy.
- One machine, one run per configuration. Treat differences under ~10% as noise.

**Reproduce.**

```bash
pip install -e ".[bench]"
python -m bench.run --dataset dbpedia-3072 --n 100000 \\
    --systems numpy-exact,faiss-hnsw,needledb-embedded,needledb-server
docker compose -f bench/docker-compose.yml up -d --build
python -m bench.run --dataset dbpedia-3072 --n 100000 \\
    --systems needledb-docker,qdrant-docker,pgvector-docker
python -m bench.report
```
"""


if __name__ == "__main__":
    main()
