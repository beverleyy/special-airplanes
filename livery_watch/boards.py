"""Reading an airport's arrivals and departures boards in the background, page by page."""
from __future__ import annotations

import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from . import config
from .errors import LiveryWatchError
from .fr24 import FR24Client, board_details, check_board_response, check_parsed_page, parse_board_flight
from .util import dig, norm_reg

Json = dict[str, Any]
MODES = ("arrivals", "departures")
LOOKBACK = {"arrivals": config.ARRIVAL_LOOKBACK_SECONDS, "departures": config.DEPARTURE_LOOKBACK_SECONDS}
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


def flight_key(flight: Json) -> tuple:
    """Rows for the same physical flight: same direction, time, route, and aircraft.
    Codeshares share all of these and differ only in flight number."""
    aircraft = norm_reg(flight["reg"]) or flight["model"] or flight["number"]
    return flight["dir"], flight["schedTs"], flight["other"], aircraft


def is_operating(flight: Json) -> bool:
    return bool(flight["airline"]) and flight["airline"] == flight.get("operatorCode")


def use_common_names(flights: list[Json], names: dict[str, str]) -> None:
    for flight in flights:
        for code_field, name_field in NAME_FIELDS:
            if flight.get(code_field) in names:
                flight[name_field] = names[flight[code_field]]


class BoardJob:
    """Both boards for one airport, read in parallel. Partial results are available while it runs.

    Given the previous board, it only re-reads the next few hours and keeps the rest of the day,
    since later flights rarely change between refreshes.
    """

    def __init__(self, code: str, client: FR24Client, sleep: Callable[[float], None] = time.sleep,
                 previous: Json | None = None, on_complete: Callable[[Json], None] | None = None) -> None:
        self.code = code
        self.started = time.time()
        self._client = client
        self._sleep = sleep
        self._previous = previous
        self._on_complete = on_complete
        self._lock = threading.Lock()
        self._now = int(self.started)
        self._airport: Json = dict(previous["airport"]) if previous else \
            {"code": code, "name": "", "tz": "", "offset": 0, "lat": None, "lon": None}
        self._flights: dict[str, list[Json]] = {mode: [] for mode in MODES}
        self._truncated = {mode: False for mode in MODES}
        self._first_pages = 0
        self.first_page_ready = threading.Event()
        self.finished = threading.Event()
        self.error: str | None = None

    @property
    def done(self) -> bool:
        return self.finished.is_set()

    def start(self) -> "BoardJob":
        threading.Thread(target=self._run, daemon=True).start()
        return self

    def result(self) -> Json:
        """The board so far. Raises if reading failed before anything useful arrived."""
        with self._lock:
            if self.error and not any(self._flights.values()):
                raise LiveryWatchError(self.error)
            flights = sorted((dict(f) for mode in MODES for f in self._flights[mode]), key=lambda f: f["ts"])
            airport = dict(self._airport)
            counts = {"arr": len(self._flights["arrivals"]), "dep": len(self._flights["departures"]),
                      "withTail": sum(bool(f["reg"]) for f in flights)}
            truncated = any(self._truncated.values())
            complete = self.done
        use_common_names(flights, common_airline_names(flights))
        board = {"airport": airport, "fetchedAt": self._now, "complete": complete, "truncated": truncated,
                 "counts": counts, "flights": flights}
        if self.error:
            board["note"] = f"Only part of the board was read: {self.error}"
        return board

    def _run(self) -> None:
        try:
            with ThreadPoolExecutor(max_workers=len(MODES)) as pool:
                for future in [pool.submit(self._read, mode) for mode in MODES]:
                    future.result()
            if self._on_complete:
                self._on_complete({**self.result(), "complete": True})
        except LiveryWatchError as e:
            self.error = str(e)
        except Exception:  # surfaced to the user as a generic failure
            self.error = "Reading the boards failed. Check the terminal running Livery Watch."
            raise
        finally:
            self.first_page_ready.set()
            self.finished.set()

    def _read(self, mode: str) -> None:
        start, horizon = self._now - LOOKBACK[mode], self._now + config.LOOKAHEAD_SECONDS
        refresh_until = self._now + config.REFRESH_WINDOW_SECONDS if self._previous else None
        rows: dict[tuple, int] = {}
        page, total, reached_horizon, latest = 1, 1, False, 0
        offset = self._airport["offset"]
        while page <= min(total, config.MAX_BOARD_PAGES) and not reached_horizon:
            if refresh_until and latest >= refresh_until:
                break
            if page > 1:
                self._sleep(config.PAGE_DELAY_SECONDS)
            response = self._client.airport_board(self.code, mode, page, start, details=page == 1)
            plugin_data, schedule, items = check_board_response(response, mode)
            if page == 1:
                if not plugin_data.get("details") and not schedule:
                    raise LiveryWatchError(f"Flightradar24 doesn't recognise {self.code}. Check the IATA code.")
                details = board_details(plugin_data)
                offset = details["offset"] or offset
                with self._lock:
                    for key, value in details.items():
                        self._airport[key] = value or self._airport[key]
            total = dig(schedule, "page", "total") or 1

            flights = []
            for item in items:
                flight = parse_board_flight(item, mode, offset)
                if not flight or flight["ts"] < start:
                    continue
                if flight["ts"] > horizon:
                    reached_horizon = True
                    continue
                latest = max(latest, flight["ts"])
                flights.append(flight)
            check_parsed_page(items, flights, mode)
            with self._lock:
                self._merge(mode, flights, rows)
                if page == 1:
                    self._first_pages += 1
                    if self._first_pages == len(MODES):
                        self.first_page_ready.set()
            page += 1

        stopped_early = bool(refresh_until) and latest >= refresh_until and not reached_horizon
        if stopped_early:
            direction = "arr" if mode == "arrivals" else "dep"
            kept = [dict(f) for f in self._previous["flights"] if f["dir"] == direction and f["ts"] > latest]
            with self._lock:
                self._merge(mode, kept, rows)
                self._truncated[mode] = bool(self._previous.get("truncated"))
        else:
            with self._lock:
                self._truncated[mode] = not reached_horizon and page <= total

    def _merge(self, mode: str, flights: list[Json], rows: dict[tuple, int]) -> None:
        """Add a page of flights, folding codeshare rows into the operating flight."""
        board = self._flights[mode]
        for flight in flights:
            key = flight_key(flight)
            if key not in rows:
                rows[key] = len(board)
                board.append(flight)
            elif is_operating(flight) and not is_operating(board[rows[key]]):
                board[rows[key]] = flight


class StoredBoard:
    """A finished board loaded from disk, standing in for a BoardJob."""

    def __init__(self, board: Json) -> None:
        self.code = board["airport"]["code"]
        self.started = float(board["fetchedAt"])
        self.error: str | None = None
        self._board = board
        self.first_page_ready = threading.Event()
        self.finished = threading.Event()
        self.first_page_ready.set()
        self.finished.set()

    @property
    def done(self) -> bool:
        return True

    def result(self) -> Json:
        return {**self._board, "complete": True, "flights": [dict(f) for f in self._board["flights"]]}
