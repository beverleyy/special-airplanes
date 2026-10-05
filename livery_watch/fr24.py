"""Flightradar24 client and response parsing.

These are the unofficial endpoints behind flightradar24.com. They are undocumented
and can change without notice; keep usage light and personal.
"""
from __future__ import annotations

import json
import math
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from . import config
from .config import DELAYED_AFTER_SECONDS, USER_AGENT
from .cooldown import Cooldown, retry_after_seconds
from .errors import FR24FormatError, LiveryWatchError
from .util import dig, local_iso, norm_reg

API = "https://api.flightradar24.com/common/v1"
LIVE_FEED = "https://data-cloud.flightradar24.com/zones/fcgi/feed.js"
HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.flightradar24.com",
    "Referer": "https://www.flightradar24.com/",
}
_BLOCKED = (401, 402, 403, 451)
_BRACKETED = re.compile(r"\s*[\(\[]([^\)\]]*)[\)\]]")
_UNCLOSED_BRACKET = re.compile(r"\s*[\(\[][^\)\]]*$")
_QUOTE = re.compile(r"[\"“”„]")
_GENERIC_PAINT_WORDS = re.compile(r"\s*\b(special\s+)?(livery|liveries|colou?rs|scheme|c/s)\b", re.I)
_LIVERY_WORDS = re.compile(
    r"\b(livery|liveries|colou?rs|scheme|c/s|retro|special|heritage|jet|sticker|decal|titles|logo|"
    r"anniversary|years|alliance|oneworld|skyteam)\b", re.I)

Json = dict[str, Any]


# Client

class FR24Client:
    def __init__(self, cooldown: Cooldown | None = None, sleep=time.sleep, clock=time.time) -> None:
        self.cooldown = cooldown if cooldown is not None else Cooldown(config.CACHE_DIR / "fr24-pause.json")
        self._sleep = sleep
        self._clock = clock

    def get_json(self, url: str) -> Json:
        """One request, unless requests are paused. A short wait asked for by a 429 is honoured
        once; anything longer, and every refusal, pauses all Flightradar24 requests."""
        self.cooldown.check()
        request = urllib.request.Request(url, headers=HEADERS)
        for attempt in range(2):
            try:
                with urllib.request.urlopen(request, timeout=20) as response:
                    data = json.loads(response.read().decode("utf-8"))
                self.cooldown.succeeded()
                return data
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    wait = retry_after_seconds(e.headers.get("Retry-After") if e.headers else None, self._clock())
                    if attempt == 0 and wait is not None and wait <= config.SHORT_RETRY_MAX_SECONDS:
                        self._sleep(wait)
                        continue
                    raise self.cooldown.rate_limited(wait) from e
                if e.code in _BLOCKED:
                    raise self.cooldown.refused() from e
                raise LiveryWatchError(f"Flightradar24 returned an error ({e.code}).") from e
            except urllib.error.URLError as e:
                raise LiveryWatchError("Couldn't reach Flightradar24. Check your internet connection.") from e
            except ValueError as e:
                raise FR24FormatError("the answer wasn't JSON") from e
        raise self.cooldown.rate_limited(None)

    def airport_board(self, code: str, mode: str, page: int, timestamp: int, details: bool = True) -> Json:
        plugins = [("plugin[]", "schedule")] + ([("plugin[]", "details")] if details else [])
        query = urllib.parse.urlencode([
            ("code", code),
            *plugins,
            ("plugin-setting[schedule][mode]", mode),
            ("plugin-setting[schedule][timestamp]", str(timestamp)),
            ("page", str(page)),
            ("limit", "100"),
        ])
        return self.get_json(f"{API}/airport.json?{query}")

    def aircraft_history(self, reg: str) -> Json:
        query = urllib.parse.urlencode({"query": reg, "fetchBy": "reg", "page": 1, "limit": 50})
        return self.get_json(f"{API}/flight/list.json?{query}")

    def live_feed(self, reg: str) -> Json | None:
        """Live position of one aircraft, wherever it is."""
        return self._feed({"reg": reg})

    def live_area(self, lat: float, lon: float, radius_km: float) -> Json | None:
        """Every tracked aircraft in a box around a point, in one request."""
        dlat = radius_km / 111.0
        dlon = radius_km / (111.0 * max(math.cos(math.radians(lat)), 0.1))
        return self._feed({"bounds": f"{lat + dlat:.3f},{lat - dlat:.3f},{lon - dlon:.3f},{lon + dlon:.3f}"})

    def _feed(self, filters: dict[str, Any]) -> Json | None:
        query = urllib.parse.urlencode({
            **filters, "faa": 1, "satellite": 1, "mlat": 1, "flarm": 1, "adsb": 1, "gnd": 1, "air": 1,
            "vehicles": 0, "estimated": 1, "maxage": 14400, "gliders": 0, "stats": 0})
        try:
            return self.get_json(f"{LIVE_FEED}?{query}")
        except LiveryWatchError:
            return None


# Format checks

FORMAT_FAILURE_SHARE = 0.5


