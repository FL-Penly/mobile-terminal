# 弱网端到端对比报告

**终版结论：42/43量化门槛通过，SSE护栏另行通过；不满足Ready for Merge。** 唯一残余未达标为S4/P0恢复回显，基线三轮中位数704ms，候选707ms，严格相对门槛差3ms。原兼容S2的四个不可判定格按授权S2u全部通过；不追加任何测量。

基线 `cf23151cb2d5531247d0008ff2776293aff1aff7`。证据在[同名目录](weaknet-bench-20261004/)，复现入口为[scripts/weaknet/README.md](../scripts/weaknet/README.md)。日志为UTC，报告日期按北京时间2026-10-04。

原始数据由真实 Chrome、herdr 和 toxiproxy 采集。所有计时单位为 ms，字节为消息正文及其协议前缀；超时是下界，不等于实测完成时间。

## S1

| 档位/指标 | 基线 | 候选 | 阈值 | 结论 |
|---|---:|---:|---|---|
| P0 冷加载字节 | 783,893 | 220,277 | ≤基线×0.3+0 | 通过 |
| P0 刷新传输字节 | 784,193 | 300 | ≤5000 | 通过 |
| P1 冷加载字节 | 783,893 | 220,277 | ≤基线×0.3+0 | 通过 |
| P1 刷新传输字节 | 784,193 | 300 | ≤5000 | 通过 |
| P2 冷加载字节 | 783,893 | 220,277 | ≤基线×0.3+0 | 通过 |
| P2 刷新传输字节 | 784,193 | 300 | ≤5000 | 通过 |

## S2

| 档位/指标 | 基线 | 候选 | 阈值 | 结论 |
|---|---:|---:|---|---|
| P0 回显 p95 | 111 | 112 | ≤基线×1.1+50 | 通过 |
| P1 回显 p95 | ≥30,000 | 444 | ≤基线×1.1+50 | 通过 |
| P2 回显 p95 | ≥30,000 | 1,126 | ≤2500 | 通过 |

## S3

| 档位/指标 | 基线 | 候选 | 阈值 | 结论 |
|---|---:|---:|---|---|
| P0 Ctrl-C max | 134 | 133 | ≤基线×1.1+50 | 通过 |
| P1 Ctrl-C max | 2,417 | 418 | ≤基线×1.1+50 | 通过 |
| P2 Ctrl-C max | 27,916 | 1,103 | ≤2500 | 通过 |

## S4

| 档位/指标 | 基线 | 候选 | 阈值 | 结论 |
|---|---:|---:|---|---|
| P0 恢复回显 | 704 | 707 | ≤基线×1+0 | 未达标 |
| P0 恢复下行字节 | 18,436 | 1,424 | ≤32768 且 ≤基线×1+0 | 通过 |
| P1 恢复回显 | 1,339 | 1,306 | ≤2000 且 ≤基线×1+0 | 通过 |
| P1 恢复下行字节 | 24,390 | 1,839 | ≤32768 且 ≤基线×1+0 | 通过 |
| P2 恢复回显 | 2,557 | 2,526 | ≤3000 且 ≤基线×1+0 | 通过 |
| P2 恢复下行字节 | 12,396 | 3,295 | ≤32768 且 ≤基线×1+0 | 通过 |

## S5a

| 档位/指标 | 基线 | 候选 | 阈值 | 结论 |
|---|---:|---:|---|---|
| P0 发现断流 | ≥40,000 | 14,783 | ≤20000 | 通过 |
| P1 发现断流 | ≥40,000 | 14,682 | ≤20000 | 通过 |
| P2 发现断流 | ≥40,000 | 15,263 | ≤20000 | 通过 |
| P1 静止恢复 | 1,270 | 781 | ≤基线×1+3000 | 通过 |
| P2 静止恢复 | 2,325 | 1,949 | ≤基线×1+5000 | 通过 |

## S5b

| 档位/指标 | 基线 | 候选 | 阈值 | 结论 |
|---|---:|---:|---|---|
| P0 发现断流 | ≥40,000 | 13,742 | ≤20000 | 通过 |
| P1 发现断流 | ≥40,000 | 13,514 | ≤20000 | 通过 |
| P2 发现断流 | ≥40,000 | 12,895 | ≤20000 | 通过 |
| P0 刷屏恢复 | 698 | 183 | ≤基线×1+0 | 通过 |
| P1 刷屏恢复 | 1,301 | 710 | ≤8000 且 ≤基线×1+0 | 通过 |
| P2 刷屏恢复 | 3,369 | 1,898 | ≤12000 且 ≤基线×1+0 | 通过 |

