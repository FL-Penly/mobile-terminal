# 附录：DIRECTIVE #1之前的旧口径报告

本文件保留旧构建及100ms恢复探测的结果，供追溯。B指定恢复格子和D终版确认的数据将由新测量替代，不与此处旧轮次混算。原文如下。

# 弱网端到端对比报告

**结论：暂不满足 Ready for Merge。** 主矩阵 88/88 场景有有效记录；43 个自动量化门槛通过 34 个，5 个未达标、4 个兼容回显因双方超时而未验证。功能回归已完成，Rust 有一项确认存在于基线的测试失败。不得据此报告宣称「全部不比改前差」。

基线为 `cf23151cb2d5531247d0008ff2776293aff1aff7`。原始证据与环境位于 [weaknet-bench-20261004/](weaknet-bench-20261004/)，复现入口为 [scripts/weaknet/README.md](../scripts/weaknet/README.md)。本报告日期按北京时间 2026-10-04，日志时间为 UTC。

原始数据由真实 Chrome、herdr 和 toxiproxy 采集。所有计时单位为 ms，字节为消息正文及其协议前缀；超时是下界，不等于实测完成时间。

## S1

| 档位/指标 | 基线 | 候选 | 阈值 | 结论 |
|---|---:|---:|---|---|
| P0 冷加载字节 | 783,893 | 220,243 | ≤基线×0.3+0 | 通过 |
| P0 刷新传输字节 | 784,193 | 300 | ≤5000 | 通过 |
| P1 冷加载字节 | 783,893 | 220,243 | ≤基线×0.3+0 | 通过 |
| P1 刷新传输字节 | 784,193 | 300 | ≤5000 | 通过 |
| P2 冷加载字节 | 783,893 | 220,243 | ≤基线×0.3+0 | 通过 |
| P2 刷新传输字节 | 784,193 | 300 | ≤5000 | 通过 |

## S2

| 档位/指标 | 基线 | 候选 | 阈值 | 结论 |
|---|---:|---:|---|---|
| P0 回显 p95 | 111 | 111 | ≤基线×1.1+50 | 通过 |
| P1 回显 p95 | ≥30,000 | 433 | ≤基线×1.1+50 | 通过 |
| P2 回显 p95 | ≥30,000 | 1,111 | ≤2500 | 通过 |

## S3

| 档位/指标 | 基线 | 候选 | 阈值 | 结论 |
|---|---:|---:|---|---|
| P0 Ctrl-C max | 134 | 135 | ≤基线×1.1+50 | 通过 |
| P1 Ctrl-C max | 2,417 | 416 | ≤基线×1.1+50 | 通过 |
| P2 Ctrl-C max | 27,916 | 1,015 | ≤2500 | 通过 |

## S4

| 档位/指标 | 基线 | 候选 | 阈值 | 结论 |
|---|---:|---:|---|---|
| P0 恢复回显 | 722 | 715 | ≤基线×1+0 | 通过 |
| P0 恢复下行字节 | 18,374 | 1,668 | ≤32768 且 ≤基线×1+0 | 通过 |
| P1 恢复回显 | 1,440 | 1,325 | ≤2000 且 ≤基线×1+0 | 通过 |
| P1 恢复下行字节 | 42,310 | 2,130 | ≤32768 且 ≤基线×1+0 | 通过 |
| P2 恢复回显 | 3,174 | 2,477 | ≤3000 且 ≤基线×1+0 | 通过 |
| P2 恢复下行字节 | 30,330 | 2,894 | ≤32768 且 ≤基线×1+0 | 通过 |

## S5a

| 档位/指标 | 基线 | 候选 | 阈值 | 结论 |
|---|---:|---:|---|---|
| P0 发现断流 | ≥40,000 | 14,802 | ≤20000 | 通过 |
| P1 发现断流 | ≥40,000 | 15,644 | ≤20000 | 通过 |
| P2 发现断流 | ≥40,000 | 14,206 | ≤20000 | 通过 |
| P1 静止恢复 | 1,231 | 2,769 | ≤基线×1+3000 | 通过 |
| P2 静止恢复 | 2,797 | 3,922 | ≤基线×1+5000 | 通过 |

