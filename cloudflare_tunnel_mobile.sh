#!/bin/bash
# Cloudflare Tunnel - Access terminal via Cloudflare
# Requires: CF_TUNNEL_NAME, CF_DOMAIN in .env
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load .env if exists
if [ -f "$SCRIPT_DIR/.env" ]; then
    source "$SCRIPT_DIR/.env"
fi

# Configuration
CF_TUNNEL_NAME="${CF_TUNNEL_NAME:?Error: CF_TUNNEL_NAME not set. Please configure .env}"
CF_DOMAIN="${CF_DOMAIN:?Error: CF_DOMAIN not set. Please configure .env}"
PORT="${PORT:-7681}"
CMD="${1:-zsh}"

cleanup() {
    echo ""
    echo "Stopping services..."
    pkill -f "ttyd.*$PORT" 2>/dev/null || true
    pkill -f "cloudflared tunnel run" 2>/dev/null || true
    exit 0
}
trap cleanup SIGINT SIGTERM EXIT

pkill -f "ttyd.*$PORT" 2>/dev/null || true
pkill -f "cloudflared tunnel run" 2>/dev/null || true
sleep 1

echo "Starting mobile terminal..."
echo "Command: $CMD"
ttyd -W -p "$PORT" --index "$SCRIPT_DIR/ttyd-mobile/index.html" zsh -ic "$CMD" &
TTYD_PID=$!
sleep 1

echo "Starting Cloudflare Tunnel..."
cloudflared tunnel run "$CF_TUNNEL_NAME" &
TUNNEL_PID=$!
sleep 3

echo ""
echo "=========================================="
echo "  Mobile Terminal Ready!"
echo "=========================================="
echo ""
echo "  Local:   http://localhost:$PORT"
echo "  Remote:  https://$CF_DOMAIN"
echo ""
echo "  Command: $CMD"
echo ""
echo "  Press Ctrl+C to stop"
echo "=========================================="
echo ""

wait $TTYD_PID
