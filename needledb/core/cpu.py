"""How much CPU this process may actually use, and giving memory back when done with it.

Inside a container the machine's core count is a lie: cgroups cap how much CPU the
process gets, but FAISS (through OpenMP) and thread pools still size themselves to the
host. The result is more runnable threads than the cgroup will schedule, which costs
tail latency. These helpers read the real budget and keep every pool inside it.
"""
from __future__ import annotations

import os
from pathlib import Path

_CGROUP_V2 = Path("/sys/fs/cgroup/cpu.max")
_CGROUP_MEM_V2 = Path("/sys/fs/cgroup/memory.max")
_CGROUP_MEM_V1 = Path("/sys/fs/cgroup/memory/memory.limit_in_bytes")
_CGROUP_V1 = (Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"), Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us"))


def _cgroup_cpus() -> float | None:
    try:
        quota, period = _CGROUP_V2.read_text().split()
        if quota != "max":
            return float(quota) / float(period)
    except (OSError, ValueError):
        pass
    try:
        quota = int(_CGROUP_V1[0].read_text())
        period = int(_CGROUP_V1[1].read_text())
        if quota > 0 and period > 0:
            return quota / period
    except (OSError, ValueError):
        pass
    return None


def cpu_budget() -> int:
    """Cores this process can really run on: the cgroup quota, the CPU affinity, or the machine."""
    override = os.environ.get("NEEDLEDB_CPUS")
    if override:
        try:
            return max(1, int(override))
        except ValueError:
            pass
    limits = [c for c in (_cgroup_cpus(),) if c]
    try:
        limits.append(len(os.sched_getaffinity(0)))
    except AttributeError:
        limits.append(os.cpu_count() or 1)
    return max(1, int(min(limits)))


def tune_threads(budget: int | None = None) -> int:
    """Keep FAISS's thread pool inside the budget. Returns the budget."""
    budget = budget or cpu_budget()
    try:
        import faiss

        faiss.omp_set_num_threads(budget)
    except (ImportError, AttributeError):  # pragma: no cover — faiss always provides it
        pass
    return budget


_libc = None


def release_free_memory() -> None:
    """Hand freed heap back to the OS (glibc only).

    Swapping a large index's storage frees hundreds of megabytes at once, and the allocator
    holds that in its arenas: harmless for the process, but it counts against a container's
    memory limit and shows up in every memory report.
    """
    global _libc
    if _libc is False:
        return
    if os.name != "posix" or not Path("/proc/self/status").exists():
        return                                              # macOS and friends: nothing to do
    try:
        if _libc is None:
            import ctypes

            _libc = ctypes.CDLL("libc.so.6", use_errno=True)
        _libc.malloc_trim(0)
    except (OSError, AttributeError):
        _libc = False


def memory_limit() -> int:
    """Bytes this process may use: the container's limit where there is one, else the machine's."""
    override = os.environ.get("NEEDLEDB_MEMORY")
    if override:
        try:
            return max(1, int(float(override) * 2 ** 30))      # given in GiB
        except ValueError:
            pass
    for path in (_CGROUP_MEM_V2, _CGROUP_MEM_V1):
        try:
            value = path.read_text().strip()
            if value not in ("max", "") and 0 < int(value) < 2 ** 62:
                return int(value)
        except (OSError, ValueError):
            continue
    try:
        import psutil

        return int(psutil.virtual_memory().total)
    except Exception:  # noqa: BLE001 — a missing psutil must not stop a load
        return 8 * 2 ** 30
