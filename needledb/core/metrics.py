"""Request counters, latency histograms and a rolling window for live QPS and p50/p99."""
from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

import numpy as np

_BUCKETS_MS = (0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000)
WINDOW_S = 60.0


def _summary(values: list[float]) -> dict:
    if not values:
        return {"qps": 0.0, "count": 0, "p50Ms": None, "p95Ms": None, "p99Ms": None}
    arr = np.asarray(values)
    p50, p95, p99 = np.percentile(arr, [50, 95, 99])
    return {"qps": round(len(values) / WINDOW_S, 2), "count": len(values),
            "p50Ms": round(float(p50), 3), "p95Ms": round(float(p95), 3),
            "p99Ms": round(float(p99), 3)}


class Metrics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._requests: dict[tuple[str, str, str, int], int] = defaultdict(int)
        self._hist: dict[str, list[int]] = defaultdict(lambda: [0] * (len(_BUCKETS_MS) + 1))
        self._sum_ms: dict[str, float] = defaultdict(float)
        self._window: deque[tuple[float, str, str, float, bool]] = deque()
        self.started = time.time()

    def observe(self, route: str, method: str, status: int, latency_ms: float,
                index: str | None = None) -> None:
        now = time.time()
        with self._lock:
            self._requests[(route, method, index or "", status)] += 1
            hist = self._hist[route]
            for i, edge in enumerate(_BUCKETS_MS):
                if latency_ms <= edge:
                    hist[i] += 1
                    break
            else:
                hist[-1] += 1
            self._sum_ms[route] += latency_ms
            self._window.append((now, route, index or "", latency_ms, status >= 500))
            cutoff = now - WINDOW_S
            while self._window and self._window[0][0] < cutoff:
                self._window.popleft()

    def live(self) -> dict:
        """QPS and latency percentiles over the last minute, overall, per route, per index."""
        now = time.time()
        with self._lock:
            window = [w for w in self._window if w[0] >= now - WINDOW_S]
        by_route: dict[str, list[float]] = defaultdict(list)
        by_index: dict[str, list[float]] = defaultdict(list)
        for _, route, index, ms, _ in window:
            by_route[route].append(ms)
            if index:
                by_index[index].append(ms)
        return {
            "windowSeconds": WINDOW_S,
            "uptimeSeconds": round(now - self.started, 1),
            "errors": sum(1 for w in window if w[4]),
            "all": _summary([w[3] for w in window]),
            "routes": {r: _summary(v) for r, v in sorted(by_route.items())},
            "indexes": {i: _summary(v) for i, v in sorted(by_index.items())},
        }

    def prometheus(self, gauges: dict[str, dict[tuple, float]]) -> str:
        lines = ["# TYPE needledb_requests_total counter"]
        with self._lock:
            for (route, method, index, status), count in sorted(self._requests.items()):
                lines.append(f'needledb_requests_total{{route="{route}",method="{method}",'
                             f'index="{index}",status="{status}"}} {count}')
            lines.append("# TYPE needledb_request_latency_ms histogram")
            for route, hist in sorted(self._hist.items()):
                cumulative = 0
                for edge, count in zip(_BUCKETS_MS, hist):
                    cumulative += count
                    lines.append(f'needledb_request_latency_ms_bucket{{route="{route}",le="{edge}"}} {cumulative}')
                cumulative += hist[-1]
                lines.append(f'needledb_request_latency_ms_bucket{{route="{route}",le="+Inf"}} {cumulative}')
                lines.append(f'needledb_request_latency_ms_sum{{route="{route}"}} {self._sum_ms[route]:.3f}')
                lines.append(f'needledb_request_latency_ms_count{{route="{route}"}} {cumulative}')
        for name, series in gauges.items():
            lines.append(f"# TYPE {name} gauge")
            for labels, value in sorted(series.items()):
                label_str = ",".join(f'{k}="{v}"' for k, v in labels)
                lines.append(f"{name}{{{label_str}}} {value}")
        return "\n".join(lines) + "\n"
