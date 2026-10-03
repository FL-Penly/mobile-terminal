#!/usr/bin/env python3
"""Calibrate S2u on 7701/P0: coarse grid, refinement, independent confirmation."""
import datetime
import json
import os
import pathlib
import subprocess

here = pathlib.Path(__file__).resolve().parent
state = pathlib.Path(os.environ.get('MT_WEAKNET_STATE', pathlib.Path.home() / '.local/share/mt-weaknet'))
logs = state / 'logs'
output = logs / 'directive-c-calibration.json'
rates_output = logs / 'directive-c-rates.json'
if output.exists() or rates_output.exists():
    raise SystemExit('Calibration output already exists; refusing to overwrite measurements')
grid = [100, 80, 60, 50, 40, 30, 25, 20, 15, 12, 10, 8, 6, 5, 4, 3, 2, 1]
limits = {'P1': 89600, 'P2': 22400}
result = {'started': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'authority': 'ANSWERS.md Q1', 'grid': grid, 'limits_bps': limits,
          'measurements': [], 'selected': {}, 'failures': []}


def save():
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2))


def measure(rate, phase, sample_ms=10000):
    name = f'directive-c-cal-{len(result["measurements"]) + 1:02d}-{phase}-{rate}'
    raw = logs / (name + '.json')
    if raw.exists():
        raise RuntimeError(f'Refusing to overwrite {raw}')
    command = ['node', str(here / 'bench.mjs'), '--ports=7701', '--profiles=P0',
               '--scenes=CAL', f'--rate={rate}', f'--sample-ms={sample_ms}', '--output=' + str(raw)]
    print(json.dumps({'starting': name}), flush=True)
    with (logs / (name + '.log')).open('w') as log:
        completed = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
    if completed.returncode:
        raise RuntimeError(f'Calibration failed: {raw}, exit {completed.returncode}')
    case = json.loads(raw.read_text())['cases'][0]
    if 'error' in case or case['rate'] != rate or case['measured_ms'] < sample_ms:
        raise RuntimeError(f'Invalid calibration sample: {raw}')
    record = {key: case[key] for key in ['rate', 'measured_ms', 'ws_down_bytes', 'bytes_per_second']}
    record.update(phase=phase, source=raw.name)
    result['measurements'].append(record)
    save()
    print(json.dumps(record), flush=True)
    return record


save()
try:
    coarse = [measure(rate, 'coarse') for rate in grid]
    for profile, limit in limits.items():
        eligible = [record['rate'] for record in coarse if record['bytes_per_second'] <= limit]
        if not eligible:
            result['failures'].append({'profile': profile, 'reason': 'No positive grid rate meets the limit'})
            save()
            continue
        selected = max(eligible)
        upper = min((rate for rate in grid if rate > selected), default=selected)
        for rate in range(selected + 1, upper):
            record = measure(rate, 'refine-' + profile)
            if record['bytes_per_second'] > limit:
                break
            selected = rate
        while selected >= 1:
            record = measure(selected, 'confirm-' + profile, 20000)
            if record['bytes_per_second'] <= limit:
                result['selected'][profile] = record
                save()
                break
            selected -= 1
        else:
            result['failures'].append({'profile': profile, 'reason': 'Rate 1 failed independent confirmation'})
            save()
    if result['failures']:
        raise RuntimeError('Calibration incomplete; see recorded failures, do not use rate 0')
    rates_output.write_text(json.dumps({profile: record['rate'] for profile, record in result['selected'].items()}, indent=2))
finally:
    result['finished'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save()
print(json.dumps({'selected': result['selected'], 'rates_file': str(rates_output)}), flush=True)
