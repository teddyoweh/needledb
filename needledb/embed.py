"""Built-in embedding: turn text into vectors with a hosted model or a local one.

An index created with `embed` stores which model produced its vectors. Upserts can
then send text instead of values, and queries can search by text. Hosted providers
are called over HTTPS with a key read from the server's environment — keys are never
stored with an index or returned by the API. Local models run on this machine through
fastembed (`pip install "needledb[local]"`).
"""
from __future__ import annotations

import importlib.util
import os
import threading
import time
from dataclasses import dataclass
from typing import Callable, Literal

import httpx
import numpy as np

from .errors import FailedPrecondition, InvalidArgument, NeedleError, ResourceExhausted, Unavailable

Kind = Literal["document", "query"]

MAX_TEXT_CHARS = 100_000


@dataclass(frozen=True)
class Provider:
    id: str
    name: str
    env: tuple[str, ...] = ()
    local: bool = False
    batch: int = 96


@dataclass(frozen=True)
class Model:
    provider: str
    id: str
    name: str
    dimension: int
    description: str
    vendor: str
    dimensions: tuple[int, ...] = ()   # other output sizes the model can produce
    max_tokens: int = 8192
    multilingual: bool = False
    size_mb: int | None = None         # download size, for local models

    def supports(self, dimension: int) -> bool:
        return dimension == self.dimension or dimension in self.dimensions


PROVIDERS: dict[str, Provider] = {p.id: p for p in (
    Provider("openai", "OpenAI", ("OPENAI_API_KEY",), batch=512),
    Provider("cohere", "Cohere", ("COHERE_API_KEY", "CO_API_KEY"), batch=96),
    Provider("voyage", "Voyage AI", ("VOYAGE_API_KEY",), batch=128),
    Provider("google", "Google Gemini", ("GEMINI_API_KEY", "GOOGLE_API_KEY"), batch=100),
    Provider("mistral", "Mistral AI", ("MISTRAL_API_KEY",), batch=32),
    Provider("jina", "Jina AI", ("JINA_API_KEY",), batch=128),
    Provider("local", "On this server", local=True, batch=64),
)}

