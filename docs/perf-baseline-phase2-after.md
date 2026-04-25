# Performance Baseline — phase2-after

Captured: 2026-04-25T07:10:34Z
Host: Darwin GP7TX6XVXY 25.3.0 Darwin Kernel Version 25.3.0: Wed Jan 28 20:51:28 PST 2026; root:xnu-12377.91.3~2/RELEASE_ARM64_T6041 arm64
Rust: rustc 1.93.0 (254b59607 2026-01-19)
Server running during capture: yes

## Build & Size

| Metric | Value |
|---|---|
| `cargo build --release` time (s) | 1 |
| Binary size (KB) | 2488 |
| `server/src/main.rs` LOC | 6 |
| `server/src/lib.rs` LOC | 2966 |
| Full test suite duration (ms) | 2725 |

## HTTP API latency (ms, mean of N samples)

| Endpoint | mean | samples |
|---|---|---|
| GET /api/health | 1 | 30 |
| GET /api/cwd | 26 | 20 |
| GET /api/tmux/list | 31 | 20 |
| GET /api/tmux/pane-mode | 34 | 20 |

## p99 latency (ms over 100 samples)

| Endpoint | p99 |
|---|---|
| GET /api/health | 1 |

## Concurrency (total wall time for 50 parallel requests, ms)

| Endpoint | total (ms) |
|---|---|
| GET /api/health × 50 | 77 |
| GET /api/cwd × 50 | 433 |

## Notes

- This baseline is reproducible by running `./scripts/perf-baseline.sh --label <label>`.
- For PTY throughput / keystroke latency benchmarks, see `scripts/perf-pty.sh` (Phase 3).
- Concurrent metrics are particularly sensitive to handlers that block the Tokio
  runtime — large drops here after Phase 2 indicate the spawn_blocking refactor
  is working correctly.
