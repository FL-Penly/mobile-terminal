# 弱网测试台

用真实 Chrome 页面与隔离的 herdr pane 比较基线、新版和两个混合版本。不要运行 `benchmarks/*.js`，那些脚本默认访问线上 7682。

## 依赖和准备

- 基线 checkout 的 release 二进制与 dist；候选 worktree 的 release 二进制与最新 dist。
- Node 22、Python 3、herdr、tmux、Chrome。
- 全局 `@playwright/cli` 中的 playwright-core；可用 `PLAYWRIGHT_CORE_PATH` 指定其目录。
- 官方 toxiproxy **v2.12.0** 的 server/cli，校验 release `checksums.txt` 后放入 `~/.local/share/mt-weaknet/bin/`。二进制不提交进仓库。
- 默认候选目录 `~/project/mobile-terminal-weaknet`，基线 `~/project/mobile-terminal-baseline`；可用 `MT_WEAKNET_ROOT` / `MT_BASELINE_ROOT` 覆盖。`MT_WEAKNET_STATE` 可覆盖日志/进程清单目录，`CHROME_PATH` 可覆盖浏览器路径。

```bash
bash scripts/weaknet/setup.sh
node scripts/weaknet/bench.mjs --output="$HOME/.local/share/mt-weaknet/logs/matrix.json"
bash scripts/weaknet/teardown.sh
```

可以只运行指定组合和场景（端口只允许 7701–7704）：

```bash
node scripts/weaknet/bench.mjs --ports=7702 --profiles=P2 --scenes=S2,S3,S4
```

四个实例都只连接 `mtbench` herdr 会话。环境变量分别为：

- `HERDR_BIN_PATH`：包装器调用 `herdr --session mtbench`。
- `HERDR_SOCKET_PATH`：`~/.config/herdr/sessions/mtbench/herdr.sock`，隔离列表与事件订阅。
- `RUST_TERMINAL_TMUX_SOCKET=mtbench`：隔离 tmux 探测、attach 和操作。
- tty/cwd 路径保持默认，使生成的固定 `/tmp` 包装脚本与线上一致。

`setup.sh` 拒绝覆盖已占用端口。PID、启动 ticks、命令和 pane 映射写入 `bench-state.json`；`teardown.sh` 校验进程身份后停止测试进程，再停止/删除 `mtbench` herdr 会话和 tmux server。它不处理 7682 或 7692。不要在测试正在运行时调用 teardown，也不要并行运行两个 bench。

| 原点 | 服务端 | 页面 | 浏览器访问的代理 |
|---|---|---|---|
| 7701 | 基线 | 基线 | 7711 |
| 7702 | 候选 | 候选 | 7712 |
| 7703 | 候选 | 基线 | 7713 |
| 7704 | 基线 | 候选 | 7714 |

## 测量口径

上下行同时施加 P0=25ms；P1=150±50ms、128KB/s；P2=400±150ms、32KB/s。代理管理 API 只监听 127.0.0.1:8474。每个场景创建新的浏览器 context，阻止 Service Worker，视口 390×844，禁用 GPU/WebGL 并预检 `.xterm-rows`。场景间重建代理，避免 toxiproxy v2.12.0 在仍在关闭的连接上连续删改 toxic 时的已观察到的 panic。

模拟器每秒输出 100 行约 100 字符的彩色日志，更新 spinner，读到 `k<id>.` 输出 `ECHO <id>`；SIGINT 输出 `STOPPED`。准备模拟器和清场使用隔离 pane CLI，所有被测键盘输入与 Ctrl-C 都经过实际页面和 WebSocket。DOM MutationObserver 记录首次回显，避免短暂文本在两次采样之间消失。

- S1：PerformanceNavigationTiming 的文档 encodedBodySize、transferSize、耗时；同 context 刷新，并记录 CDP 的真实 304。304 时 encodedBodySize 可能是缓存正文长度，应以 transferSize 判断网络传输量。
- S2：刷屏稳定 5s 后，20 次输入探测，各次之后间隔 1s，单次上限 30s；报告 p50/p95/max 及超时数。超时值是下界，不视作成功样本。
- S3：5 次 Ctrl-C，每次都重新启动模拟器并稳定 5s；记录 STOPPED 首次进入 DOM 的时间。
- S4：timeout=0 toxic 断流 10s；移除后每 20ms 一个唯一探测，记录首个成功回显及期间 WS 字节。恢复最多观测 120s，超时如实标记。
- S5a/S5b：分别静止和刷屏，断流 40s，记录遮罩发现延迟和恢复回显。S5c 使用 reset_peer 中断 1s。
- S7：P0 下刷屏 60s、静止 60s 的 WS 下行字节。