## S5b

| 档位/指标 | 基线 | 候选 | 阈值 | 结论 |
|---|---:|---:|---|---|
| P0 发现断流 | ≥40,000 | 13,770 | ≤20000 | 通过 |
| P1 发现断流 | ≥40,000 | 13,460 | ≤20000 | 通过 |
| P2 发现断流 | ≥40,000 | 12,818 | ≤20000 | 通过 |
| P0 刷屏恢复 | 728 | 2,209 | ≤基线×1+0 | 未达标 |
| P1 刷屏恢复 | 1,323 | 2,774 | ≤8000 且 ≤基线×1+0 | 未达标 |
| P2 刷屏恢复 | 2,874 | 3,904 | ≤12000 且 ≤基线×1+0 | 未达标 |

## S5c

| 档位/指标 | 基线 | 候选 | 阈值 | 结论 |
|---|---:|---:|---|---|
| P0 reset_peer 恢复 | 726 | 826 | ≤基线×1+0 | 未达标 |
| P1 reset_peer 恢复 | 1,531 | 1,443 | ≤基线×1+0 | 通过 |
| P2 reset_peer 恢复 | 3,461 | 2,962 | ≤基线×1+0 | 通过 |

## S7

| 档位/指标 | 基线 | 候选 | 阈值 | 结论 |
|---|---:|---:|---|---|
| P0 刷屏60s字节 | 10,399,970 | 646,075 | ≤基线×0.25+0 | 通过 |
| P0 静止60s字节 | 0 | 252 | ≤基线×1+2048 | 通过 |

## 兼容矩阵

| 组合/档位/指标 | 基线 | 混合版本 | 阈值 | 结论 |
|---|---:|---:|---|---|
| 7703/P0/S2 | 111 | 113 | ≤基线×1.1+50 | 通过 |
| 7703/P0/S4 | 722 | 704 | ≤基线×1.1+50 | 通过 |
| 7703/P1/S2 | ≥30,000 | ≥30,000 | ≤基线×1.1+50 | 未验证 |
| 7703/P1/S4 | 1,440 | 1,278 | ≤基线×1.1+50 | 通过 |
| 7703/P2/S2 | ≥30,000 | ≥30,000 | ≤基线×1.1+50 | 未验证 |
| 7703/P2/S4 | 3,174 | 3,559 | ≤基线×1.1+50 | 未达标 |
| 7704/P0/S2 | 111 | 112 | ≤基线×1.1+50 | 通过 |
| 7704/P1/S2 | ≥30,000 | ≥30,000 | ≤基线×1.1+50 | 未验证 |
| 7704/P2/S2 | ≥30,000 | ≥30,000 | ≤基线×1.1+50 | 未验证 |

兼容连接/输入/重连还需结合每场景的 opens、控制帧、原始输出前缀和功能回归记录逐项审核。

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
- 门槛通过：34/43；任何未验证项不能认定达标。

### 排除记录

```json
[
  {
    "file": "matrix-1.json",
    "case": [
      7701,
      "P0",
      "S5c"
    ],
    "reason": "S5b 预检失败遗留页面互相接管，结果污染"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7701,
      "P0",
      "S5c"
    ],
    "reason": "resume 复制了 matrix-1 的污染结果，必须重测"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P0",
      "S1"
    ],
    "reason": "最终页面包含接管生命周期修复，S1改用final-s1.json；此构建旧测量仍保留在原始文件，不参与最终页面大小统计。"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P1",
      "S1"
    ],
    "reason": "最终页面包含接管生命周期修复，S1改用final-s1.json；此构建旧测量仍保留在原始文件，不参与最终页面大小统计。"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7702,
      "P2",
      "S1"
    ],
    "reason": "最终页面包含接管生命周期修复，S1改用final-s1.json；此构建旧测量仍保留在原始文件，不参与最终页面大小统计。"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7704,
      "P0",
      "S1"
    ],
    "reason": "最终页面包含接管生命周期修复，S1改用final-s1.json；此构建旧测量仍保留在原始文件，不参与最终页面大小统计。"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7704,
      "P1",
      "S1"
    ],
    "reason": "最终页面包含接管生命周期修复，S1改用final-s1.json；此构建旧测量仍保留在原始文件，不参与最终页面大小统计。"
  },
  {
    "file": "matrix-2.json",
    "case": [
      7704,
      "P2",
      "S1"
    ],
    "reason": "最终页面包含接管生命周期修复，S1改用final-s1.json；此构建旧测量仍保留在原始文件，不参与最终页面大小统计。"
  }
]
```

