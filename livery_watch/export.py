"""Export the livery list for the Cloudflare Worker's private storage."""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path

from . import config
from .aircraft_db import hex_codes
from .errors import LiveryWatchError
from .liveries import LiveryImporter, source_id
from .store import Store
from .util import norm_reg

log = logging.getLogger(__name__)
FIELDS = ("reg", "airline", "type", "livery")


def export_registry(store: Store, importer: LiveryImporter, path: Path) -> int:
    """Refresh the list, add each tail's hex code, then write { updated, importedAt, entries } to path.
    Fails rather than writing an empty list, so a broken import never wipes the Worker's copy."""
    importer.run()
    status = importer.status
    if status["state"] == "error":
        raise LiveryWatchError(status["message"])
    data = store.read()
    entries = [{k: e.get(k, "") for k in FIELDS} for e in data["registry"]]
    if not entries:
        raise LiveryWatchError("The livery list is empty, so there's nothing to export.")
    codes = hex_codes([e["reg"] for e in entries])
    for entry in entries:
        code = codes.get(norm_reg(entry["reg"]))
        if code:
            entry["hex"] = code
    source = data["imports"].get(source_id(config.LIVERY_SOURCE), {})
    payload = {"updated": source.get("updated", ""), "importedAt": int(time.time()), "entries": entries}
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log.info("Exported %d liveries to %s", len(entries), path)
    return len(entries)
