"""App logic behind the HTTP API: airport boards, live positions, and tail lookups."""
from __future__ import annotations

import re
import threading
import time
from collections import Counter
from typing import Any, Callable

from . import config
from .errors import LiveryWatchError
from .fr24 import FR24Client, board_details, parse_board_flight, parse_history_flight, parse_live
from .liveries import LiveryImporter, source_id
from .store import Store
from .util import clean_reg, dig, haversine_km, norm_reg

Json = dict[str, Any]


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
                 sleep: Callable[[float], None] = time.sleep) -> None:
        self.store = store
        self.importer = importer
        self.client = client or FR24Client()
        self._sleep = sleep
        self._boards = TtlCache()
        self._live = TtlCache()
        self._tails = TtlCache()
        self._airline_names: dict[str, str] = {}

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
        code = _airport_code(code)
        cached = self._boards.get(code, config.MIN_REFRESH_SECONDS if fresh else config.BOARD_CACHE_SECONDS)
        if cached:
            return cached
        now = int(time.time())
        airport: Json = {"code": code, "name": "", "tz": "", "offset": 0, "lat": None, "lon": None}
        arrivals, cut_a = self._read_board(code, "arrivals", now, airport)
        self._sleep(config.PAGE_DELAY_SECONDS)
        departures, cut_d = self._read_board(code, "departures", now, airport)
        flights = sorted(arrivals + departures, key=lambda f: f["ts"])
        self._airline_names.update(common_airline_names(flights))
        use_common_names(flights, self._airline_names)
        result = {
            "airport": airport,
            "fetchedAt": now,
            "truncated": cut_a or cut_d,
            "counts": {"arr": len(arrivals), "dep": len(departures), "withTail": sum(bool(f["reg"]) for f in flights)},
            "flights": flights,
        }
        self._boards.put(code, result)
        return result

    def _read_board(self, code: str, mode: str, now: int, airport: Json) -> tuple[list[Json], bool]:
        start, horizon = now - config.LOOKBACK_SECONDS, now + config.LOOKAHEAD_SECONDS
        flights: list[Json] = []
        seen: set[tuple[str, int]] = set()
        page, total, reached_horizon = 1, 1, False
        while page <= min(total, config.MAX_BOARD_PAGES) and not reached_horizon:
            if page > 1:
                self._sleep(config.PAGE_DELAY_SECONDS)
            plugin_data = dig(self.client.airport_board(code, mode, page, start),
                              "result", "response", "airport", "pluginData") or {}
            schedule = dig(plugin_data, "schedule", mode) or {}
            if page == 1:
                if not plugin_data.get("details") and not schedule:
                    raise LiveryWatchError(f"Flightradar24 doesn't recognise {code}. Check the IATA code.")
                details = board_details(plugin_data)
                for key, value in details.items():
                    airport[key] = airport[key] or value
            total = dig(schedule, "page", "total") or 1
            for item in schedule.get("data") or []:
                flight = parse_board_flight(item, mode, airport["offset"])
                if not flight or flight["ts"] < start:
                    continue
                if flight["ts"] > horizon:
                    reached_horizon = True
                    continue
                key = (flight["number"], flight["ts"])
                if key not in seen:
                    seen.add(key)
                    flights.append(flight)
            page += 1
        truncated = not reached_horizon and page <= total
        return flights, truncated

    # Live positions

    def live_positions(self, code: str, regs: list[str]) -> dict[str, Json]:
        board = self._boards.get(_airport_code(code), config.LOOKAHEAD_SECONDS)
        airport = board["airport"] if board else {}
        positions: dict[str, Json] = {}
        for i, reg in enumerate(regs[:config.MAX_LIVE_LOOKUPS]):
            if i:
                self._sleep(config.LIVE_DELAY_SECONDS)
            position = self._live_position(reg)
            if position is None:
                continue
            if airport.get("lat") is not None and position["lat"] is not None:
                position["distKm"] = round(haversine_km(airport["lat"], airport["lon"],
                                                        position["lat"], position["lon"]), 1)
            positions[reg] = {k: position.get(k) for k in ("onGround", "speed", "alt", "distKm")}
        return positions

    def _live_position(self, reg: str) -> Json | None:
        key = norm_reg(reg)
        cached = self._live.get(key, config.LIVE_CACHE_SECONDS)
        if cached is not None:
            return dict(cached) or None
        position = parse_live(self.client.live_feed(reg), reg)
        self._live.put(key, position or {})
        return dict(position) if position else None

    # Tails

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
        rows = dig(self.client.aircraft_history(reg), "result", "response", "data") or []
        flights = [f for f in map(parse_history_flight, rows) if f]
        flights = [f for f in flights
                   if (f["arr"]["ts"] or f["dep"]["ts"]) >= now - config.TAIL_HISTORY_BEFORE_SECONDS
                   and (f["dep"]["ts"] or f["arr"]["ts"]) <= now + config.TAIL_HISTORY_AFTER_SECONDS]
        flights.sort(key=lambda f: f["dep"]["ts"] or f["arr"]["ts"])
        flights = flights[:config.MAX_TAIL_FLIGHTS]
        use_common_names(flights, self._airline_names)
        self._tails.put(key, flights)
        return flights


NAME_FIELDS = (("airline", "airlineName"), ("operatorCode", "operator"))


def common_airline_names(flights: list[Json]) -> dict[str, str]:
    """Each airline's most common name. Special-livery aircraft often carry an extra note in
    their airline name, but they're a minority, so the plain name wins."""
    by_code: dict[str, Counter[str]] = {}
    for flight in flights:
        for code_field, name_field in NAME_FIELDS:
            if flight.get(code_field) and flight.get(name_field):
                by_code.setdefault(flight[code_field], Counter())[flight[name_field]] += 1
    return {code: min(names.items(), key=lambda item: (-item[1], len(item[0])))[0]
            for code, names in by_code.items()}


def use_common_names(flights: list[Json], names: dict[str, str]) -> None:
    for flight in flights:
        for code_field, name_field in NAME_FIELDS:
            if flight.get(code_field) in names:
                flight[name_field] = names[flight[code_field]]


def _airport_code(code: str) -> str:
    code = (code or "").strip().upper()
    if len(code) != 3 or not code.isalnum():
        raise LiveryWatchError("Enter a 3-letter IATA airport code, like SFO or HND.")
    return code


def _public_entry(entry: Json) -> Json:
    return {k: entry.get(k, "") for k in ("reg", "airline", "type", "livery")}
