#!/usr/bin/env bash
# Capture performance baseline for rust-terminal.
# Run this before/after optimization phases and diff the output.
#
# Usage:
#   ./scripts/perf-baseline.sh          # default port 7682
#   PORT=8080 ./scripts/perf-baseline.sh
#   ./scripts/perf-baseline.sh --label phase2-after  # tag the run
#
# Output: docs/perf-baseline-<label>.md (markdown table)

set -euo pipefail

LABEL="${1:-baseline}"
if [[ "$LABEL" == "--label" ]]; then
  LABEL="$2"
fi

PORT="${PORT:-7682}"
HOST="http://127.0.0.1:${PORT}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/docs/perf-baseline-${LABEL}.md"

mkdir -p "${ROOT}/docs"

cd "${ROOT}/server"

build_release() {
  local start=$(date +%s)
  cargo build --release --quiet 2>&1 | tail -5
  local end=$(date +%s)
  echo $((end - start))
}

binary_size_kb() {
  local bin="${ROOT}/server/target/release/rust-terminal"
  if [[ -f "$bin" ]]; then
    du -k "$bin" | awk '{print $1}'
  else
    echo "0"
  fi
}

count_loc() {
  local file="$1"
  if [[ -f "$file" ]]; then
    wc -l < "$file" | tr -d ' '
  else
    echo "0"
  fi
}

run_tests_timed() {
  local start=$(date +%s%N)
  cargo test --quiet > /dev/null 2>&1 || true
  local end=$(date +%s%N)
  echo $(( (end - start) / 1000000 ))
}

is_running() {
  curl -fsS --max-time 2 "${HOST}/api/health" >/dev/null 2>&1
}

api_rtt_ms() {
  local path="$1"
  local n="${2:-20}"
  local total=0
  for ((i=0; i<n; i++)); do
    local t
    t=$(curl -fsS -o /dev/null -w '%{time_total}\n' "${HOST}${path}" 2>/dev/null || echo "0")
    local ms
    ms=$(awk "BEGIN { printf \"%.0f\", ${t} * 1000 }")
    total=$((total + ms))
  done
  echo $((total / n))
}

api_p99_ms() {
  local path="$1"
  local n="${2:-100}"
  local samples=()
  for ((i=0; i<n; i++)); do
    local t
    t=$(curl -fsS -o /dev/null -w '%{time_total}\n' "${HOST}${path}" 2>/dev/null || echo "0")
    samples+=("$(awk "BEGIN { printf \"%.0f\", ${t} * 1000 }")")
  done
  printf '%s\n' "${samples[@]}" | sort -n | awk -v n="$n" 'NR == int(n*0.99) { print; exit }'
}

concurrent_50_total_ms() {
  local path="$1"
  local start=$(date +%s%N)
  for ((i=0; i<50; i++)); do
    curl -fsS -o /dev/null --max-time 30 "${HOST}${path}" &
  done
  wait
  local end=$(date +%s%N)
  echo $(( (end - start) / 1000000 ))
}

echo "[baseline] capturing build + size + LOC..."
BUILD_S=$(build_release)
BIN_KB=$(binary_size_kb)
MAIN_LOC=$(count_loc "${ROOT}/server/src/main.rs")
LIB_LOC=$(count_loc "${ROOT}/server/src/lib.rs")
TEST_MS=$(run_tests_timed)

echo "[baseline] checking if server is running on ${HOST}..."
if is_running; then
  echo "[baseline] server is up, capturing API metrics..."
  HEALTH_RTT=$(api_rtt_ms "/api/health" 30)
  CWD_RTT=$(api_rtt_ms "/api/cwd" 20)
  TMUX_LIST_RTT=$(api_rtt_ms "/api/tmux/list" 20)
  PANE_MODE_RTT=$(api_rtt_ms "/api/tmux/pane-mode" 20)
  HEALTH_P99=$(api_p99_ms "/api/health" 100)
  CONC_HEALTH=$(concurrent_50_total_ms "/api/health")
  CONC_CWD=$(concurrent_50_total_ms "/api/cwd")
  RUNNING="yes"
else
  echo "[baseline] server NOT running — skipping live API metrics"
  HEALTH_RTT="n/a"
  CWD_RTT="n/a"
  TMUX_LIST_RTT="n/a"
  PANE_MODE_RTT="n/a"
  HEALTH_P99="n/a"
  CONC_HEALTH="n/a"
  CONC_CWD="n/a"
  RUNNING="no"
fi

cat > "$OUT" <<EOF
# Performance Baseline — ${LABEL}

Captured: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
Host: $(uname -a)
Rust: $(rustc --version 2>/dev/null || echo "unknown")
Server running during capture: ${RUNNING}

## Build & Size

| Metric | Value |
|---|---|
| \`cargo build --release\` time (s) | ${BUILD_S} |
| Binary size (KB) | ${BIN_KB} |
| \`server/src/main.rs\` LOC | ${MAIN_LOC} |
| \`server/src/lib.rs\` LOC | ${LIB_LOC} |
| Full test suite duration (ms) | ${TEST_MS} |

## HTTP API latency (ms, mean of N samples)

| Endpoint | mean | samples |
|---|---|---|
| GET /api/health | ${HEALTH_RTT} | 30 |
| GET /api/cwd | ${CWD_RTT} | 20 |
| GET /api/tmux/list | ${TMUX_LIST_RTT} | 20 |
| GET /api/tmux/pane-mode | ${PANE_MODE_RTT} | 20 |

## p99 latency (ms over 100 samples)

| Endpoint | p99 |
|---|---|
| GET /api/health | ${HEALTH_P99} |

## Concurrency (total wall time for 50 parallel requests, ms)

| Endpoint | total (ms) |
|---|---|
| GET /api/health × 50 | ${CONC_HEALTH} |
| GET /api/cwd × 50 | ${CONC_CWD} |

## Notes

- This baseline is reproducible by running \`./scripts/perf-baseline.sh --label <label>\`.
- For PTY throughput / keystroke latency benchmarks, see \`scripts/perf-pty.sh\` (Phase 3).
- Concurrent metrics are particularly sensitive to handlers that block the Tokio
  runtime — large drops here after Phase 2 indicate the spawn_blocking refactor
  is working correctly.
EOF

echo
echo "[baseline] wrote ${OUT}"
echo
cat "$OUT"
