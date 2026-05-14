"""Migration-version tracking.

Several boot-time migrations were written as "run every boot — they
re-check whether work is needed and no-op when not." That was fine
when the codebase was new, but it adds startup time and bloats logs
with "[Cache] Loaded N tracks" / "[migrate] no-op" lines on every
launch. Worse, an idempotent migration can re-fire if the underlying
data is reset or partially restored (e.g. user copies an old
``~/.audimo`` into a fresh install).

This module persists which migrations have already run in
``~/.audimo/migrations.json``::

    {"completed": ["tunnel_to_audimo", "audiobook_category_backfill", ...]}

Callers wrap each migration with ``run_once("<name>", fn)``. ``fn``
runs at most once per install (per the persisted ledger). Re-running
on a freshly-restored ``~/.audimo`` that doesn't yet contain
``migrations.json`` is the expected behavior — that's exactly what
a "restore from backup on a new install" flow should re-trigger.

The migrations themselves stay idempotent so this layer is a perf +
log-noise win, not a correctness guarantee. If you're adding a new
migration, leave the underlying function safe to re-run.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Callable

_PATH = Path.home() / ".audimo" / "migrations.json"


def _load() -> set[str]:
    try:
        data = json.loads(_PATH.read_text())
        c = data.get("completed")
        if isinstance(c, list):
            return {str(x) for x in c}
    except FileNotFoundError:
        return set()
    except Exception as e:
        print(f"[migrations] load error (treating as empty): {e}", flush=True)
    return set()


def _save(completed: set[str]) -> None:
    try:
        _PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = _PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(
            {"completed": sorted(completed)}, indent=2,
        ))
        os.replace(tmp, _PATH)
    except Exception as e:
        print(f"[migrations] save error: {e}", flush=True)


def run_once(name: str, fn: Callable[[], None]) -> bool:
    """Run ``fn`` if migration ``name`` hasn't completed yet.

    Returns True if ``fn`` was called, False if it was skipped.
    On exception inside ``fn``, the migration is NOT marked done —
    the next boot will retry.
    """
    completed = _load()
    if name in completed:
        return False
    fn()
    completed.add(name)
    _save(completed)
    return True


def mark_complete(name: str) -> None:
    """Manually mark a migration as run — useful when the migration
    happens implicitly elsewhere and we just want to stop re-checking."""
    completed = _load()
    if name not in completed:
        completed.add(name)
        _save(completed)
