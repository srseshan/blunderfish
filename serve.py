#!/usr/bin/env python3
"""Local static server for chess-analyzer.

Needed because the app loads a Web Worker + WASM file, both of which
browsers block under a file:// origin. Run this and open the printed
localhost URL instead of double-clicking index.html.
"""

import http.server
import socketserver
import sys
import webbrowser
from pathlib import Path

PORT = 8420


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # .wasm needs the right content-type or some browsers refuse to
        # instantiate it via fetch()/WebAssembly.instantiateStreaming.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def guess_type(self, path):
        if path.endswith(".wasm"):
            return "application/wasm"
        return super().guess_type(path)


def main():
    root = Path(__file__).parent
    import os

    os.chdir(root)

    port = PORT
    if len(sys.argv) > 1:
        port = int(sys.argv[1])

    with socketserver.TCPServer(("127.0.0.1", port), Handler) as httpd:
        url = f"http://127.0.0.1:{port}/"
        print(f"Serving chess-analyzer at {url}")
        print("Press Ctrl+C to stop.")
        try:
            webbrowser.open(url)
        except Exception:
            pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
