"""Every system behind the same small interface, so the runner treats them alike.

All systems index the same unit vectors with cosine similarity and HNSW(m,
ef_construction) set identically; `set_ef` sets the query-time search width.
"""
from __future__ import annotations

import base64
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Callable

import numpy as np

from .datasets import metadata

ROOT = Path(__file__).resolve().parent.parent
TMP = Path(__file__).parent / "data" / "tmp"
COLLECTION = "bench"
FIELDS = ("s50", "s10", "s1", "s01")

Filter = tuple[str, int] | None


def process_rss() -> int:
    import psutil

    return psutil.Process().memory_info().rss


def docker_memory(container: str) -> int | None:
    """Container memory as `docker stats` reports it (page cache excluded)."""
    try:
        out = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", container],
                             capture_output=True, text=True, timeout=60).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    used = out.split("/")[0].strip()
    units = {"GiB": 1024 ** 3, "MiB": 1024 ** 2, "KiB": 1024, "GB": 1e9, "MB": 1e6, "kB": 1e3, "B": 1}
    for unit, scale in units.items():
        if used.endswith(unit):
            try:
                return int(float(used[: -len(unit)]) * scale)
            except ValueError:
                return None
    return None


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class System:
    name = "system"
    transport = "in-process"
    container: str | None = None

    def setup(self, dim: int, m: int, ef_construction: int) -> None:
        raise NotImplementedError

    def load(self, base: np.ndarray, labels: np.ndarray) -> None:
        raise NotImplementedError

    def ready(self) -> None:
        """Block until every vector is searchable through the index."""

    def ef_values(self, sweep: list[int]) -> list[int]:
        return sweep

    def set_ef(self, ef: int) -> None:
        self.ef = ef

    def search(self, q: np.ndarray, k: int, flt: Filter = None) -> list[int]:
        raise NotImplementedError

    def worker(self) -> Callable[[np.ndarray, int], list[int]]:
        """A search callable safe to use from one extra thread."""
        return self.search

    def client_spec(self) -> tuple[str, dict] | None:
        """For networked systems: how a separate client process connects (see make_worker).
        None for in-process engines, which are measured with threads."""
        return None

    def memory_bytes(self) -> int | None:
        return docker_memory(self.container) if self.container else None

    def info(self) -> dict:
        return {}

    def close(self) -> None:
        pass


# ---- baselines ------------------------------------------------------------------------

class NumpyExact(System):
    name = "NumPy brute force"

    def setup(self, dim, m, ef_construction):
        pass

    def load(self, base, labels):
        self.base, self.labels, self._masks = base, labels, {}

    def ef_values(self, sweep):
        return [0]

    def search(self, q, k, flt=None):
        scores = self.base @ q
        if flt:
            mask = self._masks.get(flt[1])
            if mask is None:
                mask = self._masks[flt[1]] = self.labels % flt[1] != 0
            scores = np.where(mask, -np.inf, scores)
        top = np.argpartition(-scores, k)[:k]
        return top[np.argsort(-scores[top])].tolist()


class FaissHNSW(System):
    name = "FAISS HNSW (raw library)"

    def setup(self, dim, m, ef_construction):
        import faiss

        self.faiss = faiss
        self.index = faiss.IndexHNSWFlat(dim, m, faiss.METRIC_INNER_PRODUCT)
        self.index.hnsw.efConstruction = ef_construction

    def load(self, base, labels):
        self.index.add(base)
        self.labels, self._bits = labels, {}

    def info(self):
        return {"faiss": self.faiss.__version__}

    def search(self, q, k, flt=None):
        params = self.faiss.SearchParametersHNSW()
        params.efSearch = max(self.ef, k)
        bits = None
        if flt:
            bits = self._bits.get(flt[1])
            if bits is None:
                bits = self._bits[flt[1]] = np.packbits(self.labels % flt[1] == 0, bitorder="little")
            params.sel = self.faiss.IDSelectorBitmap(len(self.labels), self.faiss.swig_ptr(bits))
        _, ids = self.index.search(q.reshape(1, -1), k, params=params)
        return [i for i in ids[0].tolist() if i >= 0]