## S5c

| 档位/指标 | 基线 | 候选 | 阈值 | 结论 |
|---|---:|---:|---|---|
| P0 reset_peer 恢复 | 727 | 712 | ≤基线×1+0 | 通过 |
| P1 reset_peer 恢复 | 1,428 | 1,245 | ≤基线×1+0 | 通过 |
| P2 reset_peer 恢复 | 2,694 | 2,545 | ≤基线×1+0 | 通过 |

## S7

| 档位/指标 | 基线 | 候选 | 阈值 | 结论 |
|---|---:|---:|---|---|
| P0 刷屏60s字节 | 10,399,970 | 645,949 | ≤基线×0.25+0 | 通过 |
| P0 静止60s字节 | 0 | 252 | ≤基线×1+2048 | 通过 |

## 兼容矩阵

| 组合/档位/指标 | 基线 | 混合版本 | 阈值 | 结论 |
|---|---:|---:|---|---|
| 7703/P0/S2 | 111 | 113 | ≤基线×1.1+50 | 通过 |
| 7703/P0/S4 | 704 | 671 | ≤基线×1.1+50 | 通过 |
| 7703/P1/S2u | 483 | 483 | ≤基线×1.1+50 | 通过 |
| 7703/P1/S4 | 1,339 | 1,359 | ≤基线×1.1+50 | 通过 |
| 7703/P2/S2u | 1,195 | 1,228 | ≤基线×1.1+50 | 通过 |
| 7703/P2/S4 | 2,557 | 2,823 | ≤基线×1.1+50 | 通过 |
| 7704/P0/S2 | 111 | 112 | ≤基线×1.1+50 | 通过 |
| 7704/P1/S2u | 483 | 477 | ≤基线×1.1+50 | 通过 |
| 7704/P2/S2u | 1,195 | 1,243 | ≤基线×1.1+50 | 通过 |

兼容连接/输入/重连还需结合每场景的 opens、控制帧、原始输出前缀和功能回归记录逐项审核。

### 原饱和 S2（保留，不用于替代后的兼容门槛）

按 DIRECTIVE C，P1/P2 四格改用已校准非饱和 S2u 判定；原始 S2 超时不是通过。

| 组合/档位 | 基线超时/20 | 混合版本超时/20 | 原结论 |
|---|---:|---:|---|
| 7703/P1 | 13 | 13 | 不可判定：基线自身超时截断 |
| 7703/P2 | 19 | 19 | 不可判定：基线自身超时截断 |
| 7704/P1 | 13 | 13 | 不可判定：基线自身超时截断 |
| 7704/P2 | 19 | 19 | 不可判定：基线自身超时截断 |

## 保留 TCP 积压的补充场景

更新 latency 暂停并恢复，保留流内数据；这是补充证据，不替代 timeout 场景或其未达标结论。

| 场景/档位 | 基线恢复 ms | 候选恢复 ms | 基线下行 bytes | 候选下行 bytes | 基线/候选连接数 |
|---|---:|---:|---:|---:|---|
| S4-buffered/P1 | 16,168 | 459 | 2,071,646 | 15,637 | 1 / 1 |
| S4-buffered/P2 | 83,220 | 1,124 | 2,658,372 | 13,737 | 1 / 1 |
| S5a-buffered/P1 | 362 | 539 | 92 | 321 | 1 / 3 |
| S5a-buffered/P2 | 960 | 1,402 | 92 | 353 | 1 / 3 |
| S5b-buffered/P1 | 52,064 | 627 | 6,638,113 | 3,086 | 1 / 3 |
| S5b-buffered/P2 | ≥120,004 | 1,652 | 3,828,902 | 4,353 | 1 / 3 |

## 数据完整性

- 有效场景：88/88。
- 缺失场景：无。
- 门槛通过：42/43；任何未验证项不能认定达标。

### 排除记录

