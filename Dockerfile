# ---- dashboard ---------------------------------------------------------------------
FROM node:22-alpine AS ui
WORKDIR /ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build -- --outDir /static --emptyOutDir

# ---- server ------------------------------------------------------------------------
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NEEDLEDB_DATA=/data \
    NEEDLEDB_HOST=0.0.0.0 \
    NEEDLEDB_PORT=8080
WORKDIR /app
COPY pyproject.toml README.md ./
COPY needledb ./needledb
COPY --from=ui /static ./needledb/server/static
RUN pip install --no-cache-dir . \
    && useradd --system --uid 10001 needle \
    && mkdir -p /data && chown needle /data
USER needle
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2)"
# Needs NEEDLEDB_API_KEY (or NEEDLEDB_ALLOW_NO_AUTH=1). One process owns /data.
CMD ["needledb", "serve"]
