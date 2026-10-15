# Rust Terminal

A mobile-optimized web terminal powered by a single Rust binary. Access your development terminal from your phone — operate AI coding tools like Claude Code, OpenCode on the go.

## Features

- Single Rust binary — zero external dependencies
- Mobile-optimized virtual keyboard (ESC, Tab, Ctrl+C, arrow keys)
- On-demand combination keys (Ctrl/Alt/Shift, letters, symbols, F1–F12)
- Expandable toolbar (▲/▼ toggle for narrow screens)
- Customizable quick command buttons
- Text input modal (easier long text input on mobile)
- Status bar (connection state, git branch, token count)
- Tmux session management (reconnect without losing context)
- Git Diff viewer (card-based, per-file hunk navigation)
- Git branch selector with checkout support
- Image paste and upload support
- Pinch-to-zoom with persistent font size
- Single-finger touch scroll in TUI apps (tmux, vim)
- iTerm2-style drag-to-select text in tmux
- Copy view for mobile: agent conversation blocks or unwrapped terminal lines
- Weak-network optimization: compressed pages/output, automatic retries, herdr heartbeats and stale-frame recovery
- Predictive echo for reduced input latency
- WebGL/Canvas accelerated rendering with auto-fallback

## Quick Start

```bash
# Build and run (first run compiles the Rust binary)
./run.sh

# Or specify a shell
./run.sh bash

# Custom port
PORT=8080 ./run.sh
```

After startup, access the URL shown in terminal output from your phone.

## Prerequisites