```json
[
  {
    "file": "matrix-2.json",
    "case": [
      7701,
      "P0",
      "S4"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7701,
      "P0",
      "S5a"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7701,
      "P0",
      "S5c"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7701,
      "P0",
      "S5b"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7701,
      "P1",
      "S4"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7701,
      "P1",
      "S5a"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7701,
      "P1",
      "S5b"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7701,
      "P1",
      "S5c"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7701,
      "P2",
      "S4"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7701,
      "P2",
      "S5a"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7701,
      "P2",
      "S5b"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7701,
      "P2",
      "S5c"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P0",
      "S1"
    ],
    "reason": "DIRECTIVE D：A后最终构建确认"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P0",
      "S2"
    ],
    "reason": "DIRECTIVE D：A后最终构建确认"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P0",
      "S3"
    ],
    "reason": "DIRECTIVE D：A后最终构建确认"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P0",
      "S4"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P0",
      "S5a"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P0",
      "S5b"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P0",
      "S5c"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P0",
      "S7"
    ],
    "reason": "DIRECTIVE D：A后最终构建确认"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P1",
      "S1"
    ],
    "reason": "DIRECTIVE D：A后最终构建确认"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P1",
      "S2"
    ],
    "reason": "DIRECTIVE D：A后最终构建确认"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P1",
      "S3"
    ],
    "reason": "DIRECTIVE D：A后最终构建确认"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P1",
      "S4"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P1",
      "S5a"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P1",
      "S5b"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P1",
      "S5c"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P2",
      "S1"
    ],
    "reason": "DIRECTIVE D：A后最终构建确认"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P2",
      "S2"
    ],
    "reason": "DIRECTIVE D：A后最终构建确认"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P2",
      "S3"
    ],
    "reason": "DIRECTIVE D：A后最终构建确认"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P2",
      "S4"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P2",
      "S5a"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P2",
      "S5b"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P2",
      "S5c"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7703,
      "P0",
      "S4"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7703,
      "P1",
      "S4"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7703,
      "P2",
      "S4"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7704,
      "P0",
      "S1"
    ],
    "reason": "DIRECTIVE D：A后最终构建确认"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7704,
      "P0",
      "S4"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7704,
      "P0",
      "S5c"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7704,
      "P1",
      "S1"
    ],
    "reason": "DIRECTIVE D：A后最终构建确认"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7704,
      "P1",
      "S4"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7704,
      "P1",
      "S5c"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7704,
      "P2",
      "S1"
    ],
    "reason": "DIRECTIVE D：A后最终构建确认"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7704,
      "P2",
      "S4"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7704,
      "P2",
      "S5c"
    ],
    "reason": "DIRECTIVE B：A修正及恢复探测100→20ms，固定三轮"
  }
]
```

### 测试台异常记录


## 逐场景原始数据摘要