### 测试台异常记录

- `matrix-2.json` (7701, 'P0', 'S5b'): Error: POST /proxies/mt7701/toxics: {"error":"proxy not found","status":404}

## 逐场景原始数据摘要

| 实例 | 档位 | 场景 | 有效运行次数 | 来源 |
|---|---|---|---:|---|
| 7701 | P0 | S1 | 1 | matrix-2.json |
| 7701 | P0 | S2 | 1 | matrix-2.json |
| 7701 | P0 | S3 | 1 | matrix-2.json |
| 7701 | P0 | S4 | 3 | matrix-2.json, s4-round-2.json, s4-round-3.json |
| 7701 | P0 | S5a | 1 | matrix-2.json |
| 7701 | P0 | S5b | 3 | fill-baseline.json, p0-round-2.json, p0-round-3.json |
| 7701 | P0 | S5c | 3 | fill-baseline.json, p0-round-2.json, p0-round-3.json |
| 7701 | P0 | S7 | 1 | matrix-2.json |
| 7701 | P1 | S1 | 1 | matrix-2.json |
| 7701 | P1 | S2 | 1 | matrix-2.json |
| 7701 | P1 | S3 | 1 | matrix-2.json |
| 7701 | P1 | S4 | 1 | matrix-2.json |
| 7701 | P1 | S4-buffered | 1 | buffered.json |
| 7701 | P1 | S5a | 1 | matrix-2.json |
| 7701 | P1 | S5a-buffered | 1 | buffered.json |
| 7701 | P1 | S5b | 3 | matrix-2.json, s5b-round-2.json, s5b-round-3.json |
| 7701 | P1 | S5b-buffered | 1 | buffered.json |
| 7701 | P1 | S5c | 1 | matrix-2.json |
| 7701 | P2 | S1 | 1 | matrix-2.json |
| 7701 | P2 | S2 | 1 | matrix-2.json |
| 7701 | P2 | S3 | 1 | matrix-2.json |
| 7701 | P2 | S4 | 3 | matrix-2.json, s4-round-2.json, s4-round-3.json |
| 7701 | P2 | S4-buffered | 1 | buffered.json |
| 7701 | P2 | S5a | 1 | matrix-2.json |
| 7701 | P2 | S5a-buffered | 1 | buffered.json |
| 7701 | P2 | S5b | 3 | matrix-2.json, s5b-round-2.json, s5b-round-3.json |
| 7701 | P2 | S5b-buffered | 1 | buffered.json |
| 7701 | P2 | S5c | 1 | matrix-2.json |
| 7702 | P0 | S1 | 1 | final-s1.json |
| 7702 | P0 | S2 | 1 | matrix-2.json |
| 7702 | P0 | S3 | 1 | matrix-2.json |
| 7702 | P0 | S4 | 3 | matrix-2.json, s4-round-2.json, s4-round-3.json |
| 7702 | P0 | S5a | 1 | matrix-2.json |
| 7702 | P0 | S5b | 3 | matrix-2.json, p0-round-2.json, p0-round-3.json |
| 7702 | P0 | S5c | 3 | matrix-2.json, p0-round-2.json, p0-round-3.json |
| 7702 | P0 | S7 | 1 | matrix-2.json |
| 7702 | P1 | S1 | 1 | final-s1.json |
| 7702 | P1 | S2 | 1 | matrix-2.json |
| 7702 | P1 | S3 | 1 | matrix-2.json |
| 7702 | P1 | S4 | 1 | matrix-2.json |
| 7702 | P1 | S4-buffered | 1 | buffered.json |
| 7702 | P1 | S5a | 1 | matrix-2.json |
| 7702 | P1 | S5a-buffered | 1 | buffered.json |
| 7702 | P1 | S5b | 3 | matrix-2.json, s5b-round-2.json, s5b-round-3.json |
| 7702 | P1 | S5b-buffered | 1 | buffered.json |
| 7702 | P1 | S5c | 1 | matrix-2.json |
| 7702 | P2 | S1 | 1 | final-s1.json |
| 7702 | P2 | S2 | 1 | matrix-2.json |
| 7702 | P2 | S3 | 1 | matrix-2.json |
| 7702 | P2 | S4 | 3 | matrix-2.json, s4-round-2.json, s4-round-3.json |
| 7702 | P2 | S4-buffered | 1 | buffered.json |
| 7702 | P2 | S5a | 1 | matrix-2.json |
| 7702 | P2 | S5a-buffered | 1 | buffered.json |
| 7702 | P2 | S5b | 3 | matrix-2.json, s5b-round-2.json, s5b-round-3.json |
| 7702 | P2 | S5b-buffered | 1 | buffered.json |
| 7702 | P2 | S5c | 1 | matrix-2.json |
| 7703 | P0 | S1 | 1 | matrix-2.json |
| 7703 | P0 | S2 | 1 | matrix-2.json |
| 7703 | P0 | S3 | 1 | matrix-2.json |
| 7703 | P0 | S4 | 3 | matrix-2.json, s4-round-2.json, s4-round-3.json |
| 7703 | P0 | S5a | 1 | matrix-2.json |
| 7703 | P0 | S5b | 1 | matrix-2.json |
| 7703 | P0 | S5c | 1 | matrix-2.json |
| 7703 | P0 | S7 | 1 | matrix-2.json |
| 7703 | P1 | S1 | 1 | matrix-2.json |
| 7703 | P1 | S2 | 1 | matrix-2.json |
| 7703 | P1 | S3 | 1 | matrix-2.json |
| 7703 | P1 | S4 | 1 | matrix-2.json |
| 7703 | P1 | S5a | 1 | matrix-2.json |
| 7703 | P1 | S5b | 1 | matrix-2.json |
| 7703 | P1 | S5c | 1 | matrix-2.json |
| 7703 | P2 | S1 | 1 | matrix-2.json |
| 7703 | P2 | S2 | 1 | matrix-2.json |
| 7703 | P2 | S3 | 1 | matrix-2.json |
| 7703 | P2 | S4 | 3 | matrix-2.json, s4-round-2.json, s4-round-3.json |
| 7703 | P2 | S5a | 1 | matrix-2.json |
| 7703 | P2 | S5b | 1 | matrix-2.json |
| 7703 | P2 | S5c | 1 | matrix-2.json |
| 7704 | P0 | S1 | 1 | final-s1.json |
| 7704 | P0 | S2 | 1 | matrix-2.json |
| 7704 | P0 | S3 | 1 | matrix-2.json |
| 7704 | P0 | S4 | 1 | matrix-2.json |
| 7704 | P0 | S5a | 1 | matrix-2.json |
| 7704 | P0 | S5b | 1 | matrix-2.json |
| 7704 | P0 | S5c | 1 | matrix-2.json |
| 7704 | P0 | S7 | 1 | matrix-2.json |
| 7704 | P1 | S1 | 1 | final-s1.json |
| 7704 | P1 | S2 | 1 | matrix-2.json |
| 7704 | P1 | S3 | 1 | matrix-2.json |
| 7704 | P1 | S4 | 1 | matrix-2.json |
| 7704 | P1 | S5a | 1 | matrix-2.json |
| 7704 | P1 | S5b | 1 | matrix-2.json |
| 7704 | P1 | S5c | 1 | matrix-2.json |
| 7704 | P2 | S1 | 1 | final-s1.json |
| 7704 | P2 | S2 | 1 | matrix-2.json |
| 7704 | P2 | S3 | 1 | matrix-2.json |
| 7704 | P2 | S4 | 1 | matrix-2.json |
| 7704 | P2 | S5a | 1 | matrix-2.json |
| 7704 | P2 | S5b | 1 | matrix-2.json |
| 7704 | P2 | S5c | 1 | matrix-2.json |