def check_board_response(response: Any, mode: str) -> tuple[Json, Json, list]:
    """The plugin data, schedule, and flight rows of an airport board page, or FR24FormatError."""
    if not isinstance(response, dict) or not isinstance(dig(response, "result", "response"), dict):
        raise FR24FormatError("airport board has no result")
    airport = dig(response, "result", "response", "airport")
    if not isinstance(airport, dict) or not isinstance(airport.get("pluginData"), dict):
        raise FR24FormatError("airport board has no plugin data")
    plugin_data = airport["pluginData"]
    schedule = dig(plugin_data, "schedule", mode)
    if schedule is None:
        return plugin_data, {}, []
    if not isinstance(schedule, dict):
        raise FR24FormatError(f"{mode} board isn't an object")
    items = schedule.get("data") or []
    if not isinstance(items, list):
        raise FR24FormatError(f"{mode} board rows aren't a list")
    return plugin_data, schedule, items


def _row_has_shape(item: Any) -> bool:
    flight = item.get("flight", item) if isinstance(item, dict) else None
    return isinstance(flight, dict) and isinstance(flight.get("time"), dict) and isinstance(flight.get("identification"), dict)


def check_parsed_page(items: list, flights: list[Json], mode: str) -> None:
    """Rows that are missing their times or flight numbers mean the format changed, not a quiet day."""
    if not items or flights:
        return
    malformed = sum(not _row_has_shape(item) for item in items)
    if malformed / len(items) > FORMAT_FAILURE_SHARE:
        raise FR24FormatError(f"{mode} rows are missing their times or flight numbers")


def check_history_response(response: Any) -> list:
    data = dig(response, "result", "response", "data")
    if data is None and isinstance(dig(response, "result", "response"), dict):
        return []
    if not isinstance(data, list):
        raise FR24FormatError("aircraft history has no flight list")
    return data


# Parsing

def _is_livery_note(text: str) -> bool:
    """Operator notes are short names like '(SkyWest)'; livery notes are longer or mention the paint."""
    return bool(_LIVERY_WORDS.search(text)) or len(text.split()) >= 3 or any(c.isdigit() for c in text)


def _tidy_note(note: str) -> str:
    note = _GENERIC_PAINT_WORDS.sub("", _QUOTE.sub("", note))
    return " ".join(note.split()).strip(" -–/|:([)]")


def split_airline(name: str | None) -> tuple[str, str]:
    """Separate the livery note FR24 appends to some airline names.

    'Alaska Airlines (Seattle Kraken Livery)' -> ('Alaska Airlines', 'Seattle Kraken')
    """
    notes: list[str] = []

    def drop_note(match: re.Match[str]) -> str:
        if not _is_livery_note(match.group(1)):
            return match.group(0)
        notes.append(match.group(1))
        return ""

    text = _BRACKETED.sub(drop_note, name or "")
    unclosed = _UNCLOSED_BRACKET.search(text)
    if unclosed:
        notes.append(unclosed.group(0))
        text = text[:unclosed.start()]
    before_quote, *quoted = _QUOTE.split(text, maxsplit=1)
    notes.extend(quoted)
    airline = " ".join(before_quote.split()).strip(" -–/|:")
    return airline, next((n for n in map(_tidy_note, notes) if n), "")


def clean_airline(name: str | None) -> str:
    """Drop livery notes FR24 appends: 'Alaska Airlines (Seattle Kraken Livery)' -> 'Alaska Airlines'."""
    return split_airline(name)[0]


def _raw_airline_name(flight: Json) -> str:
    return dig(flight, "airline", "name") or dig(flight, "airline", "short") or dig(flight, "owner", "name") or ""


def _airline_name(flight: Json) -> str:
    return clean_airline(_raw_airline_name(flight))


def _livery_note(flight: Json) -> str:
    """The livery name FR24 sometimes puts in the airline or operator name, else ''."""
    return split_airline(_raw_airline_name(flight))[1] or split_airline(dig(flight, "owner", "name"))[1]


def _operator(flight: Json) -> dict[str, str]:
    """The airline flying the aircraft, which FR24 calls the owner."""
    return {"operator": clean_airline(dig(flight, "owner", "name") or ""),
            "operatorCode": (dig(flight, "owner", "code", "iata") or "").upper()}


def _generic_status(flight: Json) -> str:
    return (dig(flight, "status", "generic", "status", "text") or "").lower()


def board_details(plugin_data: Json) -> Json:
    """Airport name, time zone, and position from a board response's details plugin."""
    details = plugin_data.get("details") or {}
    position = details.get("position") or {}
    return {
        "name": details.get("name") or "",
        "tz": dig(details, "timezone", "abbr") or "",
        "offset": dig(details, "timezone", "offset") or 0,
        "lat": position.get("latitude"),
        "lon": position.get("longitude"),
    }