| 实例 | 档位 | 场景 | 有效运行次数 | 来源 |
|---|---|---|---:|---|
| 7701 | P0 | S1 | 1 | matrix-2.json |
| 7701 | P0 | S2 | 1 | matrix-2.json |
| 7701 | P0 | S3 | 1 | matrix-2.json |
| 7701 | P0 | S4 | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7701 | P0 | S5a | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7701 | P0 | S5b | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7701 | P0 | S5c | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7701 | P0 | S7 | 1 | matrix-2.json |
| 7701 | P1 | S1 | 1 | matrix-2.json |
| 7701 | P1 | S2 | 1 | matrix-2.json |
| 7701 | P1 | S2u | 1 | directive-c-s2u-r1.json |
| 7701 | P1 | S3 | 1 | matrix-2.json |
| 7701 | P1 | S4 | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7701 | P1 | S4-buffered | 1 | buffered.json |
| 7701 | P1 | S5a | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7701 | P1 | S5a-buffered | 1 | buffered.json |
| 7701 | P1 | S5b | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7701 | P1 | S5b-buffered | 1 | buffered.json |
| 7701 | P1 | S5c | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7701 | P2 | S1 | 1 | matrix-2.json |
| 7701 | P2 | S2 | 1 | matrix-2.json |
| 7701 | P2 | S2u | 1 | directive-c-s2u-r1.json |
| 7701 | P2 | S3 | 1 | matrix-2.json |
| 7701 | P2 | S4 | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7701 | P2 | S4-buffered | 1 | buffered.json |
| 7701 | P2 | S5a | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7701 | P2 | S5a-buffered | 1 | buffered.json |
| 7701 | P2 | S5b | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7701 | P2 | S5b-buffered | 1 | buffered.json |
| 7701 | P2 | S5c | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7702 | P0 | S1 | 1 | directive-d-s1.json |
| 7702 | P0 | S2 | 1 | directive-d-candidate.json |
| 7702 | P0 | S3 | 1 | directive-d-candidate.json |
| 7702 | P0 | S4 | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7702 | P0 | S5a | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7702 | P0 | S5b | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7702 | P0 | S5c | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7702 | P0 | S7 | 1 | directive-d-candidate.json |
| 7702 | P1 | S1 | 1 | directive-d-s1.json |
| 7702 | P1 | S2 | 1 | directive-d-candidate.json |
| 7702 | P1 | S2u | 1 | directive-c-s2u-r1.json |
| 7702 | P1 | S3 | 1 | directive-d-candidate.json |
| 7702 | P1 | S4 | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7702 | P1 | S4-buffered | 1 | buffered.json |
| 7702 | P1 | S5a | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7702 | P1 | S5a-buffered | 1 | buffered.json |
| 7702 | P1 | S5b | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7702 | P1 | S5b-buffered | 1 | buffered.json |
| 7702 | P1 | S5c | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7702 | P2 | S1 | 1 | directive-d-s1.json |
| 7702 | P2 | S2 | 1 | directive-d-candidate.json |
| 7702 | P2 | S2u | 1 | directive-c-s2u-r1.json |
| 7702 | P2 | S3 | 1 | directive-d-candidate.json |
| 7702 | P2 | S4 | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7702 | P2 | S4-buffered | 1 | buffered.json |
| 7702 | P2 | S5a | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7702 | P2 | S5a-buffered | 1 | buffered.json |
| 7702 | P2 | S5b | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7702 | P2 | S5b-buffered | 1 | buffered.json |
| 7702 | P2 | S5c | 3 | directive-b-r1-primary.json, directive-b-r2-primary.json, directive-b-r3-primary.json |
| 7703 | P0 | S1 | 1 | matrix-2.json |
| 7703 | P0 | S2 | 1 | matrix-2.json |
| 7703 | P0 | S3 | 1 | matrix-2.json |
| 7703 | P0 | S4 | 3 | directive-b-r1-legacy.json, directive-b-r2-legacy.json, directive-b-r3-legacy.json |
| 7703 | P0 | S5a | 1 | matrix-2.json |
| 7703 | P0 | S5b | 1 | matrix-2.json |
| 7703 | P0 | S5c | 1 | matrix-2.json |
| 7703 | P0 | S7 | 1 | matrix-2.json |
| 7703 | P1 | S1 | 1 | matrix-2.json |
| 7703 | P1 | S2 | 1 | matrix-2.json |
| 7703 | P1 | S2u | 1 | directive-c-s2u-r1.json |
| 7703 | P1 | S3 | 1 | matrix-2.json |
| 7703 | P1 | S4 | 3 | directive-b-r1-legacy.json, directive-b-r2-legacy.json, directive-b-r3-legacy.json |
| 7703 | P1 | S5a | 1 | matrix-2.json |
| 7703 | P1 | S5b | 1 | matrix-2.json |
| 7703 | P1 | S5c | 1 | matrix-2.json |
| 7703 | P2 | S1 | 1 | matrix-2.json |
| 7703 | P2 | S2 | 1 | matrix-2.json |
| 7703 | P2 | S2u | 1 | directive-c-s2u-r1.json |
| 7703 | P2 | S3 | 1 | matrix-2.json |
| 7703 | P2 | S4 | 3 | directive-b-r1-legacy.json, directive-b-r2-legacy.json, directive-b-r3-legacy.json |
| 7703 | P2 | S5a | 1 | matrix-2.json |
| 7703 | P2 | S5b | 1 | matrix-2.json |
| 7703 | P2 | S5c | 1 | matrix-2.json |
| 7704 | P0 | S1 | 1 | directive-d-s1.json |
| 7704 | P0 | S2 | 1 | matrix-2.json |
| 7704 | P0 | S3 | 1 | matrix-2.json |
| 7704 | P0 | S4 | 3 | directive-b-r1-modern-legacy.json, directive-b-r2-modern-legacy.json, directive-b-r3-modern-legacy.json |
| 7704 | P0 | S5a | 1 | matrix-2.json |
| 7704 | P0 | S5b | 1 | matrix-2.json |
| 7704 | P0 | S5c | 3 | directive-b-r1-modern-legacy.json, directive-b-r2-modern-legacy.json, directive-b-r3-modern-legacy.json |
| 7704 | P0 | S7 | 1 | matrix-2.json |
| 7704 | P1 | S1 | 1 | directive-d-s1.json |
| 7704 | P1 | S2 | 1 | matrix-2.json |
| 7704 | P1 | S2u | 1 | directive-c-s2u-r1.json |
| 7704 | P1 | S3 | 1 | matrix-2.json |
| 7704 | P1 | S4 | 3 | directive-b-r1-modern-legacy.json, directive-b-r2-modern-legacy.json, directive-b-r3-modern-legacy.json |
| 7704 | P1 | S5a | 1 | matrix-2.json |
| 7704 | P1 | S5b | 1 | matrix-2.json |
| 7704 | P1 | S5c | 3 | directive-b-r1-modern-legacy.json, directive-b-r2-modern-legacy.json, directive-b-r3-modern-legacy.json |
| 7704 | P2 | S1 | 1 | directive-d-s1.json |
| 7704 | P2 | S2 | 1 | matrix-2.json |
| 7704 | P2 | S2u | 1 | directive-c-s2u-r1.json |
| 7704 | P2 | S3 | 1 | matrix-2.json |
| 7704 | P2 | S4 | 3 | directive-b-r1-modern-legacy.json, directive-b-r2-modern-legacy.json, directive-b-r3-modern-legacy.json |
| 7704 | P2 | S5a | 1 | matrix-2.json |
| 7704 | P2 | S5b | 1 | matrix-2.json |
| 7704 | P2 | S5c | 3 | directive-b-r1-modern-legacy.json, directive-b-r2-modern-legacy.json, directive-b-r3-modern-legacy.json |

