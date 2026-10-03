#!/usr/bin/env python3
"""Color terminal workload with tagged echoes and an interrupt acknowledgement."""
import argparse
import os
import re
import select
import signal
import sys
import termios
import time
import tty

parser = argparse.ArgumentParser()
parser.add_argument('--rate', type=int, default=100)
args = parser.parse_args()
old = termios.tcgetattr(sys.stdin)
running = True


def stop(_signal, _frame):
    global running
    running = False


signal.signal(signal.SIGINT, stop)
tty.setcbreak(sys.stdin.fileno())
print('\x1b[2J\x1b[HSIM READY', flush=True)
next_line = time.monotonic()
index = 0
pending = ''
try:
    while running:
        now = time.monotonic()
        timeout = max(0, next_line - now) if args.rate > 0 else .05
        if select.select([sys.stdin], [], [], min(timeout, .05))[0]:
            data = os.read(sys.stdin.fileno(), 4096)
            if not data:
                break
            pending += data.decode(errors='replace')
            for match in re.finditer(r'k([A-Za-z0-9_-]+)\.', pending):
                print(f'\r\nECHO {match[1]}', flush=True)
            pending = pending[pending.rfind('.') + 1:] if '.' in pending else pending[-4096:]
        now = time.monotonic()
        if args.rate > 0 and now >= next_line:
            text = f'agent step={index:08d} checking module={index % 37:02d} status=working progress={index % 100:02d} '
            print(f'\r\x1b[2K\x1b[3{index % 6 + 1}m{text:<99}\x1b[0m\n\x1b[36mspinner {"|/-+"[index % 4]}\x1b[0m', end='', flush=True)
            index += 1
            next_line = max(next_line + 1 / args.rate, now - .1)
finally:
    termios.tcsetattr(sys.stdin, termios.TCSADRAIN, old)
    print('\r\nSTOPPED', flush=True)