class FaissHNSWHalf(FaissHNSW):
    """The same library and graph, with NeedleDB's fp16 vector storage — so the comparison
    against NeedleDB is one of engines, not of how each one chose to store a vector."""

    name = "FAISS HNSW (fp16 storage)"

    def load(self, base, labels):
        import faiss

        flat = self.index
        flat.add(base)                                       # link the graph on float32, as NeedleDB does
        storage = faiss.IndexScalarQuantizer(flat.d, faiss.ScalarQuantizer.QT_fp16,
                                             faiss.METRIC_INNER_PRODUCT)
        storage.train(base[:1])
        storage.add(base)
        half = faiss.IndexHNSWSQ(flat.d, faiss.ScalarQuantizer.QT_fp16, flat.hnsw.nb_neighbors(0) // 2,
                                 faiss.METRIC_INNER_PRODUCT)
        half.hnsw = flat.hnsw
        half.storage = storage
        half.own_fields = True
        half.ntotal = storage.ntotal
        half.is_trained = True
        self.index = half
        self.labels, self._bits = labels, {}

    def info(self):
        return {"faiss": self.faiss.__version__, "vectorType": "fp16"}


# ---- NeedleDB -------------------------------------------------------------------------

class NeedleLocal(System):
    name = "NeedleDB (embedded)"

    def setup(self, dim, m, ef_construction):
        from needledb.core import HNSWConfig, IndexConfig, Registry

        TMP.mkdir(parents=True, exist_ok=True)
        self.dir = tempfile.mkdtemp(prefix="needledb-", dir=TMP)
        self.registry = Registry(self.dir)
        self.index = self.registry.create_index(IndexConfig(
            name=COLLECTION, dimension=dim, metric="cosine", index_type="hnsw",
            hnsw=HNSWConfig(m=m, ef_construction=ef_construction)))

    def load(self, base, labels):
        for start in range(0, len(base), 10_000):
            stop = min(len(base), start + 10_000)
            self.index.upsert([{"id": str(i), "values": base[i], "metadata": metadata(int(labels[i]))}
                               for i in range(start, stop)])

    def ready(self):
        self.index.wait_for_index()

    def search(self, q, k, flt=None):
        res = self.index.query(vector=q, top_k=k, ef_search=self.ef, filter={flt[0]: 0} if flt else None)
        return [int(m["id"]) for m in res["matches"]]

    def info(self):
        from needledb import __version__
        return {"needledb": __version__, "storageBytes": self.index.storage.size_bytes()}

    def close(self):
        self.index.close(snapshot=False)
        shutil.rmtree(self.dir, ignore_errors=True)


class NeedleHTTP(System):
    """A NeedleDB server: started natively on this machine, or an existing URL (Docker)."""

    transport = "http+json"

    def __init__(self, url: str | None = None, api_key: str = "bench", container: str | None = None):
        self.url, self.api_key, self.container = url, api_key, container
        self.name = "NeedleDB (Docker)" if container else "NeedleDB (server)"
        self.proc = None

    def setup(self, dim, m, ef_construction):
        import httpx

        if self.url is None:
            TMP.mkdir(parents=True, exist_ok=True)
            self.dir = tempfile.mkdtemp(prefix="needledb-server-", dir=TMP)
            port = _free_port()
            self.proc = subprocess.Popen(
                [sys.executable, "-m", "needledb", "serve", "--data", self.dir, "--port", str(port),
                 "--api-key", self.api_key, "--log-level", "warning"],
                cwd=ROOT, stdout=subprocess.DEVNULL)
            self.url = f"http://127.0.0.1:{port}"
        self.http = self._client()
        for _ in range(600):
            try:
                if self.http.get("/health").status_code == 200:
                    break
            except httpx.TransportError:
                pass
            time.sleep(0.1)
        self.http.delete(f"/indexes/{COLLECTION}")
        self._post("/indexes", {"name": COLLECTION, "dimension": dim, "metric": "cosine", "index_type": "hnsw",
                                "hnsw": {"m": m, "ef_construction": ef_construction}})

    def _client(self):
        import httpx

        return httpx.Client(base_url=self.url, timeout=600,
                            headers={"Api-Key": self.api_key, "Content-Type": "application/json"},
                            limits=httpx.Limits(max_connections=128, max_keepalive_connections=128))

    @staticmethod
    def _vec(values) -> str:
        # Base64 float32, NeedleDB's binary wire format (Qdrant's client uses gRPC, pgvector its binary protocol).
        return base64.b64encode(np.asarray(values, dtype="<f4").tobytes()).decode("ascii")

    def _post(self, path, body, http=None):
        import orjson

        resp = (http or self.http).post(path, content=orjson.dumps(body, option=orjson.OPT_SERIALIZE_NUMPY))
        resp.raise_for_status()
        return orjson.loads(resp.content)

    def load(self, base, labels):
        for start in range(0, len(base), 500):
            stop = min(len(base), start + 500)
            self._post(f"/indexes/{COLLECTION}/vectors/upsert", {"vectors": [
                {"id": str(i), "values": self._vec(base[i]), "metadata": metadata(int(labels[i]))} for i in range(start, stop)]})

    def ready(self):
        while self.http.get(f"/indexes/{COLLECTION}").json()["status"]["state"] != "Ready":
            time.sleep(0.5)

    def search(self, q, k, flt=None, http=None):
        body = {"vector": self._vec(q), "topK": k, "efSearch": self.ef}
        if flt:
            body["filter"] = {flt[0]: 0}
        return [int(m["id"]) for m in self._post(f"/indexes/{COLLECTION}/query", body, http)["matches"]]

    def worker(self):
        # One connection pool per client thread, as the pgvector client gets one connection each.
        http = self._client()
        return lambda q, k, flt=None: self.search(q, k, flt, http)

    def client_spec(self):
        return "needledb", {"url": self.url, "api_key": self.api_key, "ef": self.ef}

    def memory_bytes(self):
        if self.proc is not None:
            import psutil
            return psutil.Process(self.proc.pid).memory_info().rss
        return super().memory_bytes()

    def info(self):
        described = self.http.get(f"/indexes/{COLLECTION}").json()
        return {"needledb": self.http.get("/stats").json()["version"], "storageBytes": described["storageBytes"],
                "url": self.url}

    def close(self):
        try:
            self.http.delete(f"/indexes/{COLLECTION}")
        finally:
            if self.proc is not None:
                self.proc.terminate()
                self.proc.wait(30)
                shutil.rmtree(self.dir, ignore_errors=True)