## DIRECTIVE A→D及数据替换

- A：从未open的尝试按`max(0, backoff−建连已耗时)`等待；open过的连接保持完整退避。0.5/1/2/3/5秒序列、10/15/20秒连接超时、稳定10秒清零及隐藏/挂起/接管/retry:false保护不变。红测3失败/37通过，绿测40通过；全量前端151通过。
- B：recoverEcho探测节拍100→20ms，其他120秒上限、DOM首次回显、遮罩、等长编号、工作负载不变。7701/7702的S4/S5a/S5b/S5c、7703的S4、7704的S4/S5c均三档各三轮，99有效记录、0测试台异常。固定三轮中位数，不追加、不改口径。
- C：四端口在P1/P2各一次S2u，160探测无超时，授权替换四个兼容门槛。
- D：新dist的7702/7704三档S1，以及7702三档S2/S3和P0 S7全部终版确认通过，无需配对补测。15项回归完成。
- 终版输入与排除清单：`directive-report-inputs.json`、`directive-excluded-runs.json`。新数据指定的旧格子不参与聚合；未被授权重测的基线与其他兼容格继续引用原矩阵。88/88表示各格有保留证据，不表示全部88格均在新构建上重新运行。原S4/S5旧轮次只在附录使用，不和B的新三轮混合。
- 页面与服务端从A构建后至D结束哈希未变；B脚本哈希见`directive-build-sha256.json`，此后只添加C的CAL/S2u支持；最终源码/构建/脚本哈希见`final-build-sha256.json`，原交付构建哈希保存在`legacy-final-build-sha256.json`。

## S2u校准与八格结果

采用ANSWERS Q1授权的18点粗网格（每点稳定5秒、采样10秒）、逐整数细化及独立20秒确认。带宽按1000字节/KB，上限为档位的70%。25次有效校准原始JSON和`directive-c-calibration.json`均保留；不要求单调或证明全域最大。

| 档位 | rate | 独立确认字节 | 实测窗口ms | B/s | 上限B/s |
|---|---:|---:|---:|---:|---:|
| P1 | 29 | 1736322 | 20000.993188 | 86811.788979 | 89600 |
| P2 | 7 | 419118 | 20001.067279 | 20954.781770 | 22400 |

rate30实测89807.401207B/s超过P1上限；rate8超过P2上限。四端口同档同rate；S2u仍稳定5秒、20探测、单次30秒上限、间隔1秒。所有格均0/20超时。

