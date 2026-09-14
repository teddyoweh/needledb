# NeedleDB benchmarks

Generated 2026-09-14 by `python -m bench.report` from `bench/results/*.json`.
Reproduce with the commands under [Method](#method).

## dbpedia-3072 — 100,000 × 3072-d

![recall vs throughput and latency](results/dbpedia-3072-100000.png)

### At ≥ 95% recall@10

The smallest `ef_search` in the sweep that reaches 95% recall (or the best reached).

| System | Transport | Build | Memory | ef | Recall@10 | p50 | p99 | QPS, 1 client | QPS, 16 clients |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **NeedleDB (embedded)** | in-process | 43.3 s | 2.06 GiB | 64 | 0.973 | 0.50 ms | 0.71 ms | 2,003 | 7,356 |
| **NeedleDB (server)** | http+json | 72.6 s | 1.48 GiB | 64 | 0.973 | 1.21 ms | 1.82 ms | 807 | 1,148 |
| **NeedleDB (Docker)** | http+json | 147.8 s | 1.47 GiB | 64 | 0.973 | 4.07 ms | 6.23 ms | 245 | 406 |
| **FAISS HNSW (raw library)** | in-process | 35.8 s | 2.34 GiB | 64 | 0.975 | 0.47 ms | 0.60 ms | 2,168 | 7,687 |
| **Qdrant (Docker)** | grpc | 418.2 s | 0.91 GiB | 32 | 0.977 | 3.72 ms | 5.18 ms | 262 | 510 |
| **pgvector (Docker)** | postgres | 356.5 s | 1.72 GiB | 64 | 0.980 | 2.57 ms | 9.42 ms | 322 | 2,649 |
| **NumPy brute force** | in-process | 0.0 s | 1.15 GiB | — | 1.000 | 21.5 ms | 40.3 ms | 45 | 77 |

### Filtered queries

Recall@10 against exact filtered ground truth, and p50 latency, at the same `ef_search`. The filter keeps the stated share of the corpus, uncorrelated with the vectors.

| System | 50% | 10% | 1% | 0.1% |
|---|---:|---:|---:|---:|
| **NeedleDB (embedded)** | 0.982 · 0.76 ms | 0.978 · 1.32 ms | 1.000 · 0.59 ms | 1.000 · 0.08 ms |
| **NeedleDB (server)** | 0.981 · 1.94 ms | 0.981 · 2.61 ms | 1.000 · 1.79 ms | 1.000 · 0.91 ms |
| **NeedleDB (Docker)** | 0.980 · 6.65 ms | 0.982 · 6.42 ms | 1.000 · 12.1 ms | 1.000 · 3.12 ms |
| **FAISS HNSW (raw library)** | 0.966 · 0.50 ms | 0.871 · 0.47 ms | 0.458 · 0.49 ms | 0.113 · 0.47 ms |
| **Qdrant (Docker)** | 0.956 · 3.98 ms | 0.990 · 3.27 ms | 1.000 · 2.41 ms | 1.000 · 2.03 ms |
| **pgvector (Docker)** | 0.974 · 2.41 ms | 0.964 · 4.10 ms | 1.000 · 3.37 ms | 1.000 · 0.44 ms |
| **NumPy brute force** | 1.000 · 20.9 ms | 1.000 · 12.0 ms | 1.000 · 11.9 ms | 1.000 · 11.7 ms |

<details><summary>Full ef_search sweep</summary>

| System | ef | Recall@10 | p50 | p95 | p99 | QPS |
|---|---:|---:|---:|---:|---:|---:|
| NeedleDB (embedded) | 16 | 0.8562 | 0.24 ms | 0.37 ms | 0.46 ms | 3,885 |
| NeedleDB (embedded) | 32 | 0.9351 | 0.30 ms | 0.41 ms | 0.54 ms | 3,205 |
| NeedleDB (embedded) | 64 | 0.9733 | 0.50 ms | 0.61 ms | 0.71 ms | 2,003 |
| NeedleDB (embedded) | 128 | 0.9923 | 0.85 ms | 1.00 ms | 1.23 ms | 1,184 |
| NeedleDB (embedded) | 256 | 0.9978 | 1.55 ms | 1.78 ms | 1.89 ms | 654 |
| NeedleDB (embedded) | 512 | 0.9991 | 2.79 ms | 3.27 ms | 3.56 ms | 361 |
| NeedleDB (server) | 16 | 0.8613 | 0.88 ms | 1.12 ms | 1.23 ms | 1,107 |
| NeedleDB (server) | 32 | 0.9367 | 0.98 ms | 1.25 ms | 1.43 ms | 993 |
| NeedleDB (server) | 64 | 0.9734 | 1.21 ms | 1.53 ms | 1.82 ms | 807 |
| NeedleDB (server) | 128 | 0.9926 | 1.61 ms | 1.96 ms | 2.33 ms | 610 |
| NeedleDB (server) | 256 | 0.9981 | 2.35 ms | 2.88 ms | 3.20 ms | 420 |
| NeedleDB (server) | 512 | 0.9990 | 3.46 ms | 4.04 ms | 4.39 ms | 288 |
| NeedleDB (Docker) | 16 | 0.8631 | 4.17 ms | 7.00 ms | 8.25 ms | 225 |
| NeedleDB (Docker) | 32 | 0.9380 | 4.50 ms | 7.61 ms | 9.69 ms | 205 |
| NeedleDB (Docker) | 64 | 0.9734 | 4.07 ms | 5.17 ms | 6.23 ms | 245 |
| NeedleDB (Docker) | 128 | 0.9923 | 5.98 ms | 12.9 ms | 20.6 ms | 145 |
| NeedleDB (Docker) | 256 | 0.9981 | 7.71 ms | 10.3 ms | 17.2 ms | 124 |
| NeedleDB (Docker) | 512 | 0.9990 | 10.5 ms | 13.8 ms | 16.0 ms | 95 |
| FAISS HNSW (raw library) | 16 | 0.8552 | 0.18 ms | 0.27 ms | 0.31 ms | 5,212 |
| FAISS HNSW (raw library) | 32 | 0.9348 | 0.27 ms | 0.35 ms | 0.50 ms | 3,595 |
| FAISS HNSW (raw library) | 64 | 0.9749 | 0.47 ms | 0.54 ms | 0.60 ms | 2,168 |
| FAISS HNSW (raw library) | 128 | 0.9933 | 0.83 ms | 0.96 ms | 1.01 ms | 1,213 |
| FAISS HNSW (raw library) | 256 | 0.9979 | 1.50 ms | 1.73 ms | 1.83 ms | 675 |
| FAISS HNSW (raw library) | 512 | 0.9996 | 2.77 ms | 3.24 ms | 3.42 ms | 364 |
| Qdrant (Docker) | 16 | 0.9260 | 3.67 ms | 5.43 ms | 6.11 ms | 259 |
| Qdrant (Docker) | 32 | 0.9769 | 3.72 ms | 4.57 ms | 5.18 ms | 262 |
| Qdrant (Docker) | 64 | 0.9934 | 5.00 ms | 5.83 ms | 6.38 ms | 198 |
| Qdrant (Docker) | 128 | 0.9985 | 7.66 ms | 11.3 ms | 13.6 ms | 122 |
| Qdrant (Docker) | 256 | 0.9998 | 12.8 ms | 14.7 ms | 20.4 ms | 77 |
| pgvector (Docker) | 16 | 0.8790 | 1.33 ms | 2.45 ms | 3.29 ms | 679 |
| pgvector (Docker) | 32 | 0.9442 | 1.55 ms | 2.12 ms | 2.88 ms | 626 |
| pgvector (Docker) | 64 | 0.9802 | 2.57 ms | 5.74 ms | 9.42 ms | 322 |
| pgvector (Docker) | 128 | 0.9948 | 3.94 ms | 5.11 ms | 6.84 ms | 252 |
| pgvector (Docker) | 256 | 0.9981 | 6.77 ms | 9.77 ms | 12.4 ms | 145 |
| pgvector (Docker) | 512 | 0.9993 | 12.2 ms | 18.8 ms | 29.1 ms | 79 |
| NumPy brute force | — | 1.0000 | 21.5 ms | 31.6 ms | 40.3 ms | 45 |

</details>

Machine: Apple M5 Pro · 15 cores · 24.00 GiB RAM · Python 3.12.12 · FAISS 1.15.0 · Docker VM 15 CPUs / 7.75 GiB

Versions: faiss 1.15.0, needledb 0.1.0, qdrant 1.19.1, pgvector 0.8.6, postgres 17.11 (Debian 17.11-1.pgdg12+2), vectorType halfvec

## dbpedia-1536 — 100,000 × 1536-d

![recall vs throughput and latency](results/dbpedia-1536-100000.png)

### At ≥ 95% recall@10

The smallest `ef_search` in the sweep that reaches 95% recall (or the best reached).

| System | Transport | Build | Memory | ef | Recall@10 | p50 | p99 | QPS, 1 client | QPS, 16 clients |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **NeedleDB (embedded)** | in-process | 53.0 s | 0.74 GiB | 64 | 0.977 | 0.71 ms | 1.01 ms | 1,391 | 4,098 |
| **NeedleDB (server)** | http+json | 81.1 s | 0.79 GiB | 64 | 0.976 | 1.40 ms | 2.11 ms | 685 | 869 |
| **NeedleDB (Docker)** | http+json | 64.3 s | 0.91 GiB | 64 | 0.976 | 1.26 ms | 3.32 ms | 697 | 982 |
| **FAISS HNSW (raw library)** | in-process | 48.4 s | 1.01 GiB | 64 | 0.975 | 0.76 ms | 3.50 ms | 1,144 | 6,373 |
| **Qdrant (Docker)** | grpc | 132.7 s | 0.95 GiB | 32 | 0.971 | 2.72 ms | 3.75 ms | 362 | 974 |
| **pgvector (Docker)** | postgres | 291.2 s | 1.71 GiB | 64 | 0.980 | 2.71 ms | 3.96 ms | 365 | 2,426 |
| **NumPy brute force** | in-process | 0.0 s | 0.57 GiB | — | 1.000 | 12.4 ms | 19.6 ms | 84 | 145 |

### Filtered queries

Recall@10 against exact filtered ground truth, and p50 latency, at the same `ef_search`. The filter keeps the stated share of the corpus, uncorrelated with the vectors.

| System | 50% | 10% | 1% | 0.1% |
|---|---:|---:|---:|---:|
| **NeedleDB (embedded)** | 0.980 · 1.19 ms | 0.978 · 2.20 ms | 1.000 · 1.20 ms | 1.000 · 0.12 ms |
| **NeedleDB (server)** | 0.982 · 2.02 ms | 0.979 · 2.65 ms | 1.000 · 1.94 ms | 1.000 · 1.44 ms |
| **NeedleDB (Docker)** | 0.981 · 1.96 ms | 0.978 · 2.48 ms | 1.000 · 5.29 ms | 1.000 · 0.93 ms |
| **FAISS HNSW (raw library)** | 0.968 · 0.88 ms | 0.883 · 0.77 ms | 0.471 · 0.77 ms | 0.105 · 0.72 ms |
| **Qdrant (Docker)** | 0.962 · 2.32 ms | 0.985 · 1.84 ms | 1.000 · 1.16 ms | 1.000 · 0.86 ms |
| **pgvector (Docker)** | 0.973 · 2.80 ms | 0.965 · 4.54 ms | 1.000 · 4.56 ms | 1.000 · 0.42 ms |
| **NumPy brute force** | 1.000 · 10.8 ms | 1.000 · 10.6 ms | 1.000 · 10.4 ms | 1.000 · 11.8 ms |

<details><summary>Full ef_search sweep</summary>

| System | ef | Recall@10 | p50 | p95 | p99 | QPS |
|---|---:|---:|---:|---:|---:|---:|
| NeedleDB (embedded) | 16 | 0.8545 | 0.33 ms | 0.53 ms | 0.96 ms | 2,777 |
| NeedleDB (embedded) | 32 | 0.9362 | 0.47 ms | 0.62 ms | 0.69 ms | 2,126 |
| NeedleDB (embedded) | 64 | 0.9768 | 0.71 ms | 0.90 ms | 1.01 ms | 1,391 |
| NeedleDB (embedded) | 128 | 0.9923 | 0.92 ms | 1.46 ms | 1.73 ms | 1,015 |
| NeedleDB (embedded) | 256 | 0.9970 | 1.63 ms | 2.55 ms | 3.02 ms | 564 |
| NeedleDB (embedded) | 512 | 0.9989 | 4.32 ms | 6.09 ms | 10.6 ms | 213 |
| NeedleDB (server) | 16 | 0.8559 | 1.61 ms | 2.21 ms | 2.51 ms | 629 |
| NeedleDB (server) | 32 | 0.9358 | 1.13 ms | 1.39 ms | 1.56 ms | 870 |
| NeedleDB (server) | 64 | 0.9763 | 1.40 ms | 1.92 ms | 2.11 ms | 685 |
| NeedleDB (server) | 128 | 0.9922 | 1.66 ms | 1.98 ms | 2.28 ms | 595 |
| NeedleDB (server) | 256 | 0.9973 | 2.31 ms | 2.71 ms | 2.96 ms | 430 |
| NeedleDB (server) | 512 | 0.9988 | 3.88 ms | 4.53 ms | 5.19 ms | 257 |
| NeedleDB (Docker) | 16 | 0.8540 | 1.02 ms | 1.81 ms | 2.17 ms | 874 |
| NeedleDB (Docker) | 32 | 0.9352 | 1.00 ms | 1.71 ms | 2.23 ms | 919 |
| NeedleDB (Docker) | 64 | 0.9756 | 1.26 ms | 2.18 ms | 3.32 ms | 697 |
| NeedleDB (Docker) | 128 | 0.9918 | 1.62 ms | 2.53 ms | 3.51 ms | 574 |
| NeedleDB (Docker) | 256 | 0.9970 | 2.00 ms | 2.41 ms | 3.21 ms | 492 |
| NeedleDB (Docker) | 512 | 0.9988 | 3.01 ms | 3.82 ms | 4.69 ms | 326 |
| FAISS HNSW (raw library) | 16 | 0.8584 | 0.30 ms | 0.44 ms | 0.51 ms | 3,190 |
| FAISS HNSW (raw library) | 32 | 0.9345 | 0.43 ms | 0.57 ms | 0.71 ms | 2,260 |
| FAISS HNSW (raw library) | 64 | 0.9748 | 0.76 ms | 1.02 ms | 3.50 ms | 1,144 |
| FAISS HNSW (raw library) | 128 | 0.9928 | 1.32 ms | 2.31 ms | 12.5 ms | 611 |
| FAISS HNSW (raw library) | 256 | 0.9979 | 2.27 ms | 3.15 ms | 10.1 ms | 361 |
| FAISS HNSW (raw library) | 512 | 0.9997 | 2.75 ms | 4.96 ms | 6.85 ms | 320 |
| Qdrant (Docker) | 16 | 0.9186 | 2.26 ms | 2.94 ms | 3.41 ms | 430 |
| Qdrant (Docker) | 32 | 0.9712 | 2.72 ms | 3.39 ms | 3.75 ms | 362 |
| Qdrant (Docker) | 64 | 0.9912 | 3.31 ms | 5.19 ms | 9.41 ms | 269 |
| Qdrant (Docker) | 128 | 0.9978 | 5.64 ms | 7.00 ms | 8.33 ms | 176 |
| Qdrant (Docker) | 256 | 0.9997 | 7.85 ms | 11.1 ms | 13.2 ms | 122 |
| pgvector (Docker) | 16 | 0.8781 | 1.27 ms | 1.88 ms | 2.26 ms | 753 |
| pgvector (Docker) | 32 | 0.9477 | 1.68 ms | 2.25 ms | 2.58 ms | 582 |
| pgvector (Docker) | 64 | 0.9802 | 2.71 ms | 3.55 ms | 3.96 ms | 365 |
| pgvector (Docker) | 128 | 0.9937 | 4.35 ms | 5.27 ms | 5.63 ms | 232 |
| pgvector (Docker) | 256 | 0.9976 | 7.61 ms | 9.62 ms | 12.1 ms | 131 |
| pgvector (Docker) | 512 | 0.9990 | 13.1 ms | 16.7 ms | 23.5 ms | 76 |
| NumPy brute force | — | 1.0000 | 12.4 ms | 16.1 ms | 19.6 ms | 84 |

</details>

Machine: Apple M5 Pro · 15 cores · 24.00 GiB RAM · Python 3.12.12 · FAISS 1.15.0 · Docker VM 15 CPUs / 7.75 GiB

Versions: faiss 1.15.0, needledb 0.1.0, qdrant 1.19.1, pgvector 0.8.6, postgres 17.11 (Debian 17.11-1.pgdg12+2), vectorType vector

## Method

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
- One machine, one run per configuration. Treat differences under ~10% as noise. The published
  run shared the machine with an unrelated CPU-heavy training job, so absolute numbers are
  conservative; every system ran under the same conditions.
- Docker Desktop on macOS adds a port-forwarding hop to every request, which dominates the
  Docker rows at this latency scale; the native NeedleDB server row shows the same code without it.

**Reproduce.**

```bash
pip install -e ".[bench]"
python -m bench.run --dataset dbpedia-3072 --n 100000 \
    --systems numpy-exact,faiss-hnsw,needledb-embedded,needledb-server
docker compose -f bench/docker-compose.yml up -d --build
python -m bench.run --dataset dbpedia-3072 --n 100000 \
    --systems needledb-docker,qdrant-docker,pgvector-docker
python -m bench.report
```