MODELS: tuple[Model, ...] = (
    Model("openai", "text-embedding-3-small", "text-embedding-3-small", 1536,
          "Fast and inexpensive. A strong default.", "openai", (512, 1024), multilingual=True),
    Model("openai", "text-embedding-3-large", "text-embedding-3-large", 3072,
          "OpenAI's most accurate embedding model.", "openai", (256, 1024, 1536), multilingual=True),
    Model("openai", "text-embedding-ada-002", "text-embedding-ada-002", 1536,
          "The previous generation, for data already embedded with it.", "openai"),

    Model("cohere", "embed-v4.0", "Embed v4", 1536,
          "Multilingual with a 128k-token context.", "cohere", (256, 512, 1024), 128_000, True),
    Model("cohere", "embed-english-v3.0", "Embed English v3", 1024,
          "English retrieval.", "cohere", max_tokens=512),
    Model("cohere", "embed-multilingual-v3.0", "Embed Multilingual v3", 1024,
          "Retrieval across 100+ languages.", "cohere", max_tokens=512, multilingual=True),
    Model("cohere", "embed-english-light-v3.0", "Embed English Light v3", 384,
          "Smaller and faster English retrieval.", "cohere", max_tokens=512),

    Model("voyage", "voyage-3.5", "voyage-3.5", 1024,
          "General-purpose retrieval with a 32k-token context.", "voyage", (256, 512, 2048), 32_000, True),
    Model("voyage", "voyage-3.5-lite", "voyage-3.5-lite", 1024,
          "Lower latency and cost.", "voyage", (256, 512, 2048), 32_000, True),
    Model("voyage", "voyage-3-large", "voyage-3-large", 1024,
          "Voyage's most accurate general model.", "voyage", (256, 512, 2048), 32_000, True),
    Model("voyage", "voyage-code-3", "voyage-code-3", 1024,
          "Tuned for code search.", "voyage", (256, 512, 2048), 32_000),
    Model("voyage", "voyage-finance-2", "voyage-finance-2", 1024,
          "Tuned for financial documents.", "voyage", max_tokens=32_000),
    Model("voyage", "voyage-law-2", "voyage-law-2", 1024,
          "Tuned for legal documents.", "voyage", max_tokens=16_000),

    Model("google", "gemini-embedding-001", "gemini-embedding-001", 3072,
          "Google's multilingual embedding model.", "gemini", (768, 1536), 2048, True),

    Model("mistral", "mistral-embed", "mistral-embed", 1024,
          "General-purpose text embeddings.", "mistral", multilingual=True),
    Model("mistral", "codestral-embed", "codestral-embed", 1536,
          "Tuned for code search.", "mistral"),

    Model("jina", "jina-embeddings-v3", "jina-embeddings-v3", 1024,
          "Multilingual, with task-specific tuning for retrieval.", "jina", (32, 64, 128, 256, 512, 768), 8192, True),

    Model("local", "BAAI/bge-small-en-v1.5", "BGE Small", 384,
          "Small and quick. Runs on any CPU.", "baai", max_tokens=512, size_mb=67),
    Model("local", "sentence-transformers/all-MiniLM-L6-v2", "all-MiniLM-L6-v2", 384,
          "The classic sentence-transformers model.", "huggingface", max_tokens=256, size_mb=90),
    Model("local", "BAAI/bge-base-en-v1.5", "BGE Base", 768,
          "A good balance of quality and speed.", "baai", max_tokens=512, size_mb=210),
    Model("local", "nomic-ai/nomic-embed-text-v1.5", "Nomic Embed Text v1.5", 768,
          "Long documents, up to 8k tokens.", "nomic", max_tokens=8192, size_mb=520),
    Model("local", "snowflake/snowflake-arctic-embed-m", "Arctic Embed M", 768,
          "Snowflake's retrieval model.", "snowflake", max_tokens=512, size_mb=430),
    Model("local", "mixedbread-ai/mxbai-embed-large-v1", "mxbai Embed Large", 1024,
          "High-quality English retrieval.", "mixedbread", max_tokens=512, size_mb=640),
    Model("local", "BAAI/bge-large-en-v1.5", "BGE Large", 1024,
          "The most accurate BGE model.", "baai", max_tokens=512, size_mb=1200),
    Model("local", "intfloat/multilingual-e5-large", "Multilingual E5 Large", 1024,
          "Retrieval across 100 languages.", "microsoft", max_tokens=512, multilingual=True, size_mb=2240),
)


def find_model(provider: str, model: str) -> Model | None:
    return next((m for m in MODELS if m.provider == provider and m.id == model), None)


def get_model(provider: str, model: str) -> Model:
    if provider not in PROVIDERS:
        raise InvalidArgument(f"embed.provider must be one of {', '.join(PROVIDERS)}")
    found = find_model(provider, model)
    if found is None:
        names = ", ".join(m.id for m in MODELS if m.provider == provider)
        raise InvalidArgument(f"unknown {PROVIDERS[provider].name} model {model!r}; choose one of {names}")
    return found


def available(provider: Provider) -> bool:
    if provider.local:
        return importlib.util.find_spec("fastembed") is not None
    return any(os.environ.get(name) for name in provider.env)


def catalog() -> dict:
    """What the server can embed with. Reports whether a key is set, never the key."""
    return {
        "providers": [{"id": p.id, "name": p.name, "available": available(p), "env": list(p.env), "local": p.local}
                      for p in PROVIDERS.values()],
        "models": [{"provider": m.provider, "id": m.id, "name": m.name, "dimension": m.dimension,
                    "dimensions": sorted({m.dimension, *m.dimensions}), "description": m.description,
                    "vendor": m.vendor, "maxTokens": m.max_tokens, "multilingual": m.multilingual,
                    "sizeMb": m.size_mb} for m in MODELS],
    }