| 档位 | 基线7701 p95 | 新版7702 p95 | 旧页面+新服务端7703 p95 | 新页面+旧服务端7704 p95 | 兼容门槛 |
|---|---:|---:|---:|---:|---:|
| P1 | 483 | 445 | 483 | 477 | 581.3 |
| P2 | 1195 | 1160 | 1228 | 1243 | 1364.5 |

首个校准尝试因普通定时器提前约1ms返回，实测9999ms而被拒收，原始记录在`directive-c-invalid-timer/`。修正为单调时钟并等满规定窗口后重启完整校准；没有放宽采样时长或速率上限，也未用无效样本选rate。

## S5b时间线与唯一残余失败

A修正了“挂起握手已经耗时足够，失败后却再次等满退避”的路径。以`directive-b-r1-primary.json`的候选P0 S5b为例：attempt3在1791082629685创建，1791082640446关闭，attempt4在1791082640458创建，相隔12ms；旧口径第三轮P1曾在握手失败后再等整整2000ms。这里变化来自授权的未open耗时扣除，没有改变打开后断开的退避。

新三轮中位数S5b/P0/P1/P2为698→183、1301→710、3369→1898ms，均通过。S5c/P0为727→712ms；7703/S4的三档兼容门槛也通过。

S4/P0仍为704→707ms，慢3ms，约0.43%。这是严格相对门槛的真实失败；即使差值很小，也不以“噪声”改判通过。B已固定三轮，不再测量。其余42项门槛及SSE护栏通过不能替代这一条件。

## 最终功能DIFF

| # | 使用场景 | 改前 | 改后/实测限制 |
|---|---|---|---|
| 1 | 手机重新打开页面 | 正文783893字节；P1/P2冷加载6562/25554ms | gzip220277字节；冷加载2096/7658ms；刷新304、300字节、380/864ms |
| 2 | herdr刷屏流量 | P0刷屏60秒10399970字节 | 645949字节（6.21%）；P2回显20次均成功 |
| 3 | P2刷屏按键/Ctrl-C | 回显19/20超时、p95≥30秒；Ctrl-C最慢27916ms | p95 1126ms；Ctrl-C最慢1103ms |
| 4 | herdr断流10秒恢复 | P0/P1/P2恢复中位数704/1339/2557ms | 707/1306/2526ms；P0慢3ms未达标；下行18436/24390/12396→1424/1839/3295字节 |
| 5 | herdr悄然断网 | 静默40秒内未发现；刷屏恢复698/1301/3369ms | 约12.9–15.3秒发现；刷屏恢复183/710/1898ms（三档中位数） |
| 6 | plain/tmux悄然断网 | 无JS静默判死 | 保持不判死；单测及真实回归确认无heartbeat，协议Ping保留 |
| 7 | plain/tmux刷屏 | 原始0前缀输出 | 5前缀流式压缩、不跳帧；100行/秒回显与Ctrl-C成功，未单独量化压缩比 |
| 8 | 长时间连不上 | 最多10次后停止 | 持续重试；未open扣除建连已耗时，open后完整0.5/1/2/3/5秒退避；连接超时10/15/20秒，后台暂停、online立即重试 |
| 9 | 打开后立即断开 | 每次打开即清零，反复快速重试 | 稳定10秒才清零；连续12次不稳定连接、慢握手后open再断开均有通过单测 |
| 10 | 同pane被接管 | 依赖Close reason，弱网可能丢失 | 先发closed控制；P0/P2刷屏接管显示提示且不自动抢回，隐藏边界单测通过 |
| 11 | agent/SSE状态 | 协议22被拒，新pane15秒内无推送 | 新pane207ms推送；default5分钟101042字节，订阅失败0 |
| 12 | 服务端连接资源 | 无init时限、herdr死连接不回收 | init20秒；herdr600秒无入站回收，虚拟时间/真实WS验证 |
| 13 | 升级混合版本 | 旧协议；饱和S2 P1/P2基线13/20、19/20超时 | 连接/回显/重连正常；授权S2u四格p95 483/1228/477/1243ms均通过；饱和S2仍不可判定 |
| 14 | 现有操作与看板 | 现有行为 | 15项回归有通过证据；可见性为事件注入，未做手机OS实机后台测试 |

## 15项功能回归

A后最终页面主记录为`regression-1791086920258.json`，第5项最终定向记录为`regression-1791087029434.json`。第14项沿用授权的`step1-verification.json`。

