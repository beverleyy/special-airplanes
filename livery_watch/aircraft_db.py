"""Registration to ICAO hex code lookups, from the public tar1090-db aircraft database (Mictronics data)."""
from __future__ import annotations

import gzip
import io
import logging
import urllib.error
import urllib.request

from .config import AIRCRAFT_DB_URL, USER_AGENT
from .util import norm_reg

log = logging.getLogger(__name__)


def parse_hex_codes(lines, wanted: set[str]) -> dict[str, str]:
    """Hex codes for the wanted registrations from "hex;registration;type;..." lines."""
    found: dict[str, str] = {}
    for line in lines:
        fields = line.split(";", 2)
        if len(fields) < 2:
            continue
        key = norm_reg(fields[1])
        if key in wanted and key not in found:
            found[key] = fields[0].strip().lower()
    return found


def hex_codes(registrations: list[str]) -> dict[str, str]:
    """Hex codes by normalized registration, or {} if the database can't be downloaded."""
    wanted = {norm_reg(r) for r in registrations if r}
    request = urllib.request.Request(AIRCRAFT_DB_URL, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            data = response.read()
    except (urllib.error.URLError, TimeoutError) as e:
        log.warning("Couldn't download the aircraft database (%s); exporting without hex codes.", e)
        return {}
    with gzip.open(io.BytesIO(data), "rt", encoding="utf-8", errors="replace") as text:
        found = parse_hex_codes(text, wanted)
    log.info("Found hex codes for %d of %d liveries", len(found), len(wanted))
    return found
