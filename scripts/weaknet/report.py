#!/usr/bin/env python3
"""Render raw weak-network runs without converting censored timings into passes."""
import argparse
import json
import pathlib
import statistics

parser = argparse.ArgumentParser()
parser.add_argument('runs', nargs='+', type=pathlib.Path)
parser.add_argument('--output', required=True, type=pathlib.Path)
parser.add_argument('--exclude', type=pathlib.Path)
parser.add_argument('--s2u-compat', action='store_true', help='Use authorized S2u for mixed-version P1/P2 gates')
args = parser.parse_args()
excluded = json.loads(args.exclude.read_text()) if args.exclude else []
cases = {}
errors = []
for source in args.runs:
    data = json.loads(source.read_text())
    for case in data['cases']:
        key = (case['port'], case['profile'], case['scene'])
        if any(item['file'] == source.name and tuple(item['case']) == key for item in excluded):
            continue
        if 'error' in case:
            errors.append((source.name, key, case['error'].splitlines()[0]))
            continue
        # --resume carries prior completed records; do not count those twice as reruns.
        signature = json.dumps(case, sort_keys=True)
        bucket = cases.setdefault(key, [])
        if not any(previous[2] == signature for previous in bucket):
            bucket.append((source.name, case, signature))


def median_case(port, profile, scene):
    attempts = cases.get((port, profile, scene), [])
    if not attempts:
        return None
    if len(attempts) > 3:
        raise SystemExit(f'More than three valid attempts for {(port, profile, scene)}; explicitly audit input sources')
    result = dict(attempts[0][1])
    if len(attempts) > 1:
        for key in ['p50', 'p95', 'max', 'ms', 'recovery_ms', 'ws_down_bytes', 'busy_bytes', 'idle_bytes', 'detection_ms']:
            values = [case.get(key) for _, case, _ in attempts]
            if all(isinstance(value, (int, float)) for value in values):
                result[key] = statistics.median(values)
        # A censored retry is not silently erased by a successful sample.
        result['timeout'] = any(case.get('timeout', False) for _, case, _ in attempts)
        result['timeouts'] = max(case.get('timeouts', 0) for _, case, _ in attempts)
        if any(case.get('detection_ms') is None for _, case, _ in attempts):
            result['detection_ms'] = None
    result['sources'] = [source for source, _, _ in attempts]
    return result


def value(case, metric):
    if case is None:
        return None
    if metric == 'detection_ms' and case.get(metric) is None:
        return 40000
    current = case
    for key in metric.split('.'):
        current = current.get(key) if isinstance(current, dict) else None
    return current


def censored(case, metric):
    if not case:
        return False
    if metric == 'detection_ms':
        return case.get(metric) is None
    if metric in ('p95', 'max'):
        samples = case.get('samples', [])
        timeouts = max(case.get('timeouts', 0), sum(bool(sample.get('timeout')) for sample in samples))
        # With 20 samples nearest-rank p95 is censored once at least 2 time out.
        return timeouts >= (2 if metric == 'p95' and len(samples) == 20 else 1) or bool(case.get('timeout'))
    return metric in ('ms', 'recovery_ms') and bool(case.get('timeout'))


def fmt(number, lower=False):
    if number is None:
        return '缺失'
    return ('≥' if lower else '') + (f'{number:,.1f}' if isinstance(number, float) and not number.is_integer() else f'{int(number):,}')


lines = ['# 弱网端到端对比报告', '', '原始数据由真实 Chrome、herdr 和 toxiproxy 采集。所有计时单位为 ms，字节为消息正文及其协议前缀；超时是下界，不等于实测完成时间。', '']
gates = []


