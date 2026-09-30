"""HTTP server: the web app's static files plus a small JSON API."""
from __future__ import annotations

import json
import logging
import mimetypes
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

from .config import WEB_DIR
from .errors import LiveryWatchError
from .service import LiveryWatch

log = logging.getLogger(__name__)

STATIC_FILES = {"index.html"}
STATIC_DIRS = {"css", "js"}
MAX_BODY_BYTES = 64 * 1024

mimetypes.add_type("text/javascript", ".js")


class LiveryWatchServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], app: LiveryWatch, web_dir: Path = WEB_DIR) -> None:
        super().__init__(address, Handler)
        self.app = app
        self.web_dir = web_dir.resolve()


class Handler(BaseHTTPRequestHandler):
    server: LiveryWatchServer

    def log_message(self, fmt: str, *args: Any) -> None:
        log.debug("%s - %s", self.address_string(), fmt % args)

    # Routing

    def do_GET(self) -> None:
        url = urllib.parse.urlparse(self.path)
        query = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        app = self.server.app
        routes = {
            "/api/data": lambda: app.summary(),
            "/api/import-status": lambda: app.database_status(),
            "/api/flights": lambda: app.board(query.get("airport", ""), fresh=query.get("fresh") == "1"),
            "/api/live": lambda: app.live_positions(query.get("airport", ""),
                                                    [r for r in query.get("regs", "").split(",") if r]),
            "/api/tail": lambda: app.tail(query.get("reg", "")),
        }
        if url.path in routes:
            self._respond(routes[url.path])
        else:
            self._serve_static(url.path)

    def do_POST(self) -> None:
        url = urllib.parse.urlparse(self.path)
        try:
            body = self._read_json()
        except ValueError:
            return self._send_json({"error": "Bad request body."}, 400)
        routes = {
            "/api/prefs": lambda: self._save_prefs(body),
            "/api/import": self._start_import,
        }
        if url.path in routes:
            self._respond(routes[url.path])
        else:
            self._send_json({"error": "Not found."}, 404)

    def _save_prefs(self, body: dict[str, Any]) -> dict[str, bool]:
        self.server.app.store.save_prefs(body.get("types", []), body.get("direction", "both"))
        return {"ok": True}

    def _start_import(self) -> dict[str, Any]:
        self.server.app.importer.start()
        return self.server.app.database_status()

    # Responses

    def _respond(self, handler: Callable[[], Any]) -> None:
        try:
            self._send_json(handler())
        except LiveryWatchError as e:
            self._send_json({"error": str(e)}, 502)
        except Exception:
            log.exception("Request failed: %s", self.path)
            self._send_json({"error": "Something went wrong. Check the terminal running Livery Watch."}, 500)

    def _send_json(self, payload: Any, status: int = 200) -> None:
        self._send(json.dumps(payload).encode("utf-8"), "application/json", status)

    def _send(self, body: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        length = min(int(self.headers.get("Content-Length") or 0), MAX_BODY_BYTES)
        data = json.loads(self.rfile.read(length) or b"{}")
        if not isinstance(data, dict):
            raise ValueError("expected an object")
        return data

    def _serve_static(self, path: str) -> None:
        relative = "index.html" if path in ("", "/") else path.lstrip("/")
        parts = Path(relative).parts
        allowed = relative in STATIC_FILES or (len(parts) > 1 and parts[0] in STATIC_DIRS)
        target = (self.server.web_dir / relative).resolve()
        if not allowed or self.server.web_dir not in target.parents or not target.is_file():
            return self._send_json({"error": "Not found."}, 404)
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if content_type.startswith("text/"):
            content_type += "; charset=utf-8"
        self._send(target.read_bytes(), content_type)