# ---- Qdrant ---------------------------------------------------------------------------

class Qdrant(System):
    name = "Qdrant (Docker)"
    transport = "grpc"
    container = "needledb-bench-qdrant"

    def setup(self, dim, m, ef_construction):
        from qdrant_client import QdrantClient, models

        self.models = models
        self.client = QdrantClient(host="127.0.0.1", port=6333, grpc_port=6334, prefer_grpc=True, timeout=600)
        if self.client.collection_exists(COLLECTION):
            self.client.delete_collection(COLLECTION)
        self.client.create_collection(
            COLLECTION,
            vectors_config=models.VectorParams(size=dim, distance=models.Distance.COSINE),
            hnsw_config=models.HnswConfigDiff(m=m, ef_construct=ef_construction))
        for field in FIELDS:     # indexed before loading, so HNSW builds filter-aware links
            self.client.create_payload_index(COLLECTION, field, models.PayloadSchemaType.INTEGER)

    def load(self, base, labels):
        self.n = len(base)
        self.client.upload_collection(
            COLLECTION, vectors=base, ids=list(range(len(base))),
            payload=[metadata(int(label)) for label in labels], batch_size=256, parallel=1, wait=True)

    def ready(self):
        steady = 0
        while steady < 5:
            info = self.client.get_collection(COLLECTION)
            done = (info.status == self.models.CollectionStatus.GREEN
                    and (info.indexed_vectors_count or 0) >= 0.99 * self.n)
            steady = steady + 1 if done else 0
            time.sleep(1)

    def _filter(self, flt):
        m = self.models
        return m.Filter(must=[m.FieldCondition(key=flt[0], match=m.MatchValue(value=0))]) if flt else None

    def search(self, q, k, flt=None):
        res = self.client.query_points(
            COLLECTION, query=q.tolist(), limit=k, with_payload=False,
            search_params=self.models.SearchParams(hnsw_ef=self.ef), query_filter=self._filter(flt))
        return [int(p.id) for p in res.points]

    def client_spec(self):
        return "qdrant", {"ef": self.ef}

    def info(self):
        try:
            version = self.client.info().version
        except Exception:  # noqa: BLE001
            version = None
        return {"qdrant": version}

    def close(self):
        self.client.delete_collection(COLLECTION)
        self.client.close()


# ---- pgvector -------------------------------------------------------------------------

