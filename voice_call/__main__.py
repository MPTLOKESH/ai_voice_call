"""python -m voice_call        opens the browser UI
   python -m voice_call --port 8080 --no-browser
"""
from __future__ import annotations

import argparse

from .server import serve

parser = argparse.ArgumentParser(prog="voice_call", description="Set up and test a voice assistant in the browser.")
parser.add_argument("--port", type=int, default=8000)
parser.add_argument("--no-browser", action="store_true", help="don't open a browser window")
args = parser.parse_args()

serve(port=args.port, open_browser=not args.no_browser)
