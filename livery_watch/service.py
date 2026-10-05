"""App logic behind the HTTP API: airport boards, live positions, and tail lookups."""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

from . import config
from .errors import LiveryWatchError
from .boards import BoardJob, StoredBoard, common_airline_names, use_common_names
from .fr24 import (FR24Client, check_history_response, feed_looks_valid, parse_history_flight, parse_live,
                   parse_live_all)
from .liveries import LiveryImporter, source_id
from .store import Store
from .util import clean_reg, dig, haversine_km, norm_reg

Json = dict[str, Any]
log = logging.getLogger(__name__)


class TtlCache:
    def __init__(self) -> None:
        self._items: dict[str, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def get(self, key: str, max_age: float) -> Any | None:
        with self._lock:
            hit = self._items.get(key)
        return hit[1] if hit and time.time() - hit[0] < max_age else None

    def put(self, key: str, value: Any) -> None:
        with self._lock:
            self._items[key] = (time.time(), value)


class LiveryWatch:
    def __init__(self, store: Store, importer: LiveryImporter, client: FR24Client | None = None,
                 sleep: Callable[[float], None] = time.sleep, cache_dir: Path | None = config.CACHE_DIR) -> None:
        self.store = store
        self.importer = importer
        self.client = client or FR24Client()
        self._sleep = sleep
        self._cache_dir = cache_dir
        self._jobs: dict[str, BoardJob | StoredBoard] = {}
        self._jobs_lock = threading.Lock()
        self._live = TtlCache()
        self._tails = TtlCache()

    # Registry

    def registry_map(self) -> dict[str, Json]:
        return {norm_reg(e["reg"]): e for e in self.store.read()["registry"]}

    def summary(self) -> Json:
        data = self.store.read()
        source = data["imports"].get(source_id(config.LIVERY_SOURCE), {})
        return {
            "registry": [_public_entry(e) for e in data["registry"]],
            "prefs": data["prefs"],
            "database": {**self.importer.status, "count": source.get("count", 0),
                         "updated": source.get("updated", source.get("source_updated", ""))},
        }

    def database_status(self) -> Json:
        return self.summary()["database"]

    # Airport boards

    def board(self, code: str, fresh: bool = False) -> Json:
        """The board so far; check "complete" and ask again for the rest."""
        job = self._board_job(code, fresh)
        job.first_page_ready.wait(config.FIRST_PAGE_WAIT_SECONDS)
        return job.result()

    def board_complete(self, code: str, fresh: bool = False) -> Json:
        job = self._board_job(code, fresh)
        job.finished.wait()
        return job.result()

    def _board_job(self, code: str, fresh: bool) -> BoardJob | StoredBoard:
        """Reuse a recent board; a refresh re-reads only the next few hours of a board under 15 minutes old."""
        code = _airport_code(code)
        with self._jobs_lock:
            job = self._jobs.get(code) or self._load_board(code)
            if job is not None and not job.done:
                return job
            age = time.time() - job.started if job else None
            usable = job is not None and not job.error and age < config.BOARD_CACHE_SECONDS
            if usable and (not fresh or age < config.MIN_REFRESH_SECONDS):
                self._jobs[code] = job
                return job
            previous = job.result() if usable else None
            job = BoardJob(code, self.client, self._sleep, previous=previous, on_complete=self._save_board).start()
            self._jobs[code] = job
        return job

    # Board cache on disk

    def _board_path(self, code: str) -> Path | None:
        return self._cache_dir / f"board-{code}.json" if self._cache_dir else None

    def _save_board(self, board: Json) -> None:
        path = self._board_path(board["airport"]["code"])
        if not path:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(board, ensure_ascii=False), encoding="utf-8")
            tmp.replace(path)
        except OSError as e:
            log.warning("Couldn't save the %s board to disk: %s", board["airport"]["code"], e)

    def _load_board(self, code: str) -> StoredBoard | None:
        path = self._board_path(code)
        if not path or not path.exists():
            return None
        try:
            board = json.loads(path.read_text(encoding="utf-8"))
            stored = StoredBoard(board)
        except (OSError, ValueError, KeyError):
            return None
        return stored if time.time() - stored.started < config.BOARD_CACHE_SECONDS else None

    # Live positions

    def live_positions(self, code: str, regs: list[str]) -> dict[str, Json]:
        """Where these aircraft are now: one request for the area around the airport when its
        position is known, otherwise one request per aircraft."""
        job = self._jobs.get(_airport_code(code))
        airport = job.result()["airport"] if job else {}
        regs = regs[:config.MAX_LIVE_LOOKUPS]
        if airport.get("lat") is not None:
            nearby = self._live_area(airport)
            found = {reg: nearby.get(norm_reg(reg)) for reg in regs}
        else:
            with ThreadPoolExecutor(max_workers=config.LIVE_LOOKUP_WORKERS) as pool:
                found = dict(zip(regs, pool.map(self._live_position, regs)))
        positions: dict[str, Json] = {}
        for reg, position in found.items():
            if position is None:
                continue
            if airport.get("lat") is not None and position["lat"] is not None:
                position["distKm"] = round(haversine_km(airport["lat"], airport["lon"],
                                                        position["lat"], position["lon"]), 1)
            positions[reg] = {k: position.get(k) for k in ("onGround", "speed", "alt", "distKm")}
        return positions

    def _live_area(self, airport: Json) -> dict[str, Json]:
        key = f"area:{airport['code']}"
        cached = self._live.get(key, config.LIVE_CACHE_SECONDS)
        if cached is None:
            feed = self.client.live_area(airport["lat"], airport["lon"], config.LIVE_AREA_KM)
            if feed is not None and not feed_looks_valid(feed):
                log.warning("Flightradar24's live feed format looks different; skipping live positions.")
                feed = None
            cached = parse_live_all(feed)
            self._live.put(key, cached)
        return {k: dict(v) for k, v in cached.items()}

    def _live_position(self, reg: str) -> Json | None:
        key = norm_reg(reg)
        cached = self._live.get(key, config.LIVE_CACHE_SECONDS)
        if cached is not None:
            return dict(cached) or None
        position = parse_live(self.client.live_feed(reg), reg)
        self._live.put(key, position or {})
        return dict(position) if position else None

    # Tails

    def _known_airline_names(self) -> dict[str, str]:
        flights = [f for job in list(self._jobs.values()) if job.done and not job.error
                   for f in job.result()["flights"]]
        return common_airline_names(flights)

    def tail(self, raw: str) -> Json:
        reg = clean_reg(raw) or re.sub(r"[^A-Z0-9-]", "", (raw or "").upper())
        if not reg:
            raise LiveryWatchError("Enter a tail number, like JA894A or N933AK.")
        entry = self.registry_map().get(norm_reg(reg))
        if not entry:
            return {"special": False, "reg": reg}
        return {"special": True, "reg": entry["reg"], "entry": _public_entry(entry),
                "flights": self.tail_schedule(entry["reg"])}

    def tail_schedule(self, reg: str) -> list[Json]:
        key = norm_reg(reg)
        cached = self._tails.get(key, config.TAIL_CACHE_SECONDS)
        if cached is not None:
            return cached
        now = int(time.time())
        rows = check_history_response(self.client.aircraft_history(reg))
        flights = [f for f in map(parse_history_flight, rows) if f]
        flights = [f for f in flights
                   if (f["arr"]["ts"] or f["dep"]["ts"]) >= now - config.TAIL_HISTORY_BEFORE_SECONDS
                   and (f["dep"]["ts"] or f["arr"]["ts"]) <= now + config.TAIL_HISTORY_AFTER_SECONDS]
        flights.sort(key=lambda f: f["dep"]["ts"] or f["arr"]["ts"])
        flights = flights[:config.MAX_TAIL_FLIGHTS]
        use_common_names(flights, self._known_airline_names())
        self._tails.put(key, flights)
        return flights


def _airport_code(code: str) -> str:
    code = (code or "").strip().upper()
    if len(code) != 3 or not code.isalnum():
        raise LiveryWatchError("Enter a 3-letter IATA airport code, like SFO or HND.")
    return code


def _public_entry(entry: Json) -> Json:
    return {k: entry.get(k, "") for k in ("reg", "airline", "type", "livery")}
