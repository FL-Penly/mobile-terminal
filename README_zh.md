[English](./README.md) | 简体中文

# Mobile Terminal

在手机上访问本地开发环境的终端，专为移动端优化的 Web Terminal。

**核心场景**：在手机上操作 Claude Code、OpenCode 等 AI 编程工具。

## 功能特性

- 移动端优化的虚拟键盘（ESC、Tab、Ctrl+C、方向键等）
- 可自定义的快捷命令按钮
- 长文本输入弹窗（解决手机输入不便的问题）
- Tmux 会话管理（断线重连不丢失上下文）
- Git Diff 查看器（语法高亮 + 变更导航）

## 选择适合你的方案

```
┌─────────────────────────────────────────────────────────────┐
│  你的手机能直接访问本地开发环境吗？                              │
│  （同一 WiFi / 本地有公网 IP / VPN 等）                        │
└─────────────────────────────────────────────────────────────┘
                    │
          ┌────────┴────────┐
          ▼                 ▼
        可以               不可以
          │                 │
          ▼                 ▼
   ┌──────────────┐   ┌─────────────────────────────────┐
   │ 方案一：本地直连 │   │  你有公网可访问的跳板机吗？         │
   │ local_terminal │   │  （云服务器 / 公司跳板机等）        │
   └──────────────┘   └─────────────────────────────────┘
                                    │
                          ┌────────┴────────┐
                          ▼                 ▼
                        有                 没有
                          │                 │
                          ▼                 ▼
                   ┌──────────────┐   ┌────────────────┐
                   │ 方案二：跳板机  │   │ 方案三：Cloudflare │
                   │ devbox_tunnel │   │ cloudflare_tunnel │
                   └──────────────┘   └────────────────┘
```

---

## 方案一：本地直连

**适用场景**：手机能直接访问本地开发环境（同一 WiFi、本地有公网 IP 等）

### 前置条件

1. 安装 ttyd
```bash
# macOS
brew install ttyd

# Ubuntu/Debian
sudo apt install ttyd

# 其他 Linux：下载二进制
# https://github.com/tsl0922/ttyd/releases
```

2. 安装 Python 3（用于 diff-server）

### 使用

```bash
./local_terminal.sh          # 默认启动 zsh
./local_terminal.sh bash     # 启动 bash
```

启动后，用手机访问终端输出的 URL（如 `http://192.168.1.100:7681`）

---

## 方案二：跳板机中转

**适用场景**：你有一台公网可访问的服务器（云服务器、公司跳板机等），手机能访问它

### 原理

```
本地开发环境 ──SSH反向隧道──▶ 跳板机 ◀── 手机访问
```

本地主动连接跳板机建立隧道，无需本地开放端口。

### 前置条件

**1. 跳板机要求**
- 有公网 IP 或手机可访问的地址
- 可以 SSH 登录

**2. 本地开发环境配置**

开启 SSH 服务：
```bash
# macOS: System Preferences → Sharing → Remote Login

# Linux
sudo systemctl enable ssh
sudo systemctl start ssh
```

**3. 配置 SSH 互信**

```bash
# 本地能 SSH 到跳板机（通常已配置好）
ssh user@跳板机IP

# 跳板机能 SSH 回本地（关键步骤）
# 把跳板机的公钥添加到本地
ssh user@跳板机IP "cat ~/.ssh/id_rsa.pub" >> ~/.ssh/authorized_keys

# 如果跳板机没有密钥，先生成
ssh user@跳板机IP "ssh-keygen -t rsa -N '' -f ~/.ssh/id_rsa"
```

**4. 配置 .env**

```bash
cp .env.example .env
```

编辑 `.env`：
```bash
DEV_HOST="your_user@跳板机IP"    # 如 zhangsan@10.0.0.100
MAC_USER="本地用户名"            # 如 zhangsan
```

### 使用

```bash
./devbox_tunnel_mobile.sh
```

