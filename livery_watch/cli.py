"""Command line entry point."""
from __future__ import annotations

import argparse
import logging
import threading
import webbrowser
from pathlib import Path

from . import config
from .errors import LiveryWatchError
from .liveries import LiveryImporter
from .server import LiveryWatchServer
from .service import LiveryWatch
from .snapshot import record
from .store import Store

log = logging.getLogger("livery_watch")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python3 -m livery_watch",
                                     description="Special-livery aircraft at an airport in the next 24 hours.")
    parser.add_argument("--host", default=config.DEFAULT_HOST,
                        help="address to listen on; use 0.0.0.0 for other devices on your network")
    parser.add_argument("--port", type=int, default=config.DEFAULT_PORT)
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser window")
    parser.add_argument("--source", action="append", default=[], metavar="URL",
                        help="extra page with a livery table (repeatable)")
    parser.add_argument("--snapshot", metavar="IATA", help="record demo-data.json for this airport, then exit")
    parser.add_argument("--out", type=Path, default=config.DEMO_FILE, help="where --snapshot writes")
    parser.add_argument("--verbose", action="store_true", help="log every request")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(message)s")

    store = Store(config.DATA_FILE)
    importer = LiveryImporter(store, [config.LIVERY_SOURCE, *args.source])
    app = LiveryWatch(store, importer)

    if args.snapshot:
        try:
            record(app, args.snapshot, args.out)
        except LiveryWatchError as e:
            log.error(str(e))
            return 1
        return 0

    importer.start()
    server = LiveryWatchServer((args.host, args.port), app)
    url = f"http://localhost:{args.port}"
    log.info("Livery Watch running at %s  (Ctrl+C to stop)", url)
    log.info("Livery data: Special Liveries Database by AirportWebcams.net, %s", config.LIVERY_SOURCE)
    if not args.no_browser:
        threading.Timer(0.6, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Stopped.")
    finally:
        server.server_close()
    return 0
