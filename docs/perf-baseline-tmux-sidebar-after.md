# Performance Baseline — tmux-sidebar-after

Captured: 2026-07-11T15:14:04Z
Host: Darwin GP7TX6XVXY 25.5.0 Darwin Kernel Version 25.5.0: Mon Apr 27 20:41:15 PDT 2026; root:xnu-12377.121.6~2/RELEASE_ARM64_T6041 arm64
Rust: rustc 1.93.0 (254b59607 2026-01-19)
Server running during capture: yes

## Build & Size

| Metric | Value |
|---|---|
| `cargo build --release` time (s) | 23 |
| Binary size (KB) | 2648 |
| `server/src/main.rs` LOC | 6 |
| `server/src/lib.rs` LOC | 3673 |
| Full test suite duration (ms) | 4659 |

## HTTP API latency (ms, mean of N samples)

| Endpoint | mean | samples |
|---|---|---|
| GET /api/health | 1 | 30 |
| GET /api/cwd | 21 | 20 |
| GET /api/tmux/list | 11 | 20 |
| GET /api/tmux/pane-mode | 20 | 20 |

## p99 latency (ms over 100 samples)

| Endpoint | p99 |
|---|---|
| GET /api/health | 3 |

## Concurrency (total wall time for 50 parallel requests, ms)

| Endpoint | total (ms) |
|---|---|
| GET /api/health × 50 | 80 |
| GET /api/cwd × 50 | 397 |

## Notes

- This baseline is reproducible by running `./scripts/perf-baseline.sh --label <label>`.
- For PTY throughput / keystroke latency benchmarks, see `scripts/perf-pty.sh` (Phase 3).
- Concurrent metrics are particularly sensitive to handlers that block the Tokio
  runtime — large drops here after Phase 2 indicate the spawn_blocking refactor
  is working correctly.
