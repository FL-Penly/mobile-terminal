English | [简体中文](./README_zh.md)

# Mobile Terminal

Access your local development terminal from your phone. A mobile-optimized Web Terminal.

**Core Use Case**: Operate AI coding tools like Claude Code, OpenCode from your phone.

## Features

- Mobile-optimized virtual keyboard (ESC, Tab, Ctrl+C, arrow keys, etc.)
- Expandable toolbar (▲/▼ toggle for narrow screens)
- Customizable quick command buttons
- Text input modal (for easier long text input on mobile)
- Status bar (connection state, git branch, token count)
- Tmux session management (reconnect without losing context)
- Git Diff viewer (card-based, per-file hunk navigation)

## Choose Your Approach

```
┌─────────────────────────────────────────────────────────────┐
│  Can your phone directly access your local dev environment? │
│  (Same WiFi / Public IP / VPN, etc.)                        │
└─────────────────────────────────────────────────────────────┘
                    │
          ┌────────┴────────┐
          ▼                 ▼
         Yes                No
          │                 │
          ▼                 ▼
   ┌──────────────┐   ┌─────────────────────────────────┐
   │ Option 1:    │   │  Do you have a publicly         │
   │ Local Direct │   │  accessible jump server?        │
   │ local_terminal│   │  (Cloud server, etc.)          │
   └──────────────┘   └─────────────────────────────────┘
                                    │
                          ┌────────┴────────┐
                          ▼                 ▼
                        Yes                 No
                          │                 │
                          ▼                 ▼
                   ┌──────────────┐   ┌────────────────┐
                   │ Option 2:    │   │ Option 3:      │
                   │ Jump Server  │   │ Cloudflare     │
                   │ devbox_tunnel│   │ cloudflare_tunnel│
                   └──────────────┘   └────────────────┘
```

---

## Option 1: Local Direct Connection

**Use Case**: Your phone can directly access your local dev environment (same WiFi, public IP, etc.)

### Prerequisites

1. Install ttyd
```bash
# macOS
brew install ttyd

# Ubuntu/Debian
sudo apt install ttyd

# Other Linux: download binary
# https://github.com/tsl0922/ttyd/releases
```

2. Install Python 3 (for diff-server)

### Usage

```bash
./local_terminal.sh          # default: start zsh
./local_terminal.sh bash     # start bash
```

After startup, access the URL shown in terminal output (e.g., `http://192.168.1.100:7681`) from your phone.

---

## Option 2: Jump Server Relay

**Use Case**: You have a publicly accessible server (cloud server, company jump server, etc.)

### How It Works

```
Local Dev Environment ──SSH Reverse Tunnel──▶ Jump Server ◀── Phone Access
```

Your local machine initiates the connection to the jump server. No inbound ports needed locally.

### Prerequisites

**1. Jump Server Requirements**
- Has a public IP or is accessible from your phone
- SSH access available

**2. Local Dev Environment Setup**

Enable SSH service:
```bash
# macOS: System Preferences → Sharing → Remote Login

# Linux
sudo systemctl enable ssh
sudo systemctl start ssh
```

**3. Configure SSH Trust**

```bash
# Verify you can SSH to jump server (usually already set up)
ssh user@jump-server-ip

# Add jump server's public key to local machine (critical step)
ssh user@jump-server-ip "cat ~/.ssh/id_rsa.pub" >> ~/.ssh/authorized_keys

# If jump server has no key, generate one first
ssh user@jump-server-ip "ssh-keygen -t rsa -N '' -f ~/.ssh/id_rsa"
```

**4. Configure .env**

```bash
cp .env.example .env
```

Edit `.env`:
```bash
DEV_HOST="your_user@jump-server-ip"    # e.g., zhangsan@10.0.0.100
MAC_USER="local_username"               # e.g., zhangsan
```

### Usage

```bash
./devbox_tunnel_mobile.sh
```

After startup, access `http://jump-server-ip:7681` from your phone.

---

## Option 3: Cloudflare Tunnel

