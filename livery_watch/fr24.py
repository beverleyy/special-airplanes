"""Flightradar24 client and response parsing.

These are the unofficial endpoints behind flightradar24.com. They are undocumented
and can change without notice; keep usage light and personal.
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .config import DELAYED_AFTER_SECONDS, USER_AGENT
from .errors import LiveryWatchError
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
_LIVERY_NOTE = re.compile(
    r"\s*[\(\[][^\)\]]*\b(livery|liveries|colou?rs|scheme|c/s|retro|special|heritage|jet)\b[^\)\]]*[\)\]]", re.I)

Json = dict[str, Any]


# Client

class FR24Client:
    def get_json(self, url: str) -> Json:
        request = urllib.request.Request(url, headers=HEADERS)
        for attempt in range(3):
            try:
                with urllib.request.urlopen(request, timeout=20) as response:
                    return json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt < 2:
                    time.sleep(5 * (attempt + 1))
                    continue
                if e.code in _BLOCKED:
                    raise LiveryWatchError("Flightradar24 refused the request. It may be rate limiting you; "
                                           "wait a few minutes and try again.") from e
                raise LiveryWatchError(f"Flightradar24 returned an error ({e.code}).") from e
            except urllib.error.URLError as e:
                raise LiveryWatchError("Couldn't reach Flightradar24. Check your internet connection.") from e
            except ValueError as e:
                raise LiveryWatchError("Flightradar24 sent back something that isn't flight data. "
                                       "Their site may have changed.") from e
        raise LiveryWatchError("Flightradar24 kept rate limiting. Wait a few minutes and try again.")

    def airport_board(self, code: str, mode: str, page: int, timestamp: int) -> Json:
        query = urllib.parse.urlencode([
            ("code", code),
            ("plugin[]", "schedule"),
            ("plugin[]", "details"),
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
        query = urllib.parse.urlencode({
            "reg": reg, "faa": 1, "satellite": 1, "mlat": 1, "flarm": 1, "adsb": 1, "gnd": 1, "air": 1,
            "vehicles": 0, "estimated": 1, "maxage": 14400, "gliders": 0, "stats": 0})
        try:
            return self.get_json(f"{LIVE_FEED}?{query}")
        except LiveryWatchError:
            return None


# Parsing

def clean_airline(name: str | None) -> str:
    """Drop livery notes FR24 appends: 'Alaska Airlines (Seattle Kraken Livery)' -> 'Alaska Airlines'."""
    return " ".join(_LIVERY_NOTE.sub("", name or "").split())


def _airline_name(flight: Json) -> str:
    return clean_airline(dig(flight, "airline", "name") or dig(flight, "airline", "short")
                         or dig(flight, "owner", "name") or "")


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
        "airlineName": _airline_name(flight),
        "model": dig(flight, "aircraft", "model", "text") or "",
        "origin": place(origin),
        "dest": place(dest),
        "dep": dep,
        "arr": arr,
        "state": _history_state(flight, dep, arr),
    }


def parse_live(feed: Json | None, reg: str) -> Json | None:
    """The newest live position for a registration from the map feed, or None if untracked.

    Feed rows are lists: [icao24, lat, lon, track, alt_ft, speed_kt, squawk, radar, type,
    reg, timestamp, from, to, flight, on_ground, vertical_speed, callsign, ...].
    """
    best = None
    for row in (feed or {}).values():
        if isinstance(row, list) and len(row) > 15 and norm_reg(str(row[9])) == norm_reg(reg):
            if best is None or (row[10] or 0) > (best[10] or 0):
                best = row
    if best is None:
        return None
    return {"lat": best[1], "lon": best[2], "alt": best[4], "speed": best[5], "onGround": bool(best[14])}
