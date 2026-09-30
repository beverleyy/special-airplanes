"""Local data file: the livery registry, import history, and display preferences."""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Callable

DIRECTIONS = ("both", "arr", "dep")


def _empty() -> dict[str, Any]:
    return {"registry": [], "imports": {}, "prefs": {"types": [], "direction": "both"}}


class Store:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = threading.Lock()

    def read(self) -> dict[str, Any]:
        with self._lock:
            return self._load()

    def update(self, change: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
        with self._lock:
            data = self._load()
            change(data)
            self._save(data)
            return data

    def save_prefs(self, types: list[str], direction: str) -> None:
        def change(data: dict[str, Any]) -> None:
            data["prefs"] = {
                "types": [str(t) for t in types],
                "direction": direction if direction in DIRECTIONS else "both",
            }
        self.update(change)

    def _load(self) -> dict[str, Any]:
        data = _empty()
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return data
        data["registry"] = [e for e in raw.get("registry", []) if isinstance(e, dict) and e.get("reg")]
        data["imports"] = raw.get("imports", {})
        prefs = raw.get("prefs") or {"types": raw.get("types", []), "direction": raw.get("direction", "both")}
        data["prefs"] = {"types": list(prefs.get("types", [])),
                         "direction": prefs.get("direction") if prefs.get("direction") in DIRECTIONS else "both"}
        return data

    def _save(self, data: dict[str, Any]) -> None:
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self._path)