## 环境、构建与测量限制

- 仓库内测试日志仅规范化行尾空白，命令、结果与数值保持原样；运行器原始日志另保留在本机测试状态目录。
- Rust/Cargo 1.96.0，Node 22.23.2，Python 3.11.2，Chrome 151.0.7922.71，playwright-core 1.61.0-alpha-1781023400000，herdr 0.9.1，tmux 3.3a，toxiproxy 2.12.0；完整版本见 `environment.json`。
- 四个实例只使用 `mtbench` herdr 会话和 tmux socket，经独立代理依次测量。双向 P0=25ms；P1=150±50ms/128KB/s；P2=400±150ms/32KB/s；390×844 视口、禁用 Service Worker/GPU/WebGL、DOM 渲染。
- S2 每场景固定20次/1秒间隔/30秒上限，S3固定5次；模拟器保持每秒100行彩色输出，不降低负载。恢复探测每100ms发送等长标识，最多观察120秒。超时为下界。
- 完整矩阵与配对复测期间冻结页面和二进制，哈希见 `matrix-build-sha256.txt`。最终页面加入「接管控制消息后立即隐藏」的生命周期修复后，重新执行功能回归和S1；最终哈希见 `final-build-sha256.json`。其余吞吐/流控逻辑未变。最终页面S1替换旧构建对应记录，旧数据保留，排除原因明确列出。
- 对初次未达标的恢复场景最多测三轮，采用全部有效测量的中位数，不择优挑样本。原始S2兼容超时仍未验证，未用双方同为30秒冒充通过。
- toxiproxy的timeout=0丢弃流内字节，移除时关闭TCP。原定S4/S5因此测量断流及重连；补充buffered场景更新latency而保留数据，单独证明积压恢复效果，不替代原定失败。
- 禁用WebGL会产生基线同样存在的 `WebGL2 not supported null`。高负载旧协议场景还出现既有渲染器 `undefined ... update` 错误，均保留在原始traffic.errors中；没有从结果中删除这些场景。
- 可见性回归使用浏览器visibility状态/事件注入并检查真实WebSocket断开/恢复；headless环境无法形成手机OS后台状态，因此没有声称做过手机实机后台测试。

