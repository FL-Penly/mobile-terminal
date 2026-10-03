#!/usr/bin/env python3
import json
import os
import pathlib
import socket
import shlex
import subprocess
import time
import urllib.request

state = pathlib.Path(os.environ.get('MT_WEAKNET_STATE', pathlib.Path.home() / '.local/share/mt-weaknet'))
root = pathlib.Path(os.environ.get('MT_WEAKNET_ROOT', pathlib.Path.home() / 'project/mobile-terminal-weaknet')).resolve()
baseline = pathlib.Path(os.environ.get('MT_BASELINE_ROOT', root.parent / 'mobile-terminal-baseline')).resolve()
state.mkdir(parents=True, exist_ok=True)
(state / 'logs').mkdir(exist_ok=True)
manifest_path = state / 'bench-state.json'
if manifest_path.exists():
    previous = json.loads(manifest_path.read_text())
    live = [p for p in previous.get('processes', []) if pathlib.Path(f'/proc/{p["pid"]}').exists()]
    if live:
        raise SystemExit(f'Test bench already running: {live}')
for port in [7701, 7702, 7703, 7704, 7711, 7712, 7713, 7714, 8474]:
    with socket.socket() as sock:
        try:
            sock.bind(('127.0.0.1', port))
        except OSError:
            raise SystemExit(f'Port {port} occupied; refusing to replace an unknown process')
manifest = {'root': str(root), 'baseline': str(baseline), 'processes': [], 'panes': {}}

def save():
    manifest_path.write_text(json.dumps(manifest, indent=2))


def start(command, name, env=None):
    with open(state / 'logs' / f'{name}.log', 'ab') as log:
        proc = subprocess.Popen(command, env=env, stdout=log, stderr=log, start_new_session=True)
    manifest['processes'].append({'pid': proc.pid, 'command': command, 'name': name,
                                  'start_ticks': pathlib.Path(f'/proc/{proc.pid}/stat').read_text().split()[21]})
    save()
    return proc

sessions = json.loads(subprocess.check_output(['herdr', 'session', 'list', '--json']))['sessions']
bench = next((s for s in sessions if s['name'] == 'mtbench'), None)
if not bench or not bench['running']:
    start(['herdr', '--session', 'mtbench', 'server'], 'herdr-mtbench')
    time.sleep(.5)
wrapper = state / 'herdr-mtbench'
wrapper.write_text('#!/bin/sh\nexec herdr --session mtbench "$@"\n')
wrapper.chmod(0o755)
old_panes = json.loads((state / 'panes.json').read_text()) if bench and bench['running'] and (state / 'panes.json').exists() else {}
for port in range(7701, 7706):
    if str(port) in old_panes:
        pane = old_panes[str(port)]['result']['root_pane']['pane_id']
    else:
        data = json.loads(subprocess.check_output(['herdr', '--session', 'mtbench', 'workspace', 'create', '--cwd', str(root), '--label', f'mtbench-{port}', '--no-focus']))
        pane = data['result']['root_pane']['pane_id']
        old_panes[str(port)] = data
    manifest['panes'][str(port)] = pane
(state / 'panes.json').write_text(json.dumps(old_panes, indent=2))
save()
env = dict(os.environ, HERDR_BIN_PATH=str(wrapper), HERDR_SOCKET_PATH=str(pathlib.Path.home() / '.config/herdr/sessions/mtbench/herdr.sock'), RUST_TERMINAL_TMUX_SOCKET='mtbench')
for port, server, page in [(7701, baseline, baseline), (7702, root, root), (7703, root, baseline), (7704, baseline, root)]:
    start([str(server / 'server/target/release/rust-terminal'), '--port', str(port), '--shell', 'zsh', '--static-dir', str(page / 'frontend/dist')], f'bench-{port}', env)
start([str(state / 'bin/toxiproxy-server-linux-amd64'), '-host', '127.0.0.1'], 'toxiproxy')
for port in [7701, 7702, 7703, 7704, 8474]:
    for attempt in range(50):
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{port}/' + ('version' if port == 8474 else 'api/health'), timeout=3)
            break
        except OSError:
            time.sleep(.1)
    else:
        raise SystemExit(f'{port} did not become ready; inspect logs and teardown')
for port in range(7701, 7705):
    body = json.dumps({'name': f'mt{port}', 'listen': f'127.0.0.1:{port + 10}', 'upstream': f'127.0.0.1:{port}'}).encode()
    request = urllib.request.Request('http://127.0.0.1:8474/proxies', data=body, headers={'Content-Type': 'application/json'})
    urllib.request.urlopen(request, timeout=3).read()
simulator = pathlib.Path(__file__).resolve().parent / 'agent-sim.py'
for port in range(7701, 7705):
    pane = manifest['panes'][str(port)]
    subprocess.run(['herdr', '--session', 'mtbench', 'pane', 'send-keys', pane, 'ctrl+c'], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['herdr', '--session', 'mtbench', 'pane', 'run', pane, f'python3 {shlex.quote(str(simulator))} --rate 0'], check=True, stdout=subprocess.DEVNULL)
print(json.dumps(manifest, indent=2))
