"""Small shared helpers."""
from __future__ import annotations

import math
import re
from datetime import datetime, timedelta, timezone
from typing import Any

_REG_SHAPE = re.compile(r"^[A-Z0-9]{1,3}-?[A-Z0-9]{2,6}$")
_NOT_REGS = {"REG", "REGISTRATION", "AIRLINE", "AIRCRAFT", "TYPE", "LIVERY", "NEW", "TBA", "TBC", "NA"}


def dig(obj: Any, *path: str) -> Any:
    """Follow nested dict keys, returning None as soon as one is missing."""
    for key in path:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(key)
    return obj


def norm_reg(reg: str | None) -> str:
    """Registration without punctuation, for comparisons: 'JA-894A' -> 'JA894A'."""
    return re.sub(r"[^A-Z0-9]", "", (reg or "").upper())


def clean_reg(text: str | None) -> str:
    """A tidy registration if the text looks like one, else ''."""
    reg = re.sub(r"[^A-Z0-9-]", "", (text or "").strip().upper())
    if not _REG_SHAPE.match(reg) or reg.replace("-", "") in _NOT_REGS:
        return ""
    return reg if ("-" in reg or any(c.isdigit() for c in reg)) else ""


def local_iso(ts: int | None, offset_seconds: int) -> str:
    """Unix time as 'YYYY-MM-DDTHH:MM' in a fixed UTC offset."""
    if not ts:
        return ""
    moment = datetime.fromtimestamp(ts, timezone.utc) + timedelta(seconds=offset_seconds or 0)
    return moment.strftime("%Y-%m-%dT%H:%M")


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    rad = math.radians
    a = (math.sin(rad(lat2 - lat1) / 2) ** 2
         + math.cos(rad(lat1)) * math.cos(rad(lat2)) * math.sin(rad(lon2 - lon1) / 2) ** 2)
    return 6371 * 2 * math.asin(math.sqrt(a))