| # | 检查 | 最终证据 |
|---|---|---|
| 1 | herdr打开、输入、回显 | ✓ REG_HERDR与压缩输出 |
| 2 | 多行粘贴 | ✓ UI发起paste API200，两行输出 |
| 3 | Ctrl/Alt/Shift方向键 | ✓ 真实PTY输入记录器核对转义字节 |
| 4 | 双指缩放与resize | ✓ 字号19、32×30，与DOM行数一致 |
| 5 | 侧边栏切pane | ✓ 目标w6:p1、两个WS、新pane回显 |
| 6 | 同pane接管，P0/P2刷屏 | ✓ 提示且7秒不自动抢回 |
| 7 | 隐藏后释放、可见后恢复 | ✓ 事件注入与真实WS行为；非手机OS测试 |
| 8 | Detach | ✓ 基线与候选均断开后自动重连 |
| 9 | tmux连接与restore | ✓ t1/t2恢复，100行/秒刷屏step519 |
| 10 | plain shell | ✓ 输入回显；plain/tmux总7043ms，回显99ms/Ctrl-C95ms，无heartbeat |
| 11 | Git Diff面板 | ✓ 隔离git仓库真实diff正文，已清理 |
| 12 | 图片粘贴上传 | ✓ API200且文件逐字节一致，已删除 |
| 13 | goal/prompt看板 | ✓ HTTP200+gzip、已加载/已同步、可见detail |
| 14 | SSE实时变化 | ✓ 新pane207ms推送，基线15秒未推送；default5分钟101042字节≤1MB，订阅失败0 |
| 15 | 连接指示灯 | ✓ 连接/断开/恢复/接管标识一致 |

本次第5项首轮失败是测试在URL变化后立即输入、没有等待新连接就绪；目标pane仍是空shell。仅增加Connected等待后通过，产品代码未修改，失败原始记录保留。历史看板断言修正和旧功能记录仍保留在附录。

## 环境、限制与全量检查

- Rust/Cargo1.96.0、Node22.23.2、Python3.11.2、Chrome151.0.7922.71、herdr0.9.1、tmux3.3a、toxiproxy2.12.0；详见`environment.json`。
- 四端口只控制mtbench，经独立代理串行；P0双向25ms，P1双向150±50ms/128KB/s，P2双向400±150ms/32KB/s；视口390×844，禁用SW/GPU/WebGL，DOM首次输出计时。
- WS字节包含应用前缀与控制消息，不含TCP/TLS/WS封装。304时encodedBodySize可能是缓存正文长度，网络刷新按transferSize及真实CDP304判定。
- timeout toxic会丢弃流内数据并在移除时关闭TCP，S4/S5因此主要覆盖断流及重连；前面的buffered表是保留TCP积压的历史补充证据，不替代门槛，也未在A后额外重测。
- 基线同样存在的WebGL禁用错误、旧协议高负载渲染器错误保留在traffic.errors中，没有删除对应测量。
- D：前端151测试/tsc/build通过；Rustfmt/clippy/release通过，测试131通过/1基线既有失败（tmux_discovery::tests::isolated_tmux_discovers_moves_switches_windows_and_removes_sessions），无新增失败/警告。使用--no-fail-fast保证WS集成测试执行。
- smoke HTTP与其余静态检查通过，仍打印同一个基线Rust测试失败；脚本exit0不等于全绿。新增报告四个边界检查通过，见`directive-d-report-check.json`。
- 没有手机OS实机后台、所有VPN及长期线上压力结果。既有鉴权、路径穿越、固定/tmp包装脚本和预测回显默认值不在本次范围。

## 旧口径附录

完整旧报告保存在[weaknet-bench-20261004-legacy.md](weaknet-bench-20261004-legacy.md)，原始矩阵及旧复测JSON全部保留。旧结论34/43属于原构建/原100ms恢复探测，不能当作本次终版结论。B的指定格因探测量化修正及A产品修正被替代；D指定格使用最终构建确认；原饱和S2仍保留不可判定，只有C授权的四个兼容门槛以S2u判定。

旧报告引用的原`final-build-sha256.json`已另存为`legacy-final-build-sha256.json`。提交、7692部署、清理核验和MR Ready七项见外部DELIVERY.md；不执行7682切换或remote push。
