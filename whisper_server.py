#!/usr/bin/env python3
"""Persistent Whisper transcription server.

Keeps the model loaded in memory so transcription is fast.
Listens on localhost:3012 for JSON requests with base64-encoded audio.

Usage:
    python3 whisper_server.py [--model base] [--port 3012]
"""

import argparse
import base64
import json
import os
import sys
import tempfile
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

import whisper

MODEL = None
MODEL_NAME = "base"


def load_model(name):
    global MODEL, MODEL_NAME
    MODEL_NAME = name
    print(f"[Whisper] Loading model '{name}'...", flush=True)
    t0 = time.time()
    MODEL = whisper.load_model(name)
    print(f"[Whisper] Model '{name}' loaded in {time.time()-t0:.1f}s", flush=True)


class WhisperHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Suppress default access logs
        pass

    def do_POST(self):
        if self.path == "/transcribe":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                data = json.loads(body)
                audio_b64 = data.get("audio", "")
                mime_type = data.get("mime_type", "audio/webm")

                if not audio_b64:
                    self._respond(400, {"error": "No audio data"})
                    return

                # Determine extension
                ext = ".webm"
                if "wav" in mime_type: ext = ".wav"
                elif "mp3" in mime_type: ext = ".mp3"
                elif "ogg" in mime_type: ext = ".ogg"
                elif "mp4" in mime_type: ext = ".mp4"
                elif "mpeg" in mime_type: ext = ".mp3"

                # Write to temp file
                audio_bytes = base64.b64decode(audio_b64)
                with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as f:
                    f.write(audio_bytes)
                    tmp_path = f.name

                size_kb = len(audio_bytes) / 1024
                print(f"[Whisper] Transcribing {size_kb:.1f}KB of {mime_type}...", flush=True)

                t0 = time.time()
                result = MODEL.transcribe(tmp_path, language="en")
                elapsed = time.time() - t0
                text = result.get("text", "").strip()

                # Clean up
                os.unlink(tmp_path)

                print(f"[Whisper] Done in {elapsed:.1f}s: \"{text[:80]}\"", flush=True)
                self._respond(200, {"text": text})

            except Exception as e:
                print(f"[Whisper] Error: {e}", flush=True)
                self._respond(500, {"error": str(e)})
        elif self.path == "/health":
            self._respond(200, {"status": "ok", "model": MODEL_NAME})
        else:
            self._respond(404, {"error": "Not found"})

    def do_GET(self):
        if self.path == "/health":
            self._respond(200, {"status": "ok", "model": MODEL_NAME})
        else:
            self._respond(404, {"error": "Not found"})

    def _respond(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="base", help="Whisper model name")
    parser.add_argument("--port", type=int, default=3012, help="Port to listen on")
    args = parser.parse_args()

    load_model(args.model)

    server = HTTPServer(("127.0.0.1", args.port), WhisperHandler)
    print(f"[Whisper] Server listening on http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[Whisper] Shutting down", flush=True)
        server.shutdown()


if __name__ == "__main__":
    main()
