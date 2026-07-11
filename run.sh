#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -f "$SCRIPT_DIR/.env" ]; then
    source "$SCRIPT_DIR/.env"
fi

PORT="${PORT:-7682}"
CMD="${1:-zsh}"
BINARY="$SCRIPT_DIR/server/target/release/rust-terminal"
FRONTEND_DIST="$SCRIPT_DIR/frontend/dist/index.html"

if [ ! -f "$FRONTEND_DIST" ] || [ -n "$(find \
    "$SCRIPT_DIR/frontend/src" \
    "$SCRIPT_DIR/frontend/package.json" \
    "$SCRIPT_DIR/frontend/package-lock.json" \
    "$SCRIPT_DIR/frontend/tsconfig.json" \
    "$SCRIPT_DIR/frontend/vite.config.ts" \
    "$SCRIPT_DIR/frontend/tailwind.config.js" \
    -newer "$FRONTEND_DIST" -print -quit 2>/dev/null)" ]; then
    echo "Building frontend..."
    cd "$SCRIPT_DIR/frontend" && npm run build
fi

if [ ! -f "$BINARY" ] || [ -n "$(find \
    "$SCRIPT_DIR/server/src" \
    "$SCRIPT_DIR/server/Cargo.toml" \
    "$SCRIPT_DIR/server/Cargo.lock" \
    -newer "$BINARY" -print -quit 2>/dev/null)" ]; then
    echo "Building Rust backend..."
    cd "$SCRIPT_DIR/server" && cargo build --release
fi

pkill -f "rust-terminal.*--port $PORT" 2>/dev/null || true
sleep 1

nohup "$BINARY" \
    --port "$PORT" \
    --shell "$CMD" \
    --static-dir "$SCRIPT_DIR/frontend/dist" \
    >/dev/null 2>&1 &

sleep 2

if ! pgrep -f "rust-terminal.*--port $PORT" >/dev/null 2>&1; then
    echo "Error: rust-terminal failed to start"
    exit 1
fi

echo ""
echo "=========================================="
echo "  Rust Terminal Started!"
echo "=========================================="
echo ""
echo "  Command: $CMD"
echo "  Port: $PORT"
echo ""
echo "  Access URLs:"
echo "    http://localhost:$PORT"
{ ifconfig 2>/dev/null | grep 'inet ' | awk '{print $2}'; \
  ip addr 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1; } \
  | grep -v '127.0.0.1' | sort -u | while read ip; do
    echo "    http://$ip:$PORT"
done
echo ""
echo "  Stop: pkill -f 'rust-terminal.*--port $PORT'"
echo "=========================================="