启动后，用手机访问 `http://跳板机IP:7681`

---

## 方案三：Cloudflare Tunnel

**适用场景**：本地只有内网 IP，也没有公网跳板机

### 原理

```
本地开发环境 ──出站连接──▶ Cloudflare ◀── 手机通过域名访问
```

本地主动连接 Cloudflare，无需公网 IP，无需开放端口。

### 前置条件

**1. 安装 cloudflared**

```bash
# macOS
brew install cloudflared

# Linux
# https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
```

**2. 准备域名（二选一）**

**选项 A：使用自己的域名（推荐）**
- 在任意平台购买域名（阿里云、腾讯云、Namecheap 等）
- 将域名 DNS 托管到 Cloudflare（免费）

**选项 B：使用 Cloudflare 临时域名（免费测试）**
```bash
# 直接运行，会分配临时域名如 https://xxx-yyy.trycloudflare.com
cloudflared tunnel --url http://localhost:7681
```
注意：临时域名每次启动都会变化

**3. 创建 Tunnel（使用自己域名时）**

```bash
# 登录 Cloudflare
cloudflared tunnel login

# 创建 tunnel
cloudflared tunnel create my-terminal

# 将 tunnel 路由到你的子域名
cloudflared tunnel route dns my-terminal terminal.yourdomain.com
```

**4. 配置 .env**

```bash
cp .env.example .env
```

编辑 `.env`：
```bash
CF_TUNNEL_NAME="my-terminal"
CF_DOMAIN="terminal.yourdomain.com"
```

### 使用

```bash
./cloudflare_tunnel_mobile.sh
```

启动后，用手机访问 `https://你配置的域名`

---

## 附加功能

### 自定义命令按钮

工具栏的 ⚙️ 按钮可以：
- 显示/隐藏默认命令
- 添加自定义命令按钮

配置保存在浏览器 localStorage 中。

### Git Diff 查看器

点击右下角绿色按钮查看当前目录的 Git 变更。

为了让 Diff 功能追踪当前目录，需要在 Shell 配置中添加：

```bash
# zsh (~/.zshrc)
precmd() { echo $PWD > /tmp/ttyd_cwd; }

# bash (~/.bashrc)
PROMPT_COMMAND='echo $PWD > /tmp/ttyd_cwd'
```

### Tmux 会话管理

工具栏的 Tmux 按钮可以：
- 创建新 session
- 列出所有 session
- 快速 attach/kill

**为什么需要 Tmux？** 手机浏览器切后台时 WebSocket 会断开，重连后 ttyd 会启动新 shell。使用 Tmux 可以保持会话，重连后一键恢复。

---

## 配置说明

复制配置模板：
```bash
cp .env.example .env
```

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `PORT` | ttyd 端口 | 7681 |
| `DIFF_PORT` | diff-server 端口 | 7683 |
| `DEV_HOST` | 跳板机 SSH 地址 | - |
| `MAC_USER` | 本地用户名 | - |
| `CF_TUNNEL_NAME` | Cloudflare tunnel 名称 | - |
| `CF_DOMAIN` | Cloudflare 域名 | - |

---

## 文件结构

```
├── local_terminal.sh            # 方案一：本地直连
├── devbox_tunnel_mobile.sh      # 方案二：跳板机中转
├── cloudflare_tunnel_mobile.sh  # 方案三：Cloudflare Tunnel
├── .env.example                 # 配置模板
├── ttyd-mobile/
│   ├── index.html               # 移动端优化的终端 UI
│   └── diff-server.py           # Git Diff API 服务
```

---

## 依赖

| 依赖 | 用途 | 安装 |
|------|------|------|
| [ttyd](https://github.com/tsl0922/ttyd) | Web 终端 | `brew install ttyd` |
| Python 3 | diff-server | 系统自带 |
| [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) | Cloudflare Tunnel | `brew install cloudflared` |
| SSH | 跳板机方案 | 系统自带 |
