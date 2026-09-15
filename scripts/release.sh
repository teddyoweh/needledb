#!/usr/bin/env bash
# Build, verify and (optionally) publish needledb.
#
#   scripts/release.sh             build the sdist and wheel, then verify them
#   scripts/release.sh --publish   ...and upload to PyPI (reads UV_PUBLISH_TOKEN)
#
# Verification installs the wheel into a clean virtualenv, starts the server and
# exercises the API, the web app, the SDK and embedded mode. Nothing is uploaded
# unless every check passes.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf dist
npm --prefix ui ci --no-audit --no-fund
npm --prefix ui run build
NEEDLEDB_REQUIRE_UI=1 uv build

wheel=$(ls dist/needledb-*.whl)
sdist=$(ls dist/needledb-*.tar.gz)
# Capture listings first: `cmd | grep -q` fails under pipefail when grep exits early.
wheel_files=$(unzip -Z1 "$wheel")
sdist_files=$(tar -tzf "$sdist")
grep -qx "needledb/server/static/index.html" <<<"$wheel_files" || { echo "wheel is missing the web app" >&2; exit 1; }
grep -q "/needledb/server/static/index.html$" <<<"$sdist_files" || { echo "sdist is missing the web app" >&2; exit 1; }
uvx twine check --strict dist/*

tmp=$(mktemp -d)
server=""
trap '[ -n "$server" ] && kill "$server" 2>/dev/null; rm -rf "$tmp"' EXIT
uv venv -q --python "${PYTHON:-3.12}" "$tmp/venv"
uv pip install -q --python "$tmp/venv/bin/python" "$wheel"

port=18765
"$tmp/venv/bin/needledb" serve --no-auth --port "$port" --data "$tmp/data" --log-level warning &
server=$!
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$port/health" >/dev/null && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$port/app/" | grep -q '<div id="root">' || { echo "the web app isn't served" >&2; exit 1; }

(cd "$tmp" && NEEDLEDB_URL="http://127.0.0.1:$port" "$tmp/venv/bin/python" - <<'PY'
import numpy as np
from needledb import NeedleDB, NeedleDBLocal

rng = np.random.default_rng(0)
vectors = rng.random((200, 32), dtype=np.float32)
ids = [f"v{i}" for i in range(200)]
meta = [{"group": "a" if i % 2 else "b"} for i in range(200)]

db = NeedleDB()
db.create_index("smoke", dimension=32)
index = db.Index("smoke")
index.upsert_arrays(ids, vectors, meta)
res = index.query(vector=vectors[3], top_k=5, include_metadata=True, filter={"group": "a"})
assert res.matches[0].id == "v3", res
assert db.describe_index("smoke").vector_count == 200

with NeedleDBLocal("./local") as local:
    local.create_index("smoke", dimension=32)
    li = local.Index("smoke")
    li.upsert_arrays(ids, vectors)
    assert li.query(vector=vectors[7], top_k=1).matches[0].id == "v7"
print("smoke test passed")
PY
)

if [ "${1:-}" = "--publish" ]; then
  uv publish dist/*
fi
