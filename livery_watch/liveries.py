"""Special livery database import from pages that list liveries in HTML tables."""
from __future__ import annotations

import logging
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from typing import Any

from .config import USER_AGENT
from .errors import LiveryWatchError
from .store import Store
from .util import clean_reg, norm_reg

log = logging.getLogger(__name__)

_FR24_AIRCRAFT_LINK = re.compile(r"flightradar24\.com/data/aircraft/([A-Za-z0-9-]+)", re.I)
_LAST_UPDATED = re.compile(r"Last\s+Updated:?\s*([0-9]{1,2}[-\s][A-Za-z]+[-\s][0-9]{4})")
_COLUMN_KEYWORDS = {
    "reg": ("reg", "tail"),
    "airline": ("airline", "operator", "carrier"),
    "type": ("type", "aircraft", "model", "equipment"),
    "livery": ("livery", "scheme", "description", "theme", "name", "special", "details", "colour", "color"),
}
_MAX_AIRLINE_CHARS = 40
_MAX_LIVERY_CHARS = 160

Cell = dict[str, Any]
Table = list[list[Cell]]
Entry = dict[str, str]


# Table parsing

class _TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[Table] = []
        self._table: Table | None = None
        self._row: list[Cell] | None = None
        self._cell: Cell | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "table":
            self._table = []
        elif tag == "tr" and self._table is not None:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = {"text": "", "links": [], "th": tag == "th"}
        elif tag == "a" and self._cell is not None:
            href = dict(attrs).get("href")
            if href:
                self._cell["links"].append(href)
        elif tag == "br" and self._cell is not None:
            self._cell["text"] += " "

    def handle_endtag(self, tag: str) -> None:
        if tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._cell["text"] = " ".join(self._cell["text"].split())
            self._row.append(self._cell)
            self._cell = None
        elif tag == "tr" and self._row is not None and self._table is not None:
            if self._row:
                self._table.append(self._row)
            self._row = None
        elif tag == "table" and self._table is not None:
            self.tables.append(self._table)
            self._table = None

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell["text"] += data


def _reg_from_links(cell: Cell) -> str:
    for href in cell["links"]:
        match = _FR24_AIRCRAFT_LINK.search(href)
        if match:
            return clean_reg(match.group(1))
    return ""


def _looks_like_data(row: list[Cell]) -> bool:
    return any(clean_reg(c["text"]) or _reg_from_links(c) for c in row)


def _pick_columns(header: list[Cell]) -> dict[str, int]:
    names = [c["text"].lower() for c in header]
    columns: dict[str, int] = {}
    for field, keywords in _COLUMN_KEYWORDS.items():
        for i, name in enumerate(names):
            if i not in columns.values() and any(k in name for k in keywords):
                columns[field] = i
                break
    return columns


def _clean_airline(airline: str, livery: str) -> str:
    if livery and livery != "Special livery" and livery.lower() in airline.lower():
        airline = re.sub(re.escape(livery), "", airline, flags=re.I)
    airline = airline.strip(" -–|:/()[]")
    return "" if len(airline) > _MAX_AIRLINE_CHARS else airline


def table_entries(table: Table) -> list[Entry]:
    """Livery entries from one parsed table, finding columns by their header text."""
    if not table:
        return []
    header_index = next((i for i, row in enumerate(table[:3]) if any(c["th"] for c in row)), None)
    if header_index is None:
        header_index = -1 if _looks_like_data(table[0]) else 0
    columns = _pick_columns(table[header_index]) if header_index >= 0 else {}

    entries = []
    for row in table[header_index + 1:]:
        def cell(field: str) -> str:
            i = columns.get(field)
            return row[i]["text"] if i is not None and i < len(row) else ""

        reg = clean_reg(cell("reg")) or next((r for r in map(_reg_from_links, row) if r), "")
        if not reg:
            continue
        livery = cell("livery")
        if not livery:
            used = {columns.get("reg"), columns.get("airline"), columns.get("type")}
            livery = " ".join(c["text"] for i, c in enumerate(row) if i not in used and clean_reg(c["text"]) != reg)
        livery = re.sub(r"#new\b", "", livery, flags=re.I).strip(" -–|") or "Special livery"
        entries.append({
            "reg": reg,
            "airline": _clean_airline(cell("airline"), livery),
            "type": cell("type"),
            "livery": livery[:_MAX_LIVERY_CHARS],
        })
    return entries