def parse_board_flight(item: Json, mode: str, offset: int) -> Json | None:
    """One arrival or departure from an airport board, or None if it's unusable or cancelled."""
    flight = item.get("flight", item) if isinstance(item, dict) else {}
    leg = "arrival" if mode == "arrivals" else "departure"
    times = flight.get("time") or {}
    scheduled = dig(times, "scheduled", leg)
    estimated = dig(times, "estimated", leg)
    actual = dig(times, "real", leg)
    ts = actual or estimated or scheduled
    status = _generic_status(flight)
    if not ts or status in ("canceled", "cancelled"):
        return None
    other = dig(flight, "airport", "origin" if mode == "arrivals" else "destination") or {}
    return {
        "dir": "arr" if mode == "arrivals" else "dep",
        "ts": ts,
        "local": local_iso(ts, offset),
        "schedTs": scheduled or ts,
        "schedLocal": local_iso(scheduled, offset),
        "estimated": bool(estimated) and not actual,
        "actual": bool(actual),
        "diverted": status == "diverted",
        "number": dig(flight, "identification", "number", "default") or dig(flight, "identification", "callsign") or "",
        "airline": (dig(flight, "airline", "code", "iata") or "").upper(),
        "airlineName": _airline_name(flight),
        "liveryNote": _livery_note(flight),
        **_operator(flight),
        "other": dig(other, "code", "iata") or dig(other, "code", "icao") or "",
        "otherName": other.get("name") or "",
        "reg": dig(flight, "aircraft", "registration") or "",
        "model": dig(flight, "aircraft", "model", "text") or dig(flight, "aircraft", "model", "code") or "",
    }


def _history_time(times: Json, leg: str, airport: Json) -> Json:
    scheduled = dig(times, "scheduled", leg)
    actual = dig(times, "real", leg)
    estimated = dig(times, "estimated", leg) or (dig(times, "other", "eta") if leg == "arrival" else None)
    ts = actual or estimated or scheduled
    offset = dig(airport, "timezone", "offset") or 0
    kind = "actual" if actual else "estimated" if estimated else "scheduled" if scheduled else ""
    return {"ts": ts, "local": local_iso(ts, offset), "schedTs": scheduled or ts,
            "schedLocal": local_iso(scheduled, offset), "tz": dig(airport, "timezone", "abbr") or "", "kind": kind}


def _history_state(flight: Json, dep: Json, arr: Json) -> str:
    status = _generic_status(flight)
    if status in ("canceled", "cancelled"):
        return "Canceled"
    if status == "diverted":
        return "Diverted"
    if arr["kind"] == "actual":
        return "Landed"
    if dep["kind"] == "actual":
        return "In the air" if dig(flight, "status", "live") else "Departed"
    if dep["kind"] == "estimated":
        late = dep["ts"] and dep["schedTs"] and dep["ts"] - dep["schedTs"] >= DELAYED_AFTER_SECONDS
        return "Delayed" if late else "Expected"
    return "Scheduled"


def parse_history_flight(flight: Json) -> Json | None:
    """One flight from an aircraft's history, with times in each airport's own time zone."""
    if not isinstance(flight, dict):
        return None
    times = flight.get("time") or {}
    origin = dig(flight, "airport", "origin") or {}
    dest = dig(flight, "airport", "destination") or {}
    dep, arr = _history_time(times, "departure", origin), _history_time(times, "arrival", dest)
    if not (dep["ts"] or arr["ts"]):
        return None

    def place(airport: Json) -> Json:
        return {"code": dig(airport, "code", "iata") or dig(airport, "code", "icao") or "",
                "name": airport.get("name") or ""}

    return {
        "number": dig(flight, "identification", "number", "default") or dig(flight, "identification", "callsign") or "",
        "airline": (dig(flight, "airline", "code", "iata") or "").upper(),
        "airlineName": _airline_name(flight),
        "liveryNote": _livery_note(flight),
        **_operator(flight),
        "model": dig(flight, "aircraft", "model", "text") or "",
        "origin": place(origin),
        "dest": place(dest),
        "dep": dep,
        "arr": arr,
        "state": _history_state(flight, dep, arr),
    }


FEED_META_KEYS = {"full_count", "version", "stats", "selected-aircraft"}


def feed_looks_valid(feed: Any) -> bool:
    """The live feed is an object of aircraft rows; rows that are too short mean the format changed."""
    if not isinstance(feed, dict):
        return False
    rows = [v for k, v in feed.items() if k not in FEED_META_KEYS]
    return all(isinstance(r, list) and len(r) > 15 for r in rows)


def parse_live_all(feed: Json | None) -> dict[str, Json]:
    """The newest live position of every aircraft in a map feed, keyed by normalized registration.

    Feed rows are lists: [icao24, lat, lon, track, alt_ft, speed_kt, squawk, radar, type,
    reg, timestamp, from, to, flight, on_ground, vertical_speed, callsign, ...].
    """
    newest: dict[str, list] = {}
    for row in (feed or {}).values():
        if not (isinstance(row, list) and len(row) > 15 and row[9]):
            continue
        key = norm_reg(str(row[9]))
        if key not in newest or (row[10] or 0) > (newest[key][10] or 0):
            newest[key] = row
    return {key: {"lat": row[1], "lon": row[2], "alt": row[4], "speed": row[5], "onGround": bool(row[14])}
            for key, row in newest.items()}


def parse_live(feed: Json | None, reg: str) -> Json | None:
    """The newest live position for one registration from a map feed, or None if untracked."""
    return parse_live_all(feed).get(norm_reg(reg))
