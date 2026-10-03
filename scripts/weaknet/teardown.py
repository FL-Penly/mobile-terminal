#!/usr/bin/env python3
"""Stop only this harness's processes and explicitly named test sessions."""
import json
import os
import pathlib
import signal
import subprocess
import time

state = pathlib.Path(os.environ.get('MT_WEAKNET_STATE', pathlib.Path.home() / '.local/share/mt-weaknet'))
lock_path = state / 'bench.lock'
if lock_path.exists():
    owner = json.loads(lock_path.read_text())
    stat = pathlib.Path(f'/proc/{owner["pid"]}/stat')
    if stat.exists() and stat.read_text().split()[21] == owner['start_ticks']:
        raise SystemExit(f'Bench runner {owner["pid"]} is still alive; stop it before teardown')
    lock_path.unlink()
manifest_path = state / 'bench-state.json'
if manifest_path.exists():
    manifest = json.loads(manifest_path.read_text())
    for process in reversed(manifest.get('processes', [])):
        proc = pathlib.Path(f'/proc/{process["pid"]}')
        try:
            if proc.joinpath('stat').read_text().split()[21] != process['start_ticks']:
                continue
            command = proc.joinpath('cmdline').read_bytes().split(b'\0')
            if [part.decode() for part in command if part] != process['command']:
                continue
            os.kill(process['pid'], signal.SIGTERM)
        except (FileNotFoundError, ProcessLookupError):
            pass
    time.sleep(.3)
    manifest_path.unlink()
subprocess.run(['herdr', 'session', 'stop', 'mtbench'], check=False)
subprocess.run(['herdr', 'session', 'delete', 'mtbench'], check=False)
subprocess.run(['tmux', '-L', 'mtbench', 'kill-server'], check=False)
(state / 'panes.json').unlink(missing_ok=True)