# ---- HTTP ------------------------------------------------------------------------------

_http_lock = threading.Lock()
_http: httpx.Client | None = None


def _client() -> httpx.Client:
    global _http
    with _http_lock:
        if _http is None:
            _http = httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0))
        return _http


def set_http_client(client: httpx.Client | None) -> None:
    """Replace the client used for hosted providers (tests, proxies)."""
    global _http
    with _http_lock:
        _http = client


def _key(provider: Provider) -> str:
    for name in provider.env:
        if value := os.environ.get(name):
            return value
    raise FailedPrecondition(f"{provider.name} embeddings need {provider.env[0]} set in the server's environment")


def _detail(response: httpx.Response) -> str:
    try:
        body = response.json()
        error = body.get("error", body.get("message", body.get("detail", body)))
        if isinstance(error, dict):
            error = error.get("message", error)
        return str(error)[:300]
    except ValueError:
        return response.text[:300]


def _post(provider: Provider, url: str, headers: dict, body: dict, attempts: int = 3) -> dict:
    for attempt in range(attempts):
        last = attempt == attempts - 1
        try:
            response = _client().post(url, headers=headers, json=body)
        except httpx.HTTPError as exc:
            if last:
                raise Unavailable(f"couldn't reach {provider.name}: {exc.__class__.__name__}") from None
        else:
            status = response.status_code
            if status < 400:
                return response.json()
            if status in (401, 403):
                raise FailedPrecondition(f"{provider.name} rejected the API key (HTTP {status}): {_detail(response)}")
            if status not in (408, 429) and status < 500:
                raise InvalidArgument(f"{provider.name} refused the request (HTTP {status}): {_detail(response)}")
            if last:
                if status == 429:
                    raise ResourceExhausted(f"{provider.name} is rate limiting embedding requests; try again shortly")
                raise Unavailable(f"{provider.name} returned HTTP {status}: {_detail(response)}")
        time.sleep(0.5 * 2 ** attempt)
    raise NeedleError("unreachable")


def _by_index(items: list[dict]) -> list[list[float]]:
    return [item["embedding"] for item in sorted(items, key=lambda item: item.get("index", 0))]


def _openai(model: Model, texts: list[str], kind: Kind, dimension: int) -> list[list[float]]:
    provider = PROVIDERS["openai"]
    body: dict = {"model": model.id, "input": texts, "encoding_format": "float"}
    if dimension != model.dimension:
        body["dimensions"] = dimension
    base = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    data = _post(provider, f"{base}/embeddings", {"Authorization": f"Bearer {_key(provider)}"}, body)
    return _by_index(data["data"])


def _cohere(model: Model, texts: list[str], kind: Kind, dimension: int) -> list[list[float]]:
    provider = PROVIDERS["cohere"]
    body: dict = {"model": model.id, "texts": texts, "embedding_types": ["float"],
                  "input_type": "search_query" if kind == "query" else "search_document"}
    if dimension != model.dimension:
        body["output_dimension"] = dimension
    data = _post(provider, "https://api.cohere.com/v2/embed", {"Authorization": f"Bearer {_key(provider)}"}, body)
    return data["embeddings"]["float"]


def _voyage(model: Model, texts: list[str], kind: Kind, dimension: int) -> list[list[float]]:
    provider = PROVIDERS["voyage"]
    body: dict = {"model": model.id, "input": texts, "input_type": kind}
    if dimension != model.dimension:
        body["output_dimension"] = dimension
    data = _post(provider, "https://api.voyageai.com/v1/embeddings", {"Authorization": f"Bearer {_key(provider)}"}, body)
    return _by_index(data["data"])


