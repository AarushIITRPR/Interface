from __future__ import annotations

import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable


class PreviewServer:
    """Loopback-only MJPEG previews. Full-resolution recordings never leave disk."""

    def __init__(self, source: Callable[[str], bytes | None], secret: str, port: int = 8765):
        self.source = source
        self.secret = secret
        self.port = port
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        parent = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                parts = self.path.split("?")[0].strip("/").split("/")
                if len(parts) != 3 or parts[0] != "preview" or parts[2] != parent.secret or parts[1] not in ("face", "thermal"):
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                sensor_id = parts[1]
                try:
                    while parent._server is not None:
                        frame = parent.source(sensor_id)
                        if not frame:
                            time.sleep(0.15)
                            continue
                        self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n")
                        self.wfile.flush()
                        time.sleep(0.18)
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass

            def log_message(self, *_args):
                pass

        try:
            self._server = ThreadingHTTPServer(("127.0.0.1", self.port), Handler)
        except OSError:
            self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = int(self._server.server_address[1])
        self._thread = threading.Thread(target=self._server.serve_forever, name="meridian-preview", daemon=True)
        self._thread.start()

    def urls(self) -> dict[str,str]:
        return {sensor_id:f"http://127.0.0.1:{self.port}/preview/{sensor_id}/{self.secret}" for sensor_id in ("face","thermal")}

    def stop(self) -> None:
        server = self._server
        self._server = None
        if server:
            server.shutdown()
            server.server_close()
        if self._thread:
            self._thread.join(timeout=2)