## 未达标、无法确认及原因

| 项目 | 基线中位数 | 候选/混合中位数 | 结论与证据 |
|---|---:|---:|---|
| S5b/P0 | 728ms | 2209ms | 相对慢1481ms，未达标 |
| S5b/P1 | 1323ms | 2774ms | 相对慢1451ms，绝对8s上限通过 |
| S5b/P2 | 2874ms | 3904ms | 相对慢1030ms，绝对12s上限通过 |
| S5c/P0 | 726ms | 826ms | 相对慢100ms，未达标；100ms探测周期与重置时序会影响观测，三轮后仍不满足严格相对门槛 |
| 旧页面+新服务端 S4/P2 | 3174ms | 3559ms | 门槛3541.4ms，超17.6ms；有抖动但不放宽阈值 |
| 两个混合版本 S2/P1、P2 | p95≥30000ms | p95≥30000ms | 双方超时，只能判未验证 |

S5b的连接时间线支持退避累积解释：新版提前发现断流，尝试连接在15秒连接超时后继续退避；40秒恢复时代理关闭尚未完成的握手，随后按既定序列等待2秒，而基线首次重试只等0.5秒。例如第三轮P1恢复结束时间1791060060963，握手失败1791060060966，下次连接创建1791060062966（原始JSON内的毫秒时间戳）。

没有为了过门槛更改规定的500/1000/2000/3000/5000ms退避、稳定10秒清零规则或测试时长。允许调整的流控窗口/帧龄不能消除该2秒重连等待；修改断流发现时间也不能保证在任意恢复时刻不比存活的旧连接慢。需要在后续设计中明确是否允许改变重连策略或接受这类权衡，本次不擅自改变约定。补充buffered结果显著改善真实积压，但不能抹掉这些失败。

## 最终页面加载及流量

