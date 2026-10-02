"""Record one moment at an airport for the static demo."""
from __future__ import annotations

import json
import logging
from pathlib import Path

from . import config
from .errors import LiveryWatchError
from .service import LiveryWatch
from .util import norm_reg

log = logging.getLogger(__name__)

ACTIVE_BEFORE_SECONDS = 50 * 60
ACTIVE_AFTER_SECONDS = 25 * 60
DEPARTED_ACTIVE_SECONDS = 45 * 60


def record(app: LiveryWatch, code: str, path: Path) -> dict:
    """Save only what the demo shows: special-livery flights, their registry entries,
    board totals, live positions, and those aircraft's schedules."""
    log.info("Updating the livery database…")
    app.importer.run()
    status = app.importer.status
    if status["message"]:
        log.warning(status["message"])
    registry = app.registry_map()
    if not registry:
        raise LiveryWatchError("The livery list is empty, so there's nothing to record.")

    log.info("Reading the %s arrivals and departures boards…", code.upper())
    board = app.board_complete(code, fresh=True)
    now = board["fetchedAt"]
    special = [f for f in board["flights"] if f["reg"] and norm_reg(f["reg"]) in registry]
    regs = sorted({f["reg"] for f in special})

    active = sorted({f["reg"] for f in special
                     if -ACTIVE_BEFORE_SECONDS <= f["ts"] - now <= ACTIVE_AFTER_SECONDS
                     or (f["dir"] == "dep" and f["actual"] and now - f["ts"] <= DEPARTED_ACTIVE_SECONDS)})
    log.info("Checking live positions for %d aircraft…", len(active))
    live = app.live_positions(code, active) if active else {}

    log.info("Recording schedules for %d aircraft…", min(len(regs), config.MAX_SNAPSHOT_TAILS))
    tails = {}
    for reg in regs[:config.MAX_SNAPSHOT_TAILS]:
        try:
            tails[reg] = app.tail_schedule(reg)
        except LiveryWatchError as e:
            log.warning("%s: %s", reg, e)

    snapshot = {
        "recordedAt": now,
        "board": {**board, "flights": special},
        "live": live,
        "tails": tails,
        "registry": [{k: registry[norm_reg(r)].get(k, "") for k in ("reg", "airline", "type", "livery")}
                     for r in regs],
    }
    path.write_text(json.dumps(snapshot, indent=1, ensure_ascii=False), encoding="utf-8")
    log.info("Saved %s: %d special-livery flights, %d aircraft, %d live positions.",
             path, len(special), len(regs), len(live))
    if not special:
        log.warning("No special liveries were due, so the demo would be empty. Try again at another time.")
    return snapshot
