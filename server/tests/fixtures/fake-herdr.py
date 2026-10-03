#!/usr/bin/env python3
"""Deterministic NDJSON terminal controller used by real WebSocket tests."""
import base64
import json
import os
import random
import sys
import threading
import time

sequence = 0
full_count = 1


def frame(payload, full):
    global sequence
    sequence += 1
    value = {"type": "terminal.frame", "seq": sequence, "encoding": "ansi",
             "width": 80, "height": 24, "bytes": base64.b64encode(payload).decode()}
    if os.getenv("FAKE_HERDR_NO_FULL") != "1":
        value["full"] = full
    print(json.dumps(value), flush=True)


def takeover():
    time.sleep(1)
    print(json.dumps({"type": "terminal.closed", "reason": "terminal attach taken over"}), flush=True)
    os._exit(0)


frame(b"FULL-1", True)
if os.getenv("FAKE_HERDR_TAKEOVER") == "1":
    threading.Thread(target=takeover, daemon=True).start()
for line in sys.stdin:
    command = json.loads(line)
    if command["type"] == "terminal.input":
        data = base64.b64decode(command["bytes"])
        if data == b"FLOOD":
            for index in range(200):
                frame(f"FLOOD-{index:03d}:".encode() + b"x" * 1014, False)
        elif data == b"FLOOD_RANDOM":
            generator = random.Random(42)
            for index in range(200):
                frame(f"RANDOM-{index:03d}:".encode() + generator.randbytes(1024), False)
        else:
            frame(b"ECHO:" + data, False)
    elif command["type"] == "terminal.resize":
        full_count += 1
        frame(f"FULL-{full_count} SIZE:{command['cols']}x{command['rows']}".encode(), True)
    elif command["type"] == "terminal.release":
        break