def parse_page(html: str) -> tuple[list[Entry], str]:
    """All livery entries on a page, and its 'Last Updated' date if it shows one."""
    parser = _TableParser()
    parser.feed(html)
    seen: set[str] = set()
    entries = []
    for table in parser.tables:
        for entry in table_entries(table):
            key = norm_reg(entry["reg"])
            if key not in seen:
                seen.add(key)
                entries.append(entry)
    match = _LAST_UPDATED.search(html)
    return entries, (match.group(1).replace("-", " ") if match else "")


# Fetching and importing

def source_id(url: str) -> str:
    host = urllib.parse.urlparse(url).hostname or "page"
    return "import:" + host.removeprefix("www.")


def fetch_page(url: str) -> tuple[list[Entry], str]:
    host = urllib.parse.urlparse(url).hostname
    request = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT, "Accept": "text/html", "Accept-Language": "en-US,en;q=0.9"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            html = response.read().decode(response.headers.get_content_charset() or "utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        raise LiveryWatchError(f"{host} returned an error ({e.code}).") from e
    except urllib.error.URLError as e:
        raise LiveryWatchError(f"Couldn't reach {host}. Check your connection.") from e
    entries, updated = parse_page(html)
    if not entries:
        raise LiveryWatchError(f"No tail numbers found at {url}. "
                               "The page may load its table with JavaScript, or its layout changed.")
    return entries, updated


def merge_import(data: dict[str, Any], source: str, entries: list[Entry], updated: str, url: str) -> None:
    """Replace one source's entries in the registry, keeping other import sources."""
    fresh = {norm_reg(e["reg"]) for e in entries}
    kept = [e for e in data["registry"]
            if str(e.get("source", "")).startswith("import:") and e["source"] != source
            and norm_reg(e["reg"]) not in fresh]
    data["registry"] = kept + [{**e, "source": source} for e in entries]
    data["imports"][source] = {"url": url, "count": len(entries), "at": int(time.time()), "updated": updated}


class LiveryImporter:
    """Refreshes the registry from its sources, in the background or inline."""

    def __init__(self, store: Store, sources: list[str]) -> None:
        self._store = store
        self._sources = sources
        self._lock = threading.Lock()
        self._status = {"state": "idle", "message": ""}

    @property
    def status(self) -> dict[str, str]:
        with self._lock:
            return dict(self._status)

    def start(self) -> None:
        with self._lock:
            if self._status["state"] == "running":
                return
            self._status = {"state": "running", "message": ""}
        threading.Thread(target=self._run, daemon=True).start()

    def run(self) -> None:
        with self._lock:
            self._status = {"state": "running", "message": ""}
        self._run()

    def _run(self) -> None:
        errors, imported = [], 0
        for url in self._sources:
            try:
                entries, updated = fetch_page(url)
            except LiveryWatchError as e:
                log.warning("Livery import failed: %s", e)
                errors.append(str(e))
                continue
            self._store.update(lambda data: merge_import(data, source_id(url), entries, updated, url))
            imported += len(entries)
            log.info("Imported %d liveries from %s", len(entries), url)
        if errors and not imported:
            status = {"state": "error", "message": f"{errors[0]} Using the livery list saved from last time."}
        elif errors:
            status = {"state": "ok", "message": "Some livery sources failed: " + " ".join(errors)}
        else:
            status = {"state": "ok", "message": ""}
        with self._lock:
            self._status = status