class PgVector(System):
    name = "pgvector (Docker)"
    transport = "postgres"
    container = "needledb-bench-pgvector"
    DSN = "postgresql://postgres:bench@127.0.0.1:5433/bench"

    def _connect(self):
        import psycopg
        from pgvector.psycopg import register_vector

        conn = psycopg.connect(self.DSN, autocommit=True)
        register_vector(conn)
        try:
            conn.execute("set hnsw.iterative_scan = relaxed_order")   # pgvector >= 0.8
        except Exception:  # noqa: BLE001
            pass
        if getattr(self, "ef", None):
            conn.execute(f"set hnsw.ef_search = {min(int(self.ef), 1000)}")
        return conn

    def setup(self, dim, m, ef_construction):
        import psycopg

        with psycopg.connect(self.DSN, autocommit=True) as boot:
            boot.execute("create extension if not exists vector")
        self.dim, self.m, self.ef_construction = dim, m, ef_construction
        # The vector type indexes up to 2,000 dimensions; beyond that pgvector needs halfvec.
        self.vtype = "halfvec" if dim > 2000 else "vector"
        self.conn = self._connect()
        self.conn.execute("drop table if exists items")
        self.conn.execute(f"create table items (id int primary key, s50 int, s10 int, s1 int, s01 int, "
                          f"embedding {self.vtype}({dim}))")

    def _param(self, q):
        from pgvector import HalfVector
        return HalfVector(q) if self.vtype == "halfvec" else q

    def load(self, base, labels):
        with self.conn.cursor() as cur:
            with cur.copy("copy items (id, s50, s10, s1, s01, embedding) from stdin with (format binary)") as copy:
                copy.set_types(["int4", "int4", "int4", "int4", "int4", self.vtype])
                for i in range(len(base)):
                    md = metadata(int(labels[i]))
                    copy.write_row((i, md["s50"], md["s10"], md["s1"], md["s01"], self._param(base[i])))

    def ready(self):
        ops = "halfvec_cosine_ops" if self.vtype == "halfvec" else "vector_cosine_ops"
        self.conn.execute("set maintenance_work_mem = '3GB'")
        self.conn.execute("set max_parallel_maintenance_workers = 7")
        self.conn.execute(f"create index on items using hnsw (embedding {ops}) "
                          f"with (m = {self.m}, ef_construction = {self.ef_construction})")
        for field in FIELDS:
            self.conn.execute(f"create index on items ({field})")
        self.conn.execute("analyze items")

    def set_ef(self, ef):
        self.ef = ef
        self.conn.execute(f"set hnsw.ef_search = {min(int(ef), 1000)}")

    def _search(self, conn, q, k, flt):
        where = f"where {flt[0]} = 0 " if flt else ""
        rows = conn.execute(f"select id from items {where}order by embedding <=> %s limit %s",
                            (self._param(q), k), prepare=True).fetchall()
        return [r[0] for r in rows]

    def search(self, q, k, flt=None):
        return self._search(self.conn, q, k, flt)

    def worker(self):
        conn = self._connect()
        return lambda q, k, flt=None: self._search(conn, q, k, flt)

    def client_spec(self):
        return "pgvector", {"ef": self.ef, "vtype": self.vtype}

    def info(self):
        version = self.conn.execute("select extversion from pg_extension where extname = 'vector'").fetchone()[0]
        server = self.conn.execute("show server_version").fetchone()[0]
        size = self.conn.execute("select pg_total_relation_size('items')").fetchone()[0]
        return {"pgvector": version, "postgres": server, "vectorType": self.vtype, "storageBytes": size}

    def close(self):
        self.conn.execute("drop table if exists items")
        self.conn.close()


def make_worker(spec: tuple[str, dict]) -> Callable[[np.ndarray, int], list[int]]:
    """Build a search callable inside a client process from a system's client_spec()."""
    kind, params = spec
    if kind == "needledb":
        system = NeedleHTTP(url=params["url"], api_key=params["api_key"])
        system.ef = params["ef"]
        http = system._client()
        return lambda q, k: system.search(q, k, None, http)
    if kind == "qdrant":
        from qdrant_client import QdrantClient, models

        system = Qdrant.__new__(Qdrant)
        system.models, system.ef = models, params["ef"]
        system.client = QdrantClient(host="127.0.0.1", port=6333, grpc_port=6334, prefer_grpc=True, timeout=600)
        return lambda q, k: system.search(q, k)
    if kind == "pgvector":
        system = PgVector.__new__(PgVector)
        system.ef, system.vtype = params["ef"], params["vtype"]
        conn = system._connect()
        return lambda q, k: system._search(conn, q, k, None)
    raise ValueError(f"unknown client kind {kind!r}")


SYSTEMS: dict[str, Callable[[], System]] = {
    "numpy-exact": NumpyExact,
    "faiss-hnsw": FaissHNSW,
    "faiss-hnsw-fp16": FaissHNSWHalf,
    "needledb-embedded": NeedleLocal,
    "needledb-server": NeedleHTTP,
    "needledb-docker": lambda: NeedleHTTP(url="http://127.0.0.1:8081", container="needledb-bench-needledb"),
    "qdrant-docker": Qdrant,
    "pgvector-docker": PgVector,
}