def table(scene, rows):
    lines.extend([f'## {scene}', '', '| 档位/指标 | 基线 | 候选 | 阈值 | 结论 |', '|---|---:|---:|---|---|'])
    for profile, label, metric, absolute, relative, additive in rows:
        base = median_case(7701, profile, scene)
        new = median_case(7702, profile, scene)
        old_value, new_value = value(base, metric), value(new, metric)
        limits = []
        if absolute is not None:
            limits.append(absolute)
        if relative is not None and old_value is not None:
            limits.append(old_value * relative + additive)
        threshold = []
        if absolute is not None:
            threshold.append(f'≤{absolute:g}')
        if relative is not None:
            threshold.append(f'≤基线×{relative:g}+{additive:g}')
        if new_value is None or (relative is not None and old_value is None):
            status = '未验证'
        elif censored(new, metric):
            status = '未达标（候选超时下界已超绝对阈值）' if absolute is not None and new_value > absolute else '未验证（候选超时下界）'
        elif limits and all(new_value <= limit for limit in limits):
            # Comparing a finite candidate with a censored baseline lower bound is sound.
            status = '通过'
        elif censored(base, metric) and absolute is None:
            status = '未验证（基线超时下界）'
        else:
            status = '未达标'
        if scene == 'S1' and metric == 'warm.transfer_bytes' and new and 304 not in new.get('http_statuses', []):
            status = '未验证（未捕获304）'
        gates.append({'scene': scene, 'profile': profile, 'label': label, 'status': status,
                      'baseline': old_value, 'candidate': new_value, 'limits': limits})
        lines.append(f'| {profile} {label} | {fmt(old_value,censored(base,metric))} | {fmt(new_value,censored(new,metric))} | {" 且 ".join(threshold)} | {status} |')
    lines.append('')


table('S1', [(p, label, metric, absolute, relative, 0) for p in ['P0','P1','P2'] for label,metric,absolute,relative in [('冷加载字节','cold.encoded_bytes',None,.3),('刷新传输字节','warm.transfer_bytes',5000,None)]])
table('S2', [(p,'回显 p95','p95',2500 if p=='P2' else None,None if p=='P2' else 1.1,0 if p=='P2' else 50) for p in ['P0','P1','P2']])
table('S3', [(p,'Ctrl-C max','max',2500 if p=='P2' else None,None if p=='P2' else 1.1,0 if p=='P2' else 50) for p in ['P0','P1','P2']])
table('S4', [(p,label,metric,absolute,1,0) for p in ['P0','P1','P2'] for label,metric,absolute in [('恢复回显','ms',{'P0':None,'P1':2000,'P2':3000}[p]),('恢复下行字节','ws_down_bytes',32768)]])
table('S5a', [(p,'发现断流','detection_ms',20000,None,0) for p in ['P0','P1','P2']] + [(p,'静止恢复','recovery_ms',None,1,3000 if p=='P1' else 5000) for p in ['P1','P2']])
table('S5b', [(p,'发现断流','detection_ms',20000,None,0) for p in ['P0','P1','P2']] + [(p,'刷屏恢复','recovery_ms',{'P0':None,'P1':8000,'P2':12000}[p],1,0) for p in ['P0','P1','P2']])
table('S5c', [(p,'reset_peer 恢复','recovery_ms',None,1,0) for p in ['P0','P1','P2']])
table('S7', [('P0','刷屏60s字节','busy_bytes',None,.25,0),('P0','静止60s字节','idle_bytes',None,1,2048)])
lines.extend(['## 兼容矩阵', '', '| 组合/档位/指标 | 基线 | 混合版本 | 阈值 | 结论 |','|---|---:|---:|---|---|'])
for port in [7703,7704]:
    for profile in ['P0','P1','P2']:
        for scene in (['S2','S4'] if port==7703 else ['S2']):
            if args.s2u_compat and scene=='S2' and profile in ['P1','P2']:
                scene='S2u'
            metric='p95' if scene in ['S2','S2u'] else 'ms'
            base=median_case(7701,profile,scene);other=median_case(port,profile,scene)
            old_value=value(base,metric);new_value=value(other,metric)
            if old_value is None or new_value is None or censored(other,metric):status='未验证'
            elif new_value<=old_value*1.1+50:status='通过'
            elif censored(base,metric):status='未验证'
            else:status='未达标'
            if scene=='S2u' and (not base or not other or not base.get('rate') or base.get('rate')!=other.get('rate')):
                status='未验证（S2u速率缺失或不一致）'
            gates.append({'scene':scene,'port':port,'profile':profile,'label':'兼容延迟','status':status,
                          'baseline':old_value,'candidate':new_value,
                          'limits':[] if old_value is None else [old_value*1.1+50]})
            lines.append(f'| {port}/{profile}/{scene} | {fmt(old_value,censored(base,metric))} | {fmt(new_value,censored(other,metric))} | ≤基线×1.1+50 | {status} |')