**Use Case**: No public IP locally, no jump server available

### How It Works

```
Local Dev Environment ──Outbound Connection──▶ Cloudflare ◀── Phone via Domain
```

Your local machine connects outbound to Cloudflare. No public IP needed, no ports to open.

### Prerequisites

**1. Install cloudflared**

```bash
# macOS
brew install cloudflared

# Linux
# https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
```

**2. Prepare Domain (choose one)**

**Option A: Use Your Own Domain (Recommended)**
- Purchase a domain from any registrar (Namecheap, GoDaddy, etc.)
- Transfer DNS to Cloudflare (free)

**Option B: Use Cloudflare Temporary Domain (Free for Testing)**
```bash
# Run directly, will assign a temporary domain like https://xxx-yyy.trycloudflare.com
cloudflared tunnel --url http://localhost:7681
```
Note: Temporary domain changes on each restart.

**3. Create Tunnel (when using your own domain)**

```bash
# Login to Cloudflare
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create my-terminal

# Route tunnel to your subdomain
cloudflared tunnel route dns my-terminal terminal.yourdomain.com
```

**4. Configure .env**

```bash
cp .env.example .env
```

Edit `.env`:
```bash
CF_TUNNEL_NAME="my-terminal"
CF_DOMAIN="terminal.yourdomain.com"
```

### Usage

```bash
./cloudflare_tunnel_mobile.sh
```

After startup, access `https://your-configured-domain` from your phone.

---

## Additional Features

### Custom Command Buttons

The ⚙️ button in the toolbar allows you to:
- Show/hide default commands
- Add custom command buttons

Configuration is saved in browser localStorage.

### Git Diff Viewer

Click the green button in the bottom-right corner to view Git changes in the current directory.

To enable directory tracking for the Diff feature, add to your shell config:

```bash
# zsh (~/.zshrc)
precmd() { echo $PWD > /tmp/ttyd_cwd; }

# bash (~/.bashrc)
PROMPT_COMMAND='echo $PWD > /tmp/ttyd_cwd'
```

### Tmux Session Management

Tmux buttons in the toolbar allow you to:
- Create new sessions
- List all sessions
- Quick attach/kill

**Why Tmux?** Mobile browsers disconnect WebSocket when backgrounded. After reconnecting, ttyd starts a new shell. Using Tmux preserves your session - just reattach after reconnection.

---

## Configuration

Copy the config template:
```bash
cp .env.example .env
```

| Config | Description | Default |
|--------|-------------|---------|
| `PORT` | ttyd port | 7681 |
| `DIFF_PORT` | diff-server port | 7683 |
| `DEV_HOST` | Jump server SSH address | - |
| `MAC_USER` | Local username | - |
| `CF_TUNNEL_NAME` | Cloudflare tunnel name | - |
| `CF_DOMAIN` | Cloudflare domain | - |

---

## File Structure

```
├── local_terminal.sh            # Option 1: Local direct
├── devbox_tunnel_mobile.sh      # Option 2: Jump server relay
├── cloudflare_tunnel_mobile.sh  # Option 3: Cloudflare Tunnel
├── .env.example                 # Config template
├── ttyd-mobile/
│   ├── dist/index.html          # Built terminal UI (single-file)
│   ├── src/                     # React + TypeScript source
│   ├── diff-server.py           # Git Diff API service
│   └── package.json             # Build dependencies
```

---

## Legacy UI

The original single-file UI is preserved at `ttyd-mobile/index.legacy.html` for rollback purposes.

To rollback to the legacy UI:
```bash
cp ttyd-mobile/index.legacy.html ttyd-mobile/dist/index.html
```

---

## Dependencies

| Dependency | Purpose | Install |
|------------|---------|---------|
| [ttyd](https://github.com/tsl0922/ttyd) | Web terminal | `brew install ttyd` |
| Python 3 | diff-server | Usually pre-installed |
| [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) | Cloudflare Tunnel | `brew install cloudflared` |
| SSH | Jump server option | Usually pre-installed |
