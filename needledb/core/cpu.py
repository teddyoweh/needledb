"""How much CPU this process may actually use, and telling FAISS about it.

Inside a container the machine's core count is a lie: cgroups cap how much CPU the
process gets, but FAISS (through OpenMP) and thread pools still size themselves to the
host. The result is more runnable threads than the cgroup will schedule, which costs
tail latency. These helpers read the real budget and keep every pool inside it.
"""
from __future__ import annotations

import os
from pathlib import Path

_CGROUP_V2 = Path("/sys/fs/cgroup/cpu.max")
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