lines.extend(['', '兼容连接/输入/重连还需结合每场景的 opens、控制帧、原始输出前缀和功能回归记录逐项审核。'])
if args.s2u_compat:
    lines.extend(['', '### 原饱和 S2（保留，不用于替代后的兼容门槛）', '',
                  '按 DIRECTIVE C，P1/P2 四格改用已校准非饱和 S2u 判定；原始 S2 超时不是通过。', '',
                  '| 组合/档位 | 基线超时/20 | 混合版本超时/20 | 原结论 |', '|---|---:|---:|---|'])
    for port in [7703,7704]:
        for profile in ['P1','P2']:
            base=median_case(7701,profile,'S2');other=median_case(port,profile,'S2')
            status='不可判定：基线自身超时截断' if censored(base,'p95') else '见原始 S2 数据'
            lines.append(f'| {port}/{profile} | {fmt(value(base,"timeouts"))} | {fmt(value(other,"timeouts"))} | {status} |')
if any(key[2].endswith('-buffered') for key in cases):
    lines.extend(['', '## 保留 TCP 积压的补充场景', '',
                  '更新 latency 暂停并恢复，保留流内数据；这是补充证据，不替代 timeout 场景或其未达标结论。', '',
                  '| 场景/档位 | 基线恢复 ms | 候选恢复 ms | 基线下行 bytes | 候选下行 bytes | 基线/候选连接数 |',
                  '|---|---:|---:|---:|---:|---|'])
    for scene in ['S4-buffered', 'S5a-buffered', 'S5b-buffered']:
        for profile in ['P1', 'P2']:
            base = median_case(7701, profile, scene)
            new = median_case(7702, profile, scene)
            metric = 'ms' if scene.startswith('S4') else 'recovery_ms'
            old_value, new_value = value(base, metric), value(new, metric)
            opens = [str(case.get('traffic', {}).get('opens', '缺失')) if case else '缺失' for case in [base, new]]
            lines.append(f'| {scene}/{profile} | {fmt(old_value, censored(base, metric))} | {fmt(new_value, censored(new, metric))} | {fmt(value(base, "ws_down_bytes"))} | {fmt(value(new, "ws_down_bytes"))} | {" / ".join(opens)} |')

lines.extend(['', '## 数据完整性', ''])
expected={(port,profile,scene) for port in [7701,7702,7703,7704] for profile in ['P0','P1','P2'] for scene in ['S1','S2','S3','S4','S5a','S5b','S5c','S7'] if scene!='S7' or profile=='P0'}
missing=sorted(expected-set(cases))
lines.append(f'- 有效场景：{len(expected & set(cases))}/{len(expected)}。')
lines.append(f'- 缺失场景：{missing or "无"}。')
lines.append(f'- 门槛通过：{sum(gate["status"]=="通过" for gate in gates)}/{len(gates)}；任何未验证项不能认定达标。')
lines.extend(['', '### 排除记录', '', '```json', json.dumps(excluded,ensure_ascii=False,indent=2), '```', '', '### 测试台异常记录', ''])
for source,key,error in errors:
    lines.append(f'- `{source}` {key}: {error}')
lines.extend(['', '## 逐场景原始数据摘要', '', '| 实例 | 档位 | 场景 | 有效运行次数 | 来源 |', '|---|---|---|---:|---|'])
for key,attempts in sorted(cases.items()):
    lines.append(f'| {key[0]} | {key[1]} | {key[2]} | {len(attempts)} | {", ".join(source for source,_,_ in attempts)} |')
args.output.write_text('\n'.join(lines)+'\n')
args.output.with_suffix('.gates.json').write_text(json.dumps({'gates':gates,'missing':missing},ensure_ascii=False,indent=2))
print(json.dumps({'valid_cases':len(expected & set(cases)),'expected_cases':len(expected),'passing_gates':sum(gate['status']=='通过' for gate in gates),'gates':len(gates)},ensure_ascii=False))
