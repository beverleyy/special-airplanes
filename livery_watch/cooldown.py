"""A shared pause for all Flightradar24 requests after it asks us to slow down or refuses us."""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Callable

from . import config
from .errors import FR24PausedError

log = logging.getLogger(__name__)


def retry_after_seconds(value: str | None, now: float) -> float | None:
    """A Retry-After header as seconds from now: either a number of seconds or an HTTP date."""
    if not value:
        return None
    value = value.strip()
    if value.isdigit():
        return float(value)
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max(0.0, when.timestamp() - now)


class Cooldown:
    """Rate limits pause every request until the time Flightradar24 gave. Refusals pause for longer
    each time they repeat, until a request succeeds. Saved to disk so a restart doesn't skip it."""

    def __init__(self, path: Path | None = None, clock: Callable[[], float] = time.time) -> None:
        self._path = path
        self._clock = clock
        self._lock = threading.Lock()
        self._until = 0.0
        self._reason = ""
        self._refusals = 0
        self._load()

    def check(self) -> None:
        """Raise FR24PausedError while a pause is in effect."""
        with self._lock:
            if self._clock() < self._until:
                raise FR24PausedError(self._reason, self._until)

    def rate_limited(self, retry_after: float | None) -> FR24PausedError:
        wait = retry_after if retry_after is not None else config.RATE_LIMIT_PAUSE_SECONDS
        return self._pause(wait, "Flightradar24 asked Livery Watch to slow down")

    def refused(self) -> FR24PausedError:
        with self._lock:
            self._refusals += 1
            pauses = config.REFUSAL_PAUSE_SECONDS
            wait = pauses[min(self._refusals, len(pauses)) - 1]
        return self._pause(wait, "Flightradar24 is refusing requests right now")

    def succeeded(self) -> None:
        with self._lock:
            if not self._refusals and not self._until:
                return
            self._refusals = 0
            self._until = 0.0
            self._reason = ""
        self._save()

    @property
    def status(self) -> dict:
        with self._lock:
            paused = self._clock() < self._until
            return {"paused": paused, "until": self._until if paused else 0, "reason": self._reason if paused else ""}

    def _pause(self, seconds: float, reason: str) -> FR24PausedError:
        with self._lock:
            self._until = max(self._until, self._clock() + seconds)
            self._reason = reason
            until = self._until
        log.warning("%s; pausing Flightradar24 requests until %s.", reason,
                    datetime.fromtimestamp(until).strftime("%H:%M:%S"))
        self._save()
        return FR24PausedError(reason, until)

    def _load(self) -> None:
        if not self._path or not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            self._until = float(data.get("until", 0))
            self._reason = str(data.get("reason", ""))
            self._refusals = int(data.get("refusals", 0))
        except (OSError, ValueError, TypeError):
            pass

    def _save(self) -> None:
        if not self._path:
            return
        with self._lock:
            data = {"until": self._until, "reason": self._reason, "refusals": self._refusals}
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(json.dumps(data), encoding="utf-8")
        except OSError as e:
            log.warning("Couldn't save the Flightradar24 pause: %s", e)