def _google(model: Model, texts: list[str], kind: Kind, dimension: int) -> list[list[float]]:
    provider = PROVIDERS["google"]
    name = f"models/{model.id}"
    task = "RETRIEVAL_QUERY" if kind == "query" else "RETRIEVAL_DOCUMENT"
    requests = []
    for text in texts:
        request: dict = {"model": name, "content": {"parts": [{"text": text}]}, "taskType": task}
        if dimension != model.dimension:
            request["outputDimensionality"] = dimension
        requests.append(request)
    url = f"https://generativelanguage.googleapis.com/v1beta/{name}:batchEmbedContents"
    data = _post(provider, url, {"x-goog-api-key": _key(provider)}, {"requests": requests})
    return [item["values"] for item in data["embeddings"]]


def _mistral(model: Model, texts: list[str], kind: Kind, dimension: int) -> list[list[float]]:
    provider = PROVIDERS["mistral"]
    data = _post(provider, "https://api.mistral.ai/v1/embeddings", {"Authorization": f"Bearer {_key(provider)}"},
                 {"model": model.id, "input": texts})
    return _by_index(data["data"])


def _jina(model: Model, texts: list[str], kind: Kind, dimension: int) -> list[list[float]]:
    provider = PROVIDERS["jina"]
    body: dict = {"model": model.id, "input": texts, "task": "retrieval.query" if kind == "query" else "retrieval.passage"}
    if dimension != model.dimension:
        body["dimensions"] = dimension
    data = _post(provider, "https://api.jina.ai/v1/embeddings", {"Authorization": f"Bearer {_key(provider)}"}, body)
    return _by_index(data["data"])


_local_lock = threading.Lock()
_local_models: dict[str, object] = {}


def _local(model: Model, texts: list[str], kind: Kind, dimension: int) -> list[list[float]]:
    try:
        from fastembed import TextEmbedding
    except ImportError:
        raise FailedPrecondition('local embedding models need fastembed: pip install "needledb[local]"') from None
    with _local_lock:
        engine = _local_models.get(model.id)
        if engine is None:
            cache = os.environ.get("NEEDLEDB_MODEL_CACHE")
            engine = TextEmbedding(model.id, cache_dir=cache) if cache else TextEmbedding(model.id)
            _local_models[model.id] = engine
    run = engine.query_embed if kind == "query" else engine.passage_embed  # adds each model's prefixes
    return [vector.tolist() for vector in run(texts)]


CALLERS: dict[str, Callable[[Model, list[str], Kind, int], list[list[float]]]] = {
    "openai": _openai, "cohere": _cohere, "voyage": _voyage, "google": _google,
    "mistral": _mistral, "jina": _jina, "local": _local,
}


def embed_texts(provider: str, model: str, dimension: int, texts: list[str], kind: Kind) -> np.ndarray:
    """Embed `texts` in provider-sized batches. Returns an (n × dimension) float32 array."""
    spec = get_model(provider, model)
    for text in texts:
        if not isinstance(text, str) or not text.strip():
            raise InvalidArgument("text must be a non-empty string")
        if len(text) > MAX_TEXT_CHARS:
            raise InvalidArgument(f"text must be at most {MAX_TEXT_CHARS} characters")
    batch = PROVIDERS[provider].batch
    rows: list[list[float]] = []
    for start in range(0, len(texts), batch):
        chunk = texts[start:start + batch]
        out = CALLERS[provider](spec, chunk, kind, dimension)
        if len(out) != len(chunk):
            raise Unavailable(f"{PROVIDERS[provider].name} returned {len(out)} embeddings for {len(chunk)} texts")
        rows.extend(out)
    matrix = np.asarray(rows, dtype=np.float32)
    if matrix.ndim != 2 or matrix.shape[1] != dimension:
        got = matrix.shape[1] if matrix.ndim == 2 else "mixed"
        raise Unavailable(f"{spec.name} returned vectors of dimension {got}; this index expects {dimension}")
    return matrix
