#!/bin/bash
# Local Terminal - Run ttyd directly on current machine with diff support
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load .env if exists
if [ -f "$SCRIPT_DIR/.env" ]; then
    source "$SCRIPT_DIR/.env"
fi

PORT="${PORT:-7681}"
DIFF_PORT="${DIFF_PORT:-7683}"
CMD="${1:-zsh}"
INDEX_FILE="$SCRIPT_DIR/ttyd-mobile/dist/index.html"
DIFF_SERVER="$SCRIPT_DIR/ttyd-mobile/diff-server.py"
CWD_FILE="/tmp/ttyd_cwd"
TTY_FILE="/tmp/ttyd_client_tty"

if ! command -v ttyd &>/dev/null; then
    echo "Error: ttyd not found. Install it first."
    exit 1
fi

if [ ! -f "$INDEX_FILE" ]; then
    echo "Error: dist/index.html not found. Run 'cd ttyd-mobile && npm run build' first."
    echo "Or use legacy UI: INDEX_FILE=ttyd-mobile/index.legacy.html ./local_terminal.sh"
    exit 1
fi

pkill -f "ttyd.*$PORT" 2>/dev/null || true
pkill -f "diff-server.py" 2>/dev/null || true
sleep 1

if [ -f "$DIFF_SERVER" ]; then
    nohup python3 "$DIFF_SERVER" $DIFF_PORT >/dev/null 2>&1 &
    sleep 1
fi

SHELL_INIT=""
if [[ "$CMD" == "zsh" ]] || [[ "$CMD" == *"zsh"* ]]; then
    SHELL_INIT="tty > $TTY_FILE 2>/dev/null; precmd() { echo \$PWD > $CWD_FILE; }; "
elif [[ "$CMD" == "bash" ]] || [[ "$CMD" == *"bash"* ]]; then
    SHELL_INIT="tty > $TTY_FILE 2>/dev/null; PROMPT_COMMAND='echo \$PWD > $CWD_FILE'; "
fi

if [ -n "$SHELL_INIT" ]; then
    WRAPPED_CMD="$CMD -c '${SHELL_INIT}exec $CMD'"
else
    WRAPPED_CMD="$CMD"
fi

nohup ttyd -W -p $PORT --index "$INDEX_FILE" zsh -c "tty > $TTY_FILE; exec $CMD" >/dev/null 2>&1 &
sleep 2

if ! pgrep -f "ttyd.*$PORT" >/dev/null 2>&1; then
    echo "Error: ttyd failed to start"
    exit 1
fi

echo ""
echo "=========================================="
echo "  Mobile Terminal Started!"
echo "=========================================="
echo ""
echo "  Command: $CMD"
echo "  Diff Server: http://127.0.0.1:$DIFF_PORT"
echo ""
echo "  Access URLs:"
if [[ "$OSTYPE" == "darwin"* ]]; then
    ifconfig | grep 'inet ' | grep -v '127.0.0.1' | awk '{print $2}' | while read ip; do
        echo "    http://$ip:$PORT"
    done
else
    hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | while read ip; do
        echo "    http://$ip:$PORT"
    done
fi
echo ""
echo "  Stop: pkill -f 'ttyd.*$PORT' && pkill -f 'diff-server.py'"
echo "=========================================="
