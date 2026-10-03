#!/usr/bin/env python3
"""Print received terminal bytes for UI regression checks; Ctrl-C exits."""
import os
import sys
import termios
import tty

saved = termios.tcgetattr(sys.stdin)
try:
    tty.setraw(sys.stdin.fileno())
    print('\x1b[2J\x1b[HRECORDER READY\r', flush=True)
    while True:
        data = os.read(sys.stdin.fileno(), 4096)
        if not data or b'\x03' in data:
            break
        print('\r\nKEYHEX ' + data.hex() + '\r', flush=True)
finally:
    termios.tcsetattr(sys.stdin, termios.TCSADRAIN, saved)
    print('\r\nRECORDER STOPPED', flush=True)