- Rust toolchain ([install](https://rustup.rs/))
- C compiler (`build-essential` on Ubuntu, Xcode CLI tools on macOS)
- tmux (recommended, for session persistence)

Node.js is **not** required — the frontend is pre-built and committed.

For detailed setup instructions (per-platform install commands, troubleshooting), see **[SETUP.md](SETUP.md)**.

## Architecture

```
Phone ──HTTP/WS──▶ Rust Server (:7682)
                    ├── WebSocket /ws     → PTY (terminal)
                    ├── GET /api/*        → Git, Tmux, CWD APIs
                    ├── POST /api/*       → Image upload
                    ├── GET /api/events   → SSE (status updates)
                    └── GET /*            → Static files (frontend)
```

Everything runs in a single process. No external dependencies at runtime.

## Configuration

```bash
cp .env.example .env
```

| Config | Description | Default |
|--------|-------------|---------|
| `PORT` | Server port | 7682 |

## Features Detail

### Weak Networks

Static pages use gzip and `Cache-Control: no-cache` with ETag revalidation, so reopening an unchanged page needs only a 304 response. Terminal output uses a connection-local raw-deflate stream when both ends support it; older pages and servers keep the original output protocol.

Connections retry indefinitely with backoffs of 0.5/1/2/3/5 seconds. If a connection fails before opening, time already spent connecting is deducted from the next backoff, down to zero; a connection that opened still waits the full backoff after disconnecting. Opening a socket has a 10/15/20 second timeout, and the retry count resets only after ten stable seconds. Retries pause in the background and resume when the page or network returns. Input is never queued for later replay.

In herdr mode, negotiated heartbeats detect approximately 15 seconds of silence. Acknowledgements cap stale output: under congestion, the server skips old differential frames and requests the latest full screen. Plain shell and tmux output is compressed without dropping bytes or adding a silence timeout. Herdr still releases its controller when the page is hidden. A takeover notice stops automatic reconnect until you explicitly take control again.

| Direction | Prefix | Payload |
|---|---|---|
| Client → server | none | Init JSON with optional `features: ["heartbeat", "deflate", "flow"]` |
| Client → server | `0` / `1` | Input bytes / resize JSON (unchanged) |
| Client → server | `2` / `3` | Pause / resume for plain/tmux (unchanged) |
| Client → server | `4` | `{"type":"ack","bytes":N}`; cumulative received `0`/`5` message lengths including prefixes |
| Server → client | `0` | Raw terminal output; error and close notices always use this prefix |
| Server → client | `4` | `hello`, herdr `heartbeat`, or `closed` control JSON |
| Server → client | `5` | Raw-deflate output with a sync flush per message |

The server sends hello before output only when it accepts a requested feature. Plain/tmux accepts only deflate; herdr accepts all three. Every mode also sends a standard WebSocket Ping every 30 seconds. See [the isolated weak-network harness](scripts/weaknet/README.md) for comparison measurements and reproduction commands.

Proactive reconnection can add recovery delay when a silent connection could otherwise survive an outage. See the [measured comparison and remaining acceptance failures](docs/weaknet-bench-20261004.md) before switching an existing service.

### Combination Keys

Open **组合键** next to the toolbar arrows when you need a shortcut. It replaces
the ordinary toolbar in the bottom area; **返回** restores the previous expanded
or collapsed toolbar. The terminal resizes above it instead of being covered.
Tap Ctrl,
Alt, or Shift, then a key **inside the panel**. Modifiers can be combined and stay
active until tapped again. You can also hold a modifier with one finger while
pressing another key. Panel arrows
and Backspace repeat while held.

For Shift+Left/Right: open the panel, select Shift, then use its arrow buttons
repeatedly; tap Shift again to release it. Letters, symbols, navigation keys, and F1–F12 are
available in the expandable rows. Existing toolbar shortcuts and text entry keep
their original behavior. Closing the panel, changing sessions, disconnecting, or
backgrounding the page clears modifier state.

The panel uses traditional xterm key sequences plus the existing Shift+Enter
compatibility sequence. Combinations requiring extended keyboard negotiation
(such as Ctrl+Shift+letter or Ctrl+Tab) are reported as unsupported instead of
silently sending a different shortcut. No input is queued for reconnection.

### Tmux Session Management

Tmux buttons in the status bar allow you to:
- Create new sessions
- Switch between sessions
- Detach to plain shell
- Kill sessions (long-press)

**Why Tmux?** Mobile browsers disconnect WebSocket when backgrounded. After reconnecting, a new shell starts. Using tmux preserves your session — just reattach after reconnection.

### Git Diff Viewer

Click the green "Diff" button in the toolbar to view Git changes in the current directory.

CWD tracking is set up automatically via the shell wrapper script. If you need manual setup:

```bash
# zsh (~/.zshrc)
precmd() { echo $PWD > /tmp/ttyd_cwd; }

# bash (~/.bashrc)
PROMPT_COMMAND='echo $PWD > /tmp/ttyd_cwd'
```

### Custom Command Buttons

The ⚙️ button in the toolbar allows you to:
- Show/hide default commands
- Add custom command buttons

Configuration is saved in browser localStorage.

### Copy View

The purple "Sel" button opens a full-screen copy view with two tabs:

- **对话 (conversation)** — for herdr panes running Claude Code or Codex. The server reads the agent's local session file (`~/.claude/projects/…` or `~/.codex/sessions/…`, found through herdr's `agent_session` or the pane's cwd) and shows your prompts, replies, code blocks and commands as cards. Tap cards to select several; code, commands, outputs and replies also have their own copy buttons. Older blocks load as you scroll up. When herdr reports the agent as blocked, a banner links to the terminal tab, because the pending confirmation is not in the session file. This is the default for agent panes.
- **终端 (terminal)** — logical lines with soft wraps joined (xterm `isWrapped`, tmux `capture-pane -J`, herdr `recent_unwrapped`), wrapped to the phone width. Drag up and down on the line-number gutter to select; dragging past an edge scrolls. After lifting your finger, drag the blue handles to adjust either end. Search and scroll-to-top paging of older history are kept.

The bottom sheet offers four formats (raw, prefixes stripped, Markdown, one line) and three actions: copy, quote the selection into the text input, or send "请解释或处理下面这段内容：…" to the agent and press Enter. The last action is disabled while the agent is blocked or when the pane is not running an agent. If the browser refuses clipboard access (common over plain HTTP), the text is shown pre-selected so you can copy it by hand.

## File Structure

```
├── run.sh               # Build & run script
├── .env.example         # Config template
├── server/
│   ├── Cargo.toml       # Rust dependencies
│   └── src/main.rs      # Unified server (WebSocket + HTTP API + static files)
└── frontend/
    ├── package.json     # Build dependencies
    ├── src/             # React + TypeScript source
    └── dist/            # Built frontend (served by Rust)
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/ws` | WebSocket | Terminal PTY connection |
| `/api/health` | GET | Health check |
| `/api/client-tty` | GET | Current client TTY |
| `/api/cwd` | GET | Current working directory |
| `/api/diff` | GET | Git diff data |
| `/api/git/branches` | GET | List branches |
| `/api/git/checkout` | GET | Checkout branch |
| `/api/tmux/list` | GET | List tmux sessions |
| `/api/tmux/switch` | GET | Switch tmux session |
| `/api/tmux/create` | GET | Create tmux session |
| `/api/tmux/kill` | GET | Kill tmux session |
| `/api/tmux/detach` | GET | Detach from tmux |
| `/api/tmux/page-up` | GET | Terminal history, `before` = rows already loaded (0 = newest) |
| `/api/herdr/page-up` | GET | Same for a herdr pane; never moves the live viewport for the newest rows |
| `/api/herdr/transcript` | GET | Agent conversation blocks for `pane`, paged with `before`/`session` |
| `/api/herdr/paste` | POST | Bracketed paste into a pane; `submit: true` also presses Enter |
| `/api/events` | GET | SSE status stream |
| `/api/upload-image` | POST | Upload image file |
