#!/bin/bash
# Dev Machine Tunnel - Access Mac terminal via dev machine reverse tunnel
# Requires: DEV_HOST, MAC_USER in .env
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load .env if exists
if [ -f "$SCRIPT_DIR/.env" ]; then
    source "$SCRIPT_DIR/.env"
fi

# Configuration (from .env or defaults)
DEV_HOST="${DEV_HOST:?Error: DEV_HOST not set. Please configure .env}"
MAC_USER="${MAC_USER:?Error: MAC_USER not set. Please configure .env}"
DEV_PORT="${DEV_PORT:-7681}"
TUNNEL_PORT="${TUNNEL_PORT:-22222}"
CMD="${1:-zsh}"

cleanup() {
    echo ""
    echo "Stopping services..."
    ssh "$DEV_HOST" "pkill -f 'ttyd.*$DEV_PORT'" 2>/dev/null || true
    pkill -f "ssh.*-R.*$TUNNEL_PORT" 2>/dev/null || true
    exit 0
}
trap cleanup SIGINT SIGTERM EXIT

echo "Checking dev machine setup..."
ssh "$DEV_HOST" "
    [ -f ~/ttyd ] || { curl -sL https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 -o ~/ttyd && chmod +x ~/ttyd; }
" || { echo "Failed to setup dev machine"; exit 1; }

scp -q "$SCRIPT_DIR/ttyd-mobile/index.html" "$DEV_HOST:~/ttyd-mobile.html"

ssh "$DEV_HOST" "pkill -f 'ttyd.*$DEV_PORT'" 2>/dev/null || true
pkill -f "ssh.*-R.*$TUNNEL_PORT" 2>/dev/null || true
sleep 1

echo "Establishing reverse tunnel..."
ssh -f -N -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
    -R $TUNNEL_PORT:localhost:22 "$DEV_HOST" || { echo "Failed to create tunnel"; exit 1; }
sleep 1

echo "Starting ttyd on dev machine..."
ssh "$DEV_HOST" "
    setsid ~/ttyd -W -p $DEV_PORT --index ~/ttyd-mobile.html \
        ssh -o StrictHostKeyChecking=no -p $TUNNEL_PORT $MAC_USER@localhost -t '$CMD' \
        </dev/null >/tmp/ttyd.log 2>&1 &
"
sleep 2

if ! ssh "$DEV_HOST" "pgrep -f 'ttyd.*$DEV_PORT'" >/dev/null 2>&1; then
    echo "Error: ttyd failed to start"
    ssh "$DEV_HOST" "cat /tmp/ttyd.log" 2>/dev/null
    exit 1
fi

DEV_IP=$(echo "$DEV_HOST" | cut -d'@' -f2)
echo ""
echo "=========================================="
echo "  Mobile Terminal Ready! (Dev Machine)"
echo "=========================================="
echo ""
echo "  Access:  http://$DEV_IP:$DEV_PORT"
echo "  Command: $CMD"
echo ""
echo "  Press Ctrl+C to stop"
echo "=========================================="
echo ""

while true; do
    if ! pgrep -f "ssh.*-R.*$TUNNEL_PORT" >/dev/null 2>&1; then
        echo "Tunnel disconnected, reconnecting..."
        ssh -f -N -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
            -R $TUNNEL_PORT:localhost:22 "$DEV_HOST" || true
    fi
    sleep 10
done
