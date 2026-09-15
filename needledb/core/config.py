"""Index configuration, limits and the error types every layer shares."""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

from ..errors import AlreadyExists, InvalidArgument, NeedleError, NotFound  # noqa: F401

METRICS = ("cosine", "dotproduct", "euclidean")
INDEX_TYPES = ("auto", "flat", "hnsw")
# How an HNSW index keeps its vectors. fp16 halves the memory, and searches faster,
# at a precision far below what the graph itself already approximates.
STORAGE = ("auto", "float32", "fp16")

MAX_DIMENSION = 65_536
MAX_ID_BYTES = 512
MAX_METADATA_BYTES = 40_000
MAX_TOP_K = 10_000
MAX_UPSERT_BATCH = 10_000

# `auto` indexes search exactly until this many live vectors, then build HNSW.
AUTO_HNSW_THRESHOLD = 20_000
# Filtered queries with at most this many candidates are answered exactly.
BRUTE_FORCE_LIMIT = 5_000
BRUTE_FORCE_FRACTION = 0.02

NAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?$")


@dataclass
class HNSWConfig:
    m: int = 32
    ef_construction: int = 200
    ef_search: int = 128

    def validate(self) -> None:
        if not 4 <= self.m <= 128:
            raise InvalidArgument("hnsw.m must be between 4 and 128")
        if not 16 <= self.ef_construction <= 2000:
            raise InvalidArgument("hnsw.ef_construction must be between 16 and 2000")
        if not 1 <= self.ef_search <= 10_000:
            raise InvalidArgument("hnsw.ef_search must be between 1 and 10000")


@dataclass
class EmbedConfig:
    """The model that turns this index's text into vectors."""
    provider: str
    model: str
    field: str = "text"   # metadata field that keeps each record's source text

    @classmethod
    def from_dict(cls, data) -> "EmbedConfig":
        if not isinstance(data, dict):
            raise InvalidArgument("embed must be an object with provider and model")
        unknown = set(data) - {"provider", "model", "field"}
        if unknown:
            raise InvalidArgument(f"unknown embed fields: {', '.join(sorted(unknown))}")
        return cls(provider=data.get("provider"), model=data.get("model"), field=data.get("field") or "text")

    def validate(self, dimension: int) -> None:
        from ..embed import get_model  # the catalog, without importing it for every index

        if not isinstance(self.provider, str) or not isinstance(self.model, str):
            raise InvalidArgument("embed needs a provider and a model")
        model = get_model(self.provider, self.model)
        if not model.supports(dimension):
            sizes = ", ".join(str(d) for d in sorted({model.dimension, *model.dimensions}))
            raise InvalidArgument(f"{model.name} produces {sizes}-dimensional vectors, not {dimension}")
        if not isinstance(self.field, str) or not 0 < len(self.field) <= 64 or self.field.startswith("$"):
            raise InvalidArgument("embed.field must be a metadata field name of 1-64 characters")


@dataclass
class IndexConfig:
    name: str
    dimension: int
    metric: str = "cosine"
    index_type: str = "auto"
    storage: str = "auto"
    hnsw: HNSWConfig = field(default_factory=HNSWConfig)
    embed: EmbedConfig | None = None
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="seconds"))

    def validate(self) -> "IndexConfig":
        if self.embed is not None and self.dimension is None:
            from ..embed import get_model

            get_model(self.embed.provider, self.embed.model)  # name the unknown model, not the missing dimension
        if not isinstance(self.name, str) or not NAME_RE.match(self.name):
            raise InvalidArgument(
                "index name must be 1-45 characters of lowercase letters, digits and "
                "hyphens, starting and ending with a letter or digit")
        if not isinstance(self.dimension, int) or isinstance(self.dimension, bool) \
                or not 1 <= self.dimension <= MAX_DIMENSION:
            raise InvalidArgument(f"dimension must be an integer from 1 to {MAX_DIMENSION}")
        if self.metric not in METRICS:
            raise InvalidArgument(f"metric must be one of {', '.join(METRICS)}")
        if self.index_type not in INDEX_TYPES:
            raise InvalidArgument(f"index_type must be one of {', '.join(INDEX_TYPES)}")
        if self.storage not in STORAGE:
            raise InvalidArgument(f"storage must be one of {', '.join(STORAGE)}")
        self.hnsw.validate()
        if self.embed is not None:
            self.embed.validate(self.dimension)
        return self

    @property
    def half_precision(self) -> bool:
        """Graph indexes default to fp16 vectors; exact (flat) ones always keep float32."""
        return self.storage == "fp16" or (self.storage == "auto" and self.index_type != "flat")

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "IndexConfig":
        hnsw = data.get("hnsw") or {}
        if not isinstance(hnsw, dict):
            raise InvalidArgument("hnsw must be an object")
        known = {"m", "ef_construction", "ef_search"}
        unknown = set(hnsw) - known
        if unknown:
            raise InvalidArgument(f"unknown hnsw fields: {', '.join(sorted(unknown))}")
        embed = EmbedConfig.from_dict(data["embed"]) if data.get("embed") is not None else None
        dimension = data.get("dimension")
        if dimension is None and embed is not None:
            from ..embed import find_model

            model = find_model(embed.provider, embed.model)
            dimension = model.dimension if model else None
        cfg = cls(
            name=data.get("name"),
            dimension=dimension,
            metric=data.get("metric") or "cosine",
            index_type=data.get("index_type") or "auto",
            storage=data.get("storage") or "auto",
            hnsw=HNSWConfig(**hnsw),
            embed=embed,
        )
        if data.get("created_at"):
            cfg.created_at = data["created_at"]
        return cfg