WS 字节按实际收到的二进制消息长度累计，包含前缀和控制消息，不包含 TCP/TLS/WS 封装开销。原始 JSON 逐场景落盘，任何异常和超时都保留。

**工具限制：**v2.12.0 的 timeout toxic 丢弃流内数据，移除时会关闭 TCP，所以指定的 S4/S5 主要覆盖断流及重连。报告还须用保留数据的 latency 暂停场景验证积压恢复，不能仅凭 timeout 测试声称跳帧有效。

## 回归与复测

```bash
node scripts/weaknet/regression.mjs
node scripts/weaknet/bench.mjs --ports=7701,7702 --profiles=P1,P2 --scenes=S4-buffered,S5a-buffered,S5b-buffered
python3 scripts/weaknet/report.py <matrix.json> <paired-rerun.json> --exclude=<excluded-runs.json> --output=<report.md>
```

`regression.mjs --only=11,12` 可定向复核 Git diff 和图片上传；完整回归覆盖终端操作、接管、隐藏恢复、Detach、plain/tmux（含100行/秒刷屏下回显、Ctrl-C与session恢复）和静态看板。隐藏/恢复由浏览器事件注入驱动真实 WebSocket，不代表手机 OS 实机后台测试。SSE 的真实状态推送与 default 只读流量护栏需另附记录。

`buffered` 场景把已存在的 latency 暂时改为 60000ms 再恢复；保留原有带宽限制和流内数据，用于测量 TCP 积压，不替代原定的 timeout 场景。每次场景重置探测序号，使用相同长度的探测输入，并记录 WebSocket 创建、握手、关闭与网络恢复时间戳。

同一场景最多三轮有效测量，取中位数；错误或污染记录必须保留原始数据并显式说明排除原因。报告对双方均超时的比较标记未验证。bench 与 regression 共用 PID/启动时间互斥锁；异常失败返回非零退出码，teardown 拒绝清理仍有运行器的测试台。

## DIRECTIVE 终版测量

恢复探测从100ms改为20ms，B指定33格固定三轮取中位数，旧口径仅作附录，不混入新结果，也不追加轮次。S2/S3/S7仍使用rate100。

S2u是两个混合版本P1/P2的授权补充判定：在7701/P0按100、80、60、50、40、30、25、20、15、12、10、8、6、5、4、3、2、1粗网格，稳定5秒、采样10秒，再逐整数细化，所选值独立采样20秒确认。按1000字节/KB，上限为P1 89600B/s、P2 22400B/s；本次确认rate分别为29和7。CAL使用单调时钟并保证满采样窗口。原饱和S2双侧超时记录继续保留。

```bash
python3 scripts/weaknet/calibrate.py
node scripts/weaknet/bench.mjs --ports=7701,7702,7703,7704 --profiles=P1,P2 --scenes=S2u --rates-file="$HOME/.local/share/mt-weaknet/logs/directive-c-rates.json"
```

校准脚本拒绝覆盖既有结果；独立复现时使用新的MT_WEAKNET_STATE并重新setup。本次授权的测量已结束，不得为了更好结果重复运行。

报告通过`--s2u-compat`显式启用四格替换，拒绝把缺失、速率不同或候选超时判成通过。终版精确输入清单为`docs/weaknet-bench-20261004/directive-report-inputs.json`，排除清单为同目录`directive-excluded-runs.json`。可在临时文件重建量化表（不覆盖完整报告的说明章节）：

```bash
python3 - <<'PYCODE'
import json, pathlib, subprocess
p = pathlib.Path('docs/weaknet-bench-20261004')
inputs = json.loads((p / 'directive-report-inputs.json').read_text())
subprocess.run(['python3', 'scripts/weaknet/report.py', *[str(p / name) for name in inputs], '--s2u-compat', '--exclude', str(p / 'directive-excluded-runs.json'), '--output', '/tmp/weaknet-recomputed.md'], check=True)
PYCODE
```