| 指标 | 基线 | 最终候选 |
|---|---:|---:|
| 冷加载正文 | 783893 bytes | 220243 bytes（28.1%） |
| P1 冷加载/刷新 | 6562/6487ms | 2156/272ms |
| P2 冷加载/刷新 | 25554/25283ms | 7584/1066ms |
| 刷新文档网络传输 | 784193 bytes | 300 bytes，CDP捕获304 |
| P0 刷屏60秒WS下行 | 10399970 bytes | 646075 bytes（6.21%） |
| P0 静止60秒WS下行 | 0 bytes | 252 bytes |
| 真实default会话5分钟SSE | 原协议门无法持续推送 | 101042 bytes，低于1MB护栏 |

304时浏览器encodedBodySize可能报告缓存正文长度，刷新字节按transferSize判断。表中WS字节包含应用前缀/控制消息，不含TCP/WS封装；不声称是网卡总流量。

## 功能回归清单

最终构建上执行。主记录为 `regression-1791061295146.json`；看板最终定向记录为 `regression-1791061461798.json`。plain/tmux刷屏与恢复的补充记录为 `regression-1791062292747.json`。第14项使用 `step1-verification.json` 的真实事件证据。

| # | 检查 | 结果/证据 |
|---|---|---|
| 1 | herdr打开、输入、回显 | ✓ 真实shell输出REG_HERDR，收到5帧 |
| 2 | 多行粘贴 | ✓ UI调用paste API返回200，两行输出可见 |
| 3 | Ctrl/Alt/Shift与方向键 | ✓ 真实PTY输入记录器核对三组转义字节 |
| 4 | 双指缩放与resize | ✓ 字号19，resize 32×30，与DOM行数一致 |
| 5 | 侧边栏切pane | ✓ URL目标变化，新pane输入回显 |
| 6 | 同pane接管，P0及P2刷屏 | ✓ 原页显示接管提示，7秒内不自动抢回，另有生命周期单测 |
| 7 | 隐藏/可见 | ✓ 注入visibility事件，真实WS关闭后重建并回显；非手机OS实机测试 |
| 8 | Detach | ✓ 基线和候选都关闭后自动重连，行为一致 |
| 9 | tmux连接/restore | ✓ 隔离t1/t2，刷新后恢复t2；100行/秒持续刷屏5秒，观察到step521，按键回显与Ctrl-C响应均成功 |
| 10 | plain shell | ✓ 输入回显；plain/tmux与刷屏验证共约7.1秒，只有deflate且无heartbeat |
| 11 | Git Diff面板 | ✓ 隔离临时git仓库显示真实修改正文，随后清理 |
| 12 | 图片粘贴上传 | ✓ API200，上传文件逐字节与PNG一致，随后删除 |
| 13 | goal/prompt看板 | ✓ HTTP200+gzip、成功加载状态及可见detail |
| 14 | SSE实时变化 | ✓ 新pane加入后207ms推送；基线15秒内未推送；订阅失败0 |
| 15 | 连接指示灯 | ✓ 连接/断开/恢复/接管状态的标识对应变化 |

看板初稿错误使用正文长度阈值，随后又要求移动端有意隐藏的刷新按钮可见；两次断言失败记录保留。最终检查等待「已加载/已同步」并验证可见detail，未修改产品页面来适配测试。

## 检查结果及既有问题

- `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、release构建通过。
- `cargo test --no-fail-fast`：131通过、1失败。失败是 `tmux_discovery::tests::isolated_tmux_discovers_moves_switches_windows_and_removes_sessions`，在基线已复现，见 `baseline-cargo-test.log`。未修无关代码，所有新增WS集成测试通过。
- 前端tsc、148个Vitest测试、生产构建通过；提交的dist与源码一致。
- `PORT=7702 bash scripts/smoke.sh`：debug build、clippy、前端检查、HTTP通过；Rust测试仍上述既有失败。smoke脚本退出0并不代表其打印的所有检查成功，未将人工清单打印输出冒充完成证据。
- 测试前未修改主工作区或7682进程；最终部署清理核验与唯一提交信息见外部DELIVERY.md。
- 依计划保留已有路径穿越、无鉴权、固定/tmp包装脚本、预测回显默认值等问题，不在本次扩大范围。没有新增依赖超出flate2/fflate/tokio-tungstenite(dev)/tower-http gzip feature。
