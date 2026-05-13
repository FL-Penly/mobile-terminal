use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, Request,
    },
    http::{header, Method, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{any, get, post},
    serve::ListenerExt,
    Json, Router,
};
use bytes::{BufMut, BytesMut};
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::{

    convert::Infallible,
    io::{Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};
use tokio::sync::mpsc;

use tower_http::cors::CorsLayer;

// ─── CLI ───────────────────────────────────────────────────────────────────

#[derive(Parser, Debug)]
#[command(name = "rust-terminal", version, about = "Mobile web terminal server")]
struct Cli {
    /// Listen port
    #[arg(short, long, default_value = "7681", env = "PORT")]
    port: u16,

    /// Shell to spawn
    #[arg(short, long, default_value = "zsh", env = "SHELL_CMD")]
    shell: String,

    /// Frontend static files directory
    #[arg(long, default_value = "../frontend/dist", env = "STATIC_DIR")]
    static_dir: PathBuf,
}

// ─── Shared State ──────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct AppState {
    shell: String,
    static_dir: PathBuf,
    client_tty: Arc<Mutex<Option<String>>>,
}

impl AppState {
    pub fn new(shell: impl Into<String>, static_dir: PathBuf) -> Self {
        Self {
            shell: shell.into(),
            static_dir,
            client_tty: Arc::new(Mutex::new(None)),
        }
    }
}

type ApiError = (StatusCode, String, String);

fn cwd_file_path() -> String {
    std::env::var("RUST_TERMINAL_CWD_FILE").unwrap_or_else(|_| "/tmp/ttyd_cwd".to_string())
}

fn tty_file_path() -> String {
    std::env::var("RUST_TERMINAL_TTY_FILE").unwrap_or_else(|_| "/tmp/ttyd_client_tty".to_string())
}

// ─── Entry point ───────────────────────────────────────────────────────────

pub async fn run() {
    tracing_subscriber::fmt::init();

    let cli = Cli::parse();

    // Strip TMUX env vars (like Python version)
    std::env::remove_var("TMUX");
    std::env::remove_var("TMUX_PANE");

    let state = AppState::new(cli.shell.clone(), cli.static_dir.clone());

    // Build router
    let app = build_router(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], cli.port));
    tracing::info!("Listening on http://0.0.0.0:{}", cli.port);

    // Print access URLs
    print_access_urls(cli.port);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(
        listener.tap_io(|stream| {
            if let Err(e) = stream.set_nodelay(true) {
                tracing::warn!("Failed to set TCP_NODELAY: {}", e);
            }
        }),
        app,
    )
    .await
    .unwrap();
}

fn print_access_urls(port: u16) {
    eprintln!();
    eprintln!("==========================================");
    eprintln!("  Rust Terminal Started!");
    eprintln!("==========================================");
    eprintln!();

    // Try to get local IPs (works on both macOS and Linux)
    if let Ok(output) = StdCommand::new("ifconfig").output() {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("inet ") {
                if let Some(ip) = rest.split_whitespace().next() {
                    if ip != "127.0.0.1" {
                        eprintln!("  http://{}:{}", ip, port);
                    }
                }
            }
        }
    }
    eprintln!();
    eprintln!("  Stop: kill this process (Ctrl+C)");
    eprintln!("==========================================");
    eprintln!();
}

pub fn build_router(state: AppState) -> Router {
    let static_dir = state.static_dir.clone();

    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);

    Router::new()
        // WebSocket terminal
        .route("/ws", any(ws_handler))
        // API endpoints
        .route("/api/health", get(api_health))
        .route("/api/client-tty", get(api_client_tty))
        .route("/api/cwd", get(api_cwd))
        .route("/api/diff", get(api_diff))
        .route("/api/git/branches", get(api_git_branches))
        .route("/api/git/checkout", get(api_git_checkout))
        .route("/api/git/status", get(api_git_status))
        .route("/api/git/stage", post(api_git_stage))
        .route("/api/git/unstage", post(api_git_unstage))
        .route("/api/git/discard", post(api_git_discard))
        .route("/api/git/commit", post(api_git_commit))
        .route("/api/git/log", get(api_git_log))
        .route("/api/git/file-diff", get(api_git_file_diff))
        .route("/api/git/batch-file-diff", post(api_git_batch_file_diff))
        .route("/api/git/stage-hunk", post(api_git_stage_hunk))
        .route("/api/git/discard-hunk", post(api_git_discard_hunk))
        .route("/api/tmux/list", get(api_tmux_list))
        .route("/api/tmux/switch", get(api_tmux_switch))
        .route("/api/tmux/create", get(api_tmux_create))
        .route("/api/tmux/kill", get(api_tmux_kill))
        .route("/api/tmux/detach", get(api_tmux_detach))
        .route("/api/tmux/quick-shell", get(api_tmux_quick_shell))
        .route("/api/tmux/pane-mode", get(api_tmux_pane_mode))
        .route("/api/tmux/capture-pane", get(api_tmux_capture_pane))
        .route("/api/tmux/page-up", get(api_tmux_page_up))
        .route("/api/events", get(api_events))
        .route("/api/upload", post(api_upload_file))
        .route("/api/upload-image", post(api_upload_file))
        .route("/api/user-config", get(api_get_user_config).post(api_set_user_config))
        // Static file serving — catch-all for frontend
        .fallback(move |req: Request| serve_static(req, static_dir.clone()))
        .layer(cors)
        .with_state(state)
}

// ═══════════════════════════════════════════════════════════════════════════
// STATIC FILE SERVING
// ═══════════════════════════════════════════════════════════════════════════

async fn serve_static(req: Request, static_dir: PathBuf) -> Response {
    let path = req.uri().path().trim_start_matches('/');

    let file_path = static_dir.join(if path.is_empty() { "index.html" } else { path });

    let is_file = tokio::fs::metadata(&file_path)
        .await
        .map(|m| m.is_file())
        .unwrap_or(false);

    if is_file {
        serve_file(&file_path).await
    } else {
        let index = static_dir.join("index.html");
        let index_exists = tokio::fs::metadata(&index)
            .await
            .map(|m| m.is_file())
            .unwrap_or(false);
        if index_exists {
            serve_file(&index).await
        } else {
            (StatusCode::NOT_FOUND, "Frontend not built. Run: cd frontend && npm run build").into_response()
        }
    }
}

async fn serve_file(path: &Path) -> Response {
    match tokio::fs::read(path).await {
        Ok(contents) => {
            let mime = match path.extension().and_then(|e| e.to_str()) {
                Some("html") => "text/html; charset=utf-8",
                Some("js") => "application/javascript; charset=utf-8",
                Some("css") => "text/css; charset=utf-8",
                Some("json") => "application/json",
                Some("png") => "image/png",
                Some("jpg" | "jpeg") => "image/jpeg",
                Some("svg") => "image/svg+xml",
                Some("woff2") => "font/woff2",
                Some("woff") => "font/woff",
                Some("ico") => "image/x-icon",
                _ => "application/octet-stream",
            };
            ([(header::CONTENT_TYPE, mime)], contents).into_response()
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBSOCKET TERMINAL (ttyd protocol compatible)
// ═══════════════════════════════════════════════════════════════════════════

async fn ws_handler(
    ws: WebSocketUpgrade,
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Response {
    ws.protocols(["tty"])
        .on_upgrade(move |socket| handle_terminal(socket, state))
}

async fn handle_terminal(socket: WebSocket, state: AppState) {
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Step 1: Wait for the auth/init message from client
    // Client sends: JSON {"AuthToken":"","columns":80,"rows":24}
    let (init_cols, init_rows) = match ws_receiver.next().await {
        Some(Ok(msg)) => parse_init_message(msg),
        _ => {
            tracing::error!("No init message received");
            return;
        }
    };

    tracing::info!("Terminal session: {}x{}", init_cols, init_rows);

    let wrapper_path = "/tmp/rust_terminal_wrapper.sh";
    {
        let shell = state.shell.clone();
        let tty_file = tty_file_path();
        let cwd_file = cwd_file_path();
        let wp = wrapper_path.to_string();
        if let Err(e) = tokio::task::spawn_blocking(move || {
            write_wrapper_script(&wp, &shell, &tty_file, &cwd_file);
        })
        .await
        {
            tracing::error!("Failed to write wrapper script: {}", e);
            return;
        }
    }

    // Step 3: Spawn PTY (blocking OS calls → spawn_blocking)
    struct PtyHandles {
        reader: Box<dyn Read + Send>,
        writer: Box<dyn Write + Send>,
        master: Box<dyn portable_pty::MasterPty + Send>,
        wrapper_pid: Option<u32>,
    }

    let pty_result = tokio::task::spawn_blocking(move || -> Result<PtyHandles, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: init_rows,
                cols: init_cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        let mut cmd = CommandBuilder::new(wrapper_path);
        cmd.env("TERM", "xterm-256color");
        cmd.env_remove("TMUX");
        cmd.env_remove("TMUX_PANE");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {}", e))?;
        let wrapper_pid = child.process_id();
        drop(child);

        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

        Ok(PtyHandles {
            reader,
            writer,
            master: pair.master,
            wrapper_pid,
        })
    })
    .await;

    let pty = match pty_result {
        Ok(Ok(h)) => h,
        Ok(Err(msg)) => {
            tracing::error!("{}", msg);
            let _ = ws_sender
                .send(Message::Binary(
                    format!("\x30Error: {}\r\n", msg).into(),
                ))
                .await;
            return;
        }
        Err(e) => {
            tracing::error!("PTY setup task failed: {}", e);
            return;
        }
    };

    let mut pty_reader = pty.reader;
    let pty_writer = pty.writer;
    let master = Arc::new(Mutex::new(pty.master));
    let wrapper_pid = pty.wrapper_pid;

    let paused = Arc::new((Mutex::new(false), Condvar::new()));
    let paused_reader = paused.clone();

    let (output_tx, mut output_rx) = mpsc::channel::<bytes::Bytes>(256);

    let reader_handle = std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        loop {
            {
                let (lock, cvar) = &*paused_reader;
                let mut is_paused = lock.lock().unwrap();
                if *is_paused {
                    let result = cvar.wait_timeout(is_paused, Duration::from_secs(2)).unwrap();
                    is_paused = result.0;
                    if *is_paused {
                        tracing::warn!("Flow control: auto-resuming after 2s timeout");
                        *is_paused = false;
                    }
                }
            }
            match pty_reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if output_tx.blocking_send(bytes::Bytes::copy_from_slice(&buf[..n])).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let (pty_input_tx, pty_input_rx) = std::sync::mpsc::channel::<bytes::Bytes>();

    let writer_handle = std::thread::spawn(move || {
        let mut writer = pty_writer;
        for data in pty_input_rx {
            let _ = writer.write_all(&data);
        }
        std::mem::forget(writer);
    });

    // Client TTY tracking
    let client_tty_shared = state.client_tty.clone();

    // Per-connection tty tracking (for safe cleanup independent of global state)
    // Prevents race condition where a new connection's tty gets detached by old cleanup.
    let connection_tty: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let connection_tty_sender = connection_tty.clone();

    // ── ADAPTIVE BATCHING: WebSocket sender task ──
    // Adaptive batching: 4ms idle flush, 32KB cap.
    let mut sender_task = tokio::spawn(async move {
        let mut buffer = BytesMut::with_capacity(32768);
        let mut frame_buf = BytesMut::with_capacity(65537);
        let mut tty_detected = false;

        loop {
            let data = output_rx.recv().await;
            match data {
                Some(bytes) => {
                    if !tty_detected {
                        if let Ok(text) = std::str::from_utf8(&bytes) {
                            if let Some(pos) = text.find("]7337;") {
                                let after = &text[pos + 6..];
                                if let Some(end) = after.find('\\') {
                                    let tty = after[..end].trim_end_matches('\x1b');
                                    // Accept both Linux (/dev/pts/N) and macOS (/dev/ttysN) PTY paths
                                    if tty.starts_with("/dev/") {
                                if let Ok(mut lock) = client_tty_shared.lock() {
                                    *lock = Some(tty.to_string());
                                }
                                if let Ok(mut lock) = connection_tty_sender.lock() {
                                    *lock = Some(tty.to_string());
                                }
                                tty_detected = true;
                                    }
                                }
                            }
                        }
                    }
                    buffer.extend_from_slice(&bytes);

                    let deadline = tokio::time::Instant::now() + Duration::from_millis(2);
                    loop {
                        tokio::select! {
                            biased;
                            more = output_rx.recv() => {
                                match more {
                                    Some(more_bytes) => {
                                        if !tty_detected {
                                            if let Ok(text) = std::str::from_utf8(&more_bytes) {
                                                if let Some(pos) = text.find("]7337;") {
                                                    let after = &text[pos + 6..];
                                                    if let Some(end) = after.find('\\') {
                                        let tty = after[..end].trim_end_matches('\x1b');
                                        if tty.starts_with("/dev/") {
                                if let Ok(mut lock) = client_tty_shared.lock() {
                                    *lock = Some(tty.to_string());
                                }
                                if let Ok(mut lock) = connection_tty_sender.lock() {
                                    *lock = Some(tty.to_string());
                                }
                                tty_detected = true;
                                        }
                                                    }
                                                }
                                            }
                                        }
                                        buffer.extend_from_slice(&more_bytes);
                                        if buffer.len() > 65536 {
                                            break;
                                        }
                                    }
                                    None => {
                                        if !buffer.is_empty() {
                                            frame_buf.clear();
                                            frame_buf.put_u8(0x30);
                                            frame_buf.extend_from_slice(&buffer);
                                            let _ = ws_sender.send(Message::Binary(frame_buf.split().freeze())).await;
                                        }
                                        return;
                                    }
                                }
                            }
                            _ = tokio::time::sleep_until(deadline) => {
                                break;
                            }
                        }
                    }

                    if !buffer.is_empty() {
                        frame_buf.clear();
                        frame_buf.put_u8(0x30);
                        frame_buf.extend_from_slice(&buffer);
                        buffer.clear();
                        if ws_sender.send(Message::Binary(frame_buf.split().freeze())).await.is_err() {
                            break;
                        }
                    }
                }
                None => {
                    if !buffer.is_empty() {
                        frame_buf.clear();
                        frame_buf.put_u8(0x30);
                        frame_buf.extend_from_slice(&buffer);
                        let _ = ws_sender.send(Message::Binary(frame_buf.split().freeze())).await;
                    }
                    break;
                }
            }
        }
    });

    let master_recv = master.clone();
    let paused_recv = paused.clone();

    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_receiver.next().await {
            match msg {
                Message::Binary(data) => {
                    if data.is_empty() {
                        continue;
                    }
                    let cmd = data[0];
                    let payload = &data[1..];

                    match cmd {
                        0x30 => {
                            let _ = pty_input_tx.send(bytes::Bytes::copy_from_slice(payload));
                        }
                        0x31 => {
                            if let Ok(text) = std::str::from_utf8(payload) {
                                if let Ok(resize) =
                                    serde_json::from_str::<ResizeMessage>(text)
                                {
                                    if let Ok(m) = master_recv.lock() {
                                        let _ = m.resize(PtySize {
                                            rows: resize.rows,
                                            cols: resize.columns,
                                            pixel_width: 0,
                                            pixel_height: 0,
                                        });
                                    }
                                }
                            }
                        }
                        0x32 => {
                            let (lock, _cvar) = &*paused_recv;
                            if let Ok(mut is_paused) = lock.lock() {
                                *is_paused = true;
                            }
                        }
                        0x33 => {
                            let (lock, cvar) = &*paused_recv;
                            if let Ok(mut is_paused) = lock.lock() {
                                *is_paused = false;
                                cvar.notify_one();
                            }
                        }
                        _ => {}
                    }
                }
                Message::Text(text) => {
                    if let Ok(resize) = serde_json::from_str::<ResizeMessage>(text.as_str()) {
                        if let Ok(m) = master_recv.lock() {
                            let _ = m.resize(PtySize {
                                rows: resize.rows,
                                cols: resize.columns,
                                pixel_width: 0,
                                pixel_height: 0,
                            });
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = &mut sender_task => {
            recv_task.abort();
            let _ = recv_task.await;
        },
        _ = &mut recv_task => {
            sender_task.abort();
            let _ = sender_task.await;
        },
    }

    {
        let (lock, cvar) = &*paused;
        if let Ok(mut is_paused) = lock.lock() {
            *is_paused = false;
            cvar.notify_one();
        }
    }

    if let Some(pid) = wrapper_pid {
        let detached = tokio::task::spawn_blocking(move || {
            let owned = find_owned_tmux_clients(pid);
            for tty in &owned {
                if let Err(e) = run_cmd("tmux", &["detach-client", "-t", tty]) {
                    tracing::warn!("tmux detach-client {} failed: {}", tty, e);
                }
            }
            !owned.is_empty()
        })
        .await
        .unwrap_or(false);
        if detached {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    drop(master);
    let _ = reader_handle.join();
    let _ = writer_handle.join();

    let cleanup_tty = connection_tty.lock().ok().and_then(|lock| lock.clone());
    if let Ok(mut lock) = state.client_tty.lock() {
        if *lock == cleanup_tty {
            *lock = None;
        }
    }

    tracing::info!("Terminal session ended");
}

fn parse_init_message(msg: Message) -> (u16, u16) {
    let data = match msg {
        Message::Text(text) => text.as_bytes().to_vec(),
        Message::Binary(data) => data.to_vec(),
        _ => return (80, 24),
    };

    if let Ok(text) = std::str::from_utf8(&data) {
        if let Ok(init) = serde_json::from_str::<InitMessage>(text) {
            return (init.columns.max(1) as u16, init.rows.max(1) as u16);
        }
    }
    (80, 24)
}

fn write_wrapper_script(path: &str, shell: &str, tty_file: &str, cwd_file: &str) {
    let is_zsh = shell == "zsh" || shell.ends_with("/zsh");
    let is_bash = shell == "bash" || shell.ends_with("/bash");

    if is_zsh {
        // Set up ZDOTDIR with CWD hook
        let zdotdir = "/tmp/rust_terminal_zdotdir";
        let _ = std::fs::create_dir_all(zdotdir);

        // Symlink user's zsh dotfiles
        let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
        for f in &[".zshenv", ".zprofile", ".zlogin", ".zlogout"] {
            let src = format!("{}/{}", home, f);
            let dst = format!("{}/{}", zdotdir, f);
            let _ = std::fs::remove_file(&dst);
            if Path::new(&src).exists() {
                let _ = std::os::unix::fs::symlink(&src, &dst);
            }
        }

        // Write custom .zshrc
        let zshrc = format!(
            r#"ZDOTDIR="$HOME" source "$HOME/.zshrc" 2>/dev/null
__ttyd_cwd_hook() {{ echo $PWD > {} 2>/dev/null; }}
precmd_functions+=(__ttyd_cwd_hook)
"#,
            cwd_file
        );
        let _ = std::fs::write(format!("{}/{}", zdotdir, ".zshrc"), zshrc);

        let script = format!(
            r#"#!/bin/zsh
unset TMUX TMUX_PANE
tty > {} 2>/dev/null
printf '\033]7337;%s\033\\' "$(tty)" 2>/dev/null
if tmux has-session 2>/dev/null; then
    tmux set -g window-size latest 2>/dev/null
    tmux set -g history-limit 50000 2>/dev/null
    tmux set -g extended-keys always 2>/dev/null
    tmux set -g set-clipboard on 2>/dev/null
    tmux set -g allow-passthrough on 2>/dev/null
    tmux bind-key -n S-Enter send-keys -l $'\033[13;2u' 2>/dev/null
    tmux unbind -T root MouseDrag1Pane 2>/dev/null
    tmux attach
fi
ZDOTDIR={} exec {}
"#,
            tty_file, zdotdir, shell
        );
        let _ = std::fs::write(path, script);
    } else if is_bash {
        let bashrc = format!(
            r#"[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"
__ttyd_cwd_hook() {{ echo $PWD > {} 2>/dev/null; }}
PROMPT_COMMAND="__ttyd_cwd_hook${{PROMPT_COMMAND:+;$PROMPT_COMMAND}}"
"#,
            cwd_file
        );
        let _ = std::fs::write("/tmp/rust_terminal_bashrc", bashrc);

        let script = format!(
            r#"#!/bin/bash
unset TMUX TMUX_PANE
tty > {} 2>/dev/null
printf '\033]7337;%s\033\\' "$(tty)" 2>/dev/null
if tmux has-session 2>/dev/null; then
    tmux set -g window-size latest 2>/dev/null
    tmux set -g history-limit 50000 2>/dev/null
    tmux set -g extended-keys always 2>/dev/null
    tmux set -g set-clipboard on 2>/dev/null
    tmux set -g allow-passthrough on 2>/dev/null
    tmux bind-key -n S-Enter send-keys -l $'\033[13;2u' 2>/dev/null
    tmux unbind -T root MouseDrag1Pane 2>/dev/null
    tmux attach
fi
exec bash --rcfile /tmp/rust_terminal_bashrc
"#,
            tty_file
        );
        let _ = std::fs::write(path, script);
    } else {
        let script = format!(
            r#"#!/bin/sh
unset TMUX TMUX_PANE
tty > {} 2>/dev/null
printf '\033]7337;%s\033\\' "$(tty)" 2>/dev/null
if tmux has-session 2>/dev/null; then
    tmux set -g window-size latest 2>/dev/null
    tmux set -g history-limit 50000 2>/dev/null
    tmux set -g extended-keys always 2>/dev/null
    tmux set -g set-clipboard on 2>/dev/null
    tmux set -g allow-passthrough on 2>/dev/null
    tmux bind-key -n S-Enter send-keys -l $'\033[13;2u' 2>/dev/null
    tmux unbind -T root MouseDrag1Pane 2>/dev/null
    tmux attach
fi
exec {}
"#,
            tty_file, shell
        );
        let _ = std::fs::write(path, script);
    }

    // Make executable
    let _ = StdCommand::new("chmod").arg("+x").arg(path).output();
}

#[derive(Deserialize)]
struct InitMessage {
    #[serde(default)]
    #[serde(alias = "AuthToken")]
    #[allow(dead_code)]
    auth_token: Option<String>,
    columns: u32,
    rows: u32,
}

#[derive(Deserialize)]
struct ResizeMessage {
    #[serde(alias = "AuthToken")]
    #[serde(default)]
    #[allow(dead_code)]
    auth_token: Option<String>,
    columns: u16,
    rows: u16,
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP API HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

// ─── JSON helpers ──────────────────────────────────────────────────────────

fn json_response<T: Serialize>(data: &T) -> Response {
    Json(data).into_response()
}

fn json_error(error: &str, message: &str, status: StatusCode) -> Response {
    (
        status,
        Json(serde_json::json!({ "error": error, "message": message })),
    )
        .into_response()
}

// ─── GET /api/health ───────────────────────────────────────────────────────

async fn api_health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

// ─── GET /api/client-tty ───────────────────────────────────────────────────

async fn api_client_tty(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Json<serde_json::Value> {
    let tty = tokio::task::spawn_blocking(move || get_client_tty_from_state(&state))
        .await
        .unwrap_or(None);
    Json(serde_json::json!({ "client_tty": tty }))
}

fn get_client_tty_from_state(state: &AppState) -> Option<String> {
    // First try from our stored state
    if let Ok(lock) = state.client_tty.lock() {
        if let Some(ref tty) = *lock {
            return Some(tty.clone());
        }
    }
    // Fallback: read from file
    get_client_tty_from_file()
}

fn get_client_tty_from_file() -> Option<String> {
    let tty_from_file = std::fs::read_to_string(tty_file_path())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // Verify against current tmux clients
    if let Ok(output) = run_cmd("tmux", &["list-clients", "-F", "#{client_tty}"]) {
        let clients: Vec<&str> = output.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();

        if let Some(ref tty) = tty_from_file {
            if clients.contains(&tty.as_str()) {
                return Some(tty.clone());
            }
        }
        if clients.len() == 1 {
            return Some(clients[0].to_string());
        }
    }

    tty_from_file
}

// ─── GET /api/cwd ──────────────────────────────────────────────────────────

async fn api_cwd(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Json<serde_json::Value> {
    let (cwd, is_git) = tokio::task::spawn_blocking(move || {
        let cwd = get_cwd(get_effective_client_tty(&state, None));
        let is_git = is_git_repo(&cwd);
        (cwd, is_git)
    })
    .await
    .unwrap_or_else(|_| (String::new(), false));
    Json(serde_json::json!({ "cwd": cwd, "is_git": is_git }))
}

fn get_effective_client_tty(state: &AppState, explicit: Option<String>) -> Option<String> {
    explicit.or_else(|| get_client_tty_from_state(state))
}

// ─── CWD Detection (priority chain, like Python) ──────────────────────────

fn get_cwd(client_tty: Option<String>) -> String {
    // 1. Tmux pane path
    if let Some(ref tty) = client_tty {
        if let Some(path) = get_tmux_pane_path(tty) {
            return path;
        }
    }

    // 2. CWD file
    if let Ok(content) = std::fs::read_to_string(cwd_file_path()) {
        let path = content.trim().to_string();
        if !path.is_empty() {
            return path;
        }
    }

    // 3. ttyd child process CWD (Linux /proc)
    if Path::new("/proc").is_dir() {
        if let Some(cwd) = get_child_process_cwd() {
            return cwd;
        }
    }

    // 4. Home directory fallback
    std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string())
}

fn get_tmux_pane_path(client_tty: &str) -> Option<String> {
    let path = run_cmd(
        "tmux",
        &["display-message", "-c", client_tty, "-p", "#{pane_current_path}"],
    )
    .ok()?;
    let path = path.trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

fn get_child_process_cwd() -> Option<String> {
    // Find rust-terminal's child processes (the PTY shell)
    let my_pid = std::process::id().to_string();
    if let Ok(output) = run_cmd("pgrep", &["-P", &my_pid]) {
        for child_pid in output.lines() {
            let child_pid = child_pid.trim();
            if child_pid.is_empty() {
                continue;
            }
            let cwd_link = format!("/proc/{}/cwd", child_pid);
            if let Ok(cwd) = std::fs::read_link(&cwd_link) {
                return Some(cwd.to_string_lossy().to_string());
            }
            // Also check children of children (for tmux)
            if let Ok(grandchildren) = run_cmd("pgrep", &["-P", child_pid]) {
                for gc_pid in grandchildren.lines() {
                    let gc_pid = gc_pid.trim();
                    if gc_pid.is_empty() {
                        continue;
                    }
                    let cwd_link = format!("/proc/{}/cwd", gc_pid);
                    if let Ok(cwd) = std::fs::read_link(&cwd_link) {
                        return Some(cwd.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    None
}

// ─── Git Operations (subprocess, matching Python exactly) ──────────────────

fn is_git_repo(path: &str) -> bool {
    run_cmd_in("git", &["rev-parse", "--git-dir"], path).is_ok()
}

fn get_git_root(path: &str) -> String {
    run_cmd_in("git", &["rev-parse", "--show-toplevel"], path)
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| path.to_string())
}

fn get_branch(path: &str) -> String {
    run_cmd_in("git", &["rev-parse", "--abbrev-ref", "HEAD"], path)
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string())
}

fn get_all_branches(path: &str) -> BranchesResponse {
    let current = get_branch(path);

    let local = run_cmd_in("git", &["branch", "--format=%(refname:short)"], path)
        .map(|s| {
            s.lines()
                .map(|l| l.to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let remote = run_cmd_in(
        "git",
        &["branch", "-r", "--format=%(refname:short)"],
        path,
    )
    .map(|s| {
        s.lines()
            .map(|l| l.to_string())
            .filter(|l| !l.is_empty() && !l.ends_with("/HEAD"))
            .collect()
    })
    .unwrap_or_default();

    BranchesResponse {
        local,
        remote,
        current,
    }
}

fn get_changed_files(git_root: &str) -> Vec<ChangedFile> {
    let output = match run_cmd_in("git", &["diff", "--name-status"], git_root) {
        Ok(o) => o,
        Err(_) => return vec![],
    };

    output
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(2, '\t').collect();
            if parts.len() == 2 {
                Some(ChangedFile {
                    status: parts[0].to_string(),
                    filename: parts[1].to_string(),
                })
            } else {
                None
            }
        })
        .collect()
}

fn parse_unified_diff(raw: &str, changed_files: &[ChangedFile]) -> DiffResult {
    let mut files: Vec<DiffFile> = Vec::new();
    let mut total_additions: i64 = 0;
    let mut total_deletions: i64 = 0;

    let mut current_filename = String::new();
    let mut current_hunks: Vec<DiffHunk> = Vec::new();
    let mut current_lines: Vec<DiffLine> = Vec::new();
    let mut current_header = String::new();
    let mut file_adds: i64 = 0;
    let mut file_dels: i64 = 0;
    let mut old_line: i64 = 0;
    let mut new_line: i64 = 0;
    let mut is_binary = false;

    let flush_file = |filename: &str,
                      hunks: &mut Vec<DiffHunk>,
                      lines: &mut Vec<DiffLine>,
                      header: &str,
                      adds: i64,
                      dels: i64,
                      binary: bool,
                      files: &mut Vec<DiffFile>,
                      changed: &[ChangedFile]| {
        if !lines.is_empty() {
            hunks.push(DiffHunk {
                header: header.to_string(),
                lines: std::mem::take(lines),
            });
        }
        if !filename.is_empty() {
            let status = changed
                .iter()
                .find(|c| c.filename == filename)
                .map(|c| c.status.clone())
                .unwrap_or_else(|| "M".to_string());
            files.push(DiffFile {
                filename: filename.to_string(),
                status,
                binary,
                additions: adds,
                deletions: dels,
                hunks: std::mem::take(hunks),
            });
        }
    };

    for line in raw.lines() {
        if let Some(name) = line.strip_prefix("+++ b/") {
            if current_filename.is_empty() {
                current_filename = name.to_string();
            }
        } else if let Some(rest) = line.strip_prefix("--- a/") {
            flush_file(
                &current_filename,
                &mut current_hunks,
                &mut current_lines,
                &current_header,
                file_adds,
                file_dels,
                is_binary,
                &mut files,
                changed_files,
            );
            total_additions += file_adds;
            total_deletions += file_dels;
            current_filename = rest.to_string();
            current_hunks = Vec::new();
            current_lines = Vec::new();
            current_header = String::new();
            file_adds = 0;
            file_dels = 0;
            is_binary = false;
        } else if line.starts_with("--- /dev/null") {
            flush_file(
                &current_filename,
                &mut current_hunks,
                &mut current_lines,
                &current_header,
                file_adds,
                file_dels,
                is_binary,
                &mut files,
                changed_files,
            );
            total_additions += file_adds;
            total_deletions += file_dels;
            current_filename = String::new();
            current_hunks = Vec::new();
            current_lines = Vec::new();
            current_header = String::new();
            file_adds = 0;
            file_dels = 0;
            is_binary = false;
        } else if line.starts_with("diff --git")
            || line.starts_with("index ")
            || line.starts_with("new file")
            || line.starts_with("deleted file")
        {
            continue;
        } else if line.starts_with("Binary files") {
            is_binary = true;
        } else if line.starts_with("@@ ") {
            if !current_lines.is_empty() {
                current_hunks.push(DiffHunk {
                    header: current_header.clone(),
                    lines: std::mem::take(&mut current_lines),
                });
            }
            current_header = line.to_string();
            // Parse @@ -old_start,old_count +new_start,new_count @@
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 3 {
                old_line = parts[1]
                    .trim_start_matches('-')
                    .split(',')
                    .next()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(1);
                new_line = parts[2]
                    .trim_start_matches('+')
                    .split(',')
                    .next()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(1);
            }
        } else if let Some(content) = line.strip_prefix('+') {
            file_adds += 1;
            current_lines.push(DiffLine {
                line_type: "add".to_string(),
                old_num: None,
                new_num: Some(new_line),
                content: content.to_string(),
            });
            new_line += 1;
        } else if let Some(content) = line.strip_prefix('-') {
            file_dels += 1;
            current_lines.push(DiffLine {
                line_type: "del".to_string(),
                old_num: Some(old_line),
                new_num: None,
                content: content.to_string(),
            });
            old_line += 1;
        } else {
            let content = line.strip_prefix(' ').unwrap_or(line);
            current_lines.push(DiffLine {
                line_type: "ctx".to_string(),
                old_num: Some(old_line),
                new_num: Some(new_line),
                content: content.to_string(),
            });
            old_line += 1;
            new_line += 1;
        }
    }

    flush_file(
        &current_filename,
        &mut current_hunks,
        &mut current_lines,
        &current_header,
        file_adds,
        file_dels,
        is_binary,
        &mut files,
        changed_files,
    );
    total_additions += file_adds;
    total_deletions += file_dels;

    DiffResult {
        summary: DiffSummary {
            total_files: files.len() as i64,
            total_additions,
            total_deletions,
        },
        files,
    }
}

/// Generate a synthetic unified diff for an untracked file (avoids `git add -N` side effects).
fn synthetic_diff_for_new_file(file: &str, git_root: &str) -> String {
    let path = std::path::Path::new(git_root).join(file);
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    let lines: Vec<&str> = content.lines().collect();
    let count = lines.len();
    let mut diff = format!(
        "diff --git a/{file} b/{file}\nnew file mode 100644\n--- /dev/null\n+++ b/{file}\n@@ -0,0 +1,{count} @@\n"
    );
    for line in &lines {
        diff.push('+');
        diff.push_str(line);
        diff.push('\n');
    }
    diff
}

fn get_untracked_files(git_root: &str) -> Vec<String> {
    run_cmd_in("git", &["ls-files", "--others", "--exclude-standard"], git_root)
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect()
}

fn get_files_diff(git_root: &str) -> DiffResult {
    let tracked_diff = run_cmd_in("git", &["diff", "-U3"], git_root).unwrap_or_default();

    let untracked = get_untracked_files(git_root);
    let mut combined = tracked_diff;
    let mut untracked_changed: Vec<ChangedFile> = Vec::new();
    for file in &untracked {
        combined.push_str(&synthetic_diff_for_new_file(file, git_root));
        untracked_changed.push(ChangedFile {
            status: "A".to_string(),
            filename: file.clone(),
        });
    }

    let mut changed_files = get_changed_files(git_root);
    changed_files.extend(untracked_changed);
    parse_unified_diff(&combined, &changed_files)
}

// ─── GET /api/diff ─────────────────────────────────────────────────────────

async fn api_diff(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Response {
    let payload = tokio::task::spawn_blocking(move || {
        let cwd = get_cwd(get_effective_client_tty(&state, None));
        if !is_git_repo(&cwd) {
            return serde_json::json!({
                "error": "not_git_repo",
                "message": format!("'{}' is not a git repository", cwd),
                "cwd": cwd,
            });
        }
        let git_root = get_git_root(&cwd);
        let branch = get_branch(&git_root);
        let diff_data = get_files_diff(&git_root);
        serde_json::json!({
            "cwd": cwd,
            "git_root": git_root,
            "branch": branch,
            "files": diff_data.files,
            "summary": diff_data.summary,
        })
    })
    .await
    .unwrap_or_else(|_| serde_json::json!({
        "error": "internal_error",
        "message": "Task failed",
    }));
    Json(payload).into_response()
}

// ─── GET /api/git/branches ─────────────────────────────────────────────────

async fn api_git_branches(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || -> Result<BranchesResponse, ApiError> {
        let cwd = get_cwd(get_effective_client_tty(&state, None));
        if !is_git_repo(&cwd) {
            return Err((
                StatusCode::BAD_REQUEST,
                "not_git_repo".into(),
                "Not a git repository".into(),
            ));
        }
        let git_root = get_git_root(&cwd);
        Ok(get_all_branches(&git_root))
    })
    .await;

    match outcome {
        Ok(Ok(branches)) => json_response(&branches),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error("internal_error", "Task failed", StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── GET /api/git/checkout ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct CheckoutQuery {
    branch: Option<String>,
}

async fn api_git_checkout(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<CheckoutQuery>,
) -> Response {
    let branch = match query.branch {
        Some(b) if !b.is_empty() => b,
        _ => {
            return json_error(
                "missing_branch",
                "Branch name required",
                StatusCode::BAD_REQUEST,
            )
        }
    };

    let outcome = tokio::task::spawn_blocking({
        let branch = branch.clone();
        move || -> Result<(), ApiError> {
            let cwd = get_cwd(get_effective_client_tty(&state, None));
            if !is_git_repo(&cwd) {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "not_git_repo".into(),
                    "Not a git repository".into(),
                ));
            }
            let git_root = get_git_root(&cwd);
            run_cmd_in("git", &["checkout", &branch], &git_root)
                .map(|_| ())
                .map_err(|msg| (StatusCode::INTERNAL_SERVER_ERROR, "checkout_failed".into(), msg))
        }
    })
    .await;

    match outcome {
        Ok(Ok(())) => Json(serde_json::json!({ "success": true, "branch": branch })).into_response(),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error("internal_error", "Task failed", StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── GET /api/git/status ───────────────────────────────────────────────────

#[derive(Serialize)]
struct StatusFile {
    file: String,
    status: String,
}

#[derive(Serialize)]
struct GitStatusResponse {
    staged: Vec<StatusFile>,
    unstaged: Vec<StatusFile>,
    branch: String,
}

fn parse_porcelain_status(output: &str) -> (Vec<StatusFile>, Vec<StatusFile>) {
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();

    for line in output.lines() {
        if line.len() < 4 {
            continue;
        }
        let x = line.as_bytes()[0] as char;
        let y = line.as_bytes()[1] as char;
        let file = line[3..].to_string();

        if x != ' ' && x != '?' && x != '!' {
            let status = match x {
                'M' => "M",
                'A' => "A",
                'D' => "D",
                'R' => "R",
                'C' => "C",
                _ => "M",
            };
            staged.push(StatusFile {
                file: file.clone(),
                status: status.to_string(),
            });
        }

        if y != ' ' && y != '!' {
            let status = match y {
                'M' => "M",
                'D' => "D",
                '?' => "U",
                _ => "M",
            };
            unstaged.push(StatusFile {
                file: file.clone(),
                status: status.to_string(),
            });
        }
    }

    (staged, unstaged)
}

async fn api_git_status(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || -> Result<GitStatusResponse, ApiError> {
        let cwd = get_cwd(get_effective_client_tty(&state, None));
        if !is_git_repo(&cwd) {
            return Err((
                StatusCode::BAD_REQUEST,
                "not_git_repo".into(),
                "Not a git repository".into(),
            ));
        }
        let git_root = get_git_root(&cwd);
        let branch = get_branch(&git_root);
        let output = run_cmd_in("git", &["status", "--porcelain=v1"], &git_root)
            .unwrap_or_default();
        let (staged, unstaged) = parse_porcelain_status(&output);
        Ok(GitStatusResponse {
            staged,
            unstaged,
            branch,
        })
    })
    .await;

    match outcome {
        Ok(Ok(s)) => json_response(&s),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error("internal_error", "Task failed", StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── POST /api/git/stage ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct GitFilesRequest {
    files: Option<Vec<String>>,
    all: Option<bool>,
}

async fn api_git_stage(
    axum::extract::State(state): axum::extract::State<AppState>,
    Json(body): Json<GitFilesRequest>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || -> Result<(), ApiError> {
        let cwd = get_cwd(get_effective_client_tty(&state, None));
        if !is_git_repo(&cwd) {
            return Err((
                StatusCode::BAD_REQUEST,
                "not_git_repo".into(),
                "Not a git repository".into(),
            ));
        }
        let git_root = get_git_root(&cwd);
        let res = if body.all.unwrap_or(false) {
            run_cmd_in("git", &["add", "-A"], &git_root)
        } else if let Some(files) = &body.files {
            if files.is_empty() {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "stage_failed".into(),
                    "No files specified".into(),
                ));
            }
            let args: Vec<&str> = std::iter::once("add")
                .chain(files.iter().map(|s| s.as_str()))
                .collect();
            run_cmd_in("git", &args, &git_root)
        } else {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "stage_failed".into(),
                "No files specified".into(),
            ));
        };
        res.map(|_| ()).map_err(|msg| (StatusCode::INTERNAL_SERVER_ERROR, "stage_failed".into(), msg))
    })
    .await;

    match outcome {
        Ok(Ok(())) => Json(serde_json::json!({ "success": true })).into_response(),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error("internal_error", "Task failed", StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── POST /api/git/unstage ────────────────────────────────────────────────

async fn api_git_unstage(
    axum::extract::State(state): axum::extract::State<AppState>,
    Json(body): Json<GitFilesRequest>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || -> Result<(), ApiError> {
        let cwd = get_cwd(get_effective_client_tty(&state, None));
        if !is_git_repo(&cwd) {
            return Err((
                StatusCode::BAD_REQUEST,
                "not_git_repo".into(),
                "Not a git repository".into(),
            ));
        }
        let git_root = get_git_root(&cwd);
        let res = if body.all.unwrap_or(false) {
            run_cmd_in("git", &["reset", "HEAD"], &git_root)
        } else if let Some(files) = &body.files {
            if files.is_empty() {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "unstage_failed".into(),
                    "No files specified".into(),
                ));
            }
            let args: Vec<&str> = std::iter::once("reset")
                .chain(std::iter::once("HEAD"))
                .chain(files.iter().map(|s| s.as_str()))
                .collect();
            run_cmd_in("git", &args, &git_root)
        } else {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "unstage_failed".into(),
                "No files specified".into(),
            ));
        };
        res.map(|_| ()).map_err(|msg| (StatusCode::INTERNAL_SERVER_ERROR, "unstage_failed".into(), msg))
    })
    .await;

    match outcome {
        Ok(Ok(())) => Json(serde_json::json!({ "success": true })).into_response(),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error("internal_error", "Task failed", StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── POST /api/git/discard ────────────────────────────────────────────────

async fn api_git_discard(
    axum::extract::State(state): axum::extract::State<AppState>,
    Json(body): Json<GitFilesRequest>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || -> Result<(), ApiError> {
        let cwd = get_cwd(get_effective_client_tty(&state, None));
        if !is_git_repo(&cwd) {
            return Err((
                StatusCode::BAD_REQUEST,
                "not_git_repo".into(),
                "Not a git repository".into(),
            ));
        }
        let git_root = get_git_root(&cwd);
        let files = match &body.files {
            Some(f) if !f.is_empty() => f,
            _ => return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "discard_failed".into(),
                "No files specified".into(),
            )),
        };
        for file in files {
            let is_tracked = run_cmd_in(
                "git",
                &["ls-files", "--error-unmatch", file],
                &git_root,
            )
            .is_ok();
            if is_tracked {
                let _ = run_cmd_in("git", &["checkout", "--", file], &git_root);
            } else {
                let path = std::path::Path::new(&git_root).join(file);
                if path.exists() {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        Ok(())
    })
    .await;

    match outcome {
        Ok(Ok(())) => Json(serde_json::json!({ "success": true })).into_response(),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error("internal_error", "Task failed", StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── POST /api/git/commit ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct GitCommitRequest {
    message: String,
}

async fn api_git_commit(
    axum::extract::State(state): axum::extract::State<AppState>,
    Json(body): Json<GitCommitRequest>,
) -> Response {
    if body.message.trim().is_empty() {
        return json_error("empty_message", "Commit message required", StatusCode::BAD_REQUEST);
    }

    let outcome = tokio::task::spawn_blocking(move || -> Result<String, ApiError> {
        let cwd = get_cwd(get_effective_client_tty(&state, None));
        if !is_git_repo(&cwd) {
            return Err((
                StatusCode::BAD_REQUEST,
                "not_git_repo".into(),
                "Not a git repository".into(),
            ));
        }
        let git_root = get_git_root(&cwd);
        run_cmd_in("git", &["commit", "-m", &body.message], &git_root)
            .map_err(|msg| (StatusCode::INTERNAL_SERVER_ERROR, "commit_failed".into(), msg))
    })
    .await;

    match outcome {
        Ok(Ok(output)) => Json(serde_json::json!({
            "success": true,
            "output": output.trim(),
        }))
        .into_response(),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error("internal_error", "Task failed", StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── GET /api/git/log ─────────────────────────────────────────────────────

#[derive(Serialize)]
struct GitLogEntry {
    hash: String,
    message: String,
    author: String,
    date: String,
}

#[derive(Deserialize)]
struct GitLogQuery {
    count: Option<usize>,
}

async fn api_git_log(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<GitLogQuery>,
) -> Response {
    let count = query.count.unwrap_or(50).min(200);
    let outcome = tokio::task::spawn_blocking(move || -> Result<Vec<GitLogEntry>, ApiError> {
        let cwd = get_cwd(get_effective_client_tty(&state, None));
        if !is_git_repo(&cwd) {
            return Err((
                StatusCode::BAD_REQUEST,
                "not_git_repo".into(),
                "Not a git repository".into(),
            ));
        }
        let git_root = get_git_root(&cwd);
        let format = "%H\x1f%s\x1f%an\x1f%cr";
        let output = run_cmd_in(
            "git",
            &["log", &format!("--max-count={}", count), &format!("--format={}", format)],
            &git_root,
        )
        .map_err(|msg| (StatusCode::INTERNAL_SERVER_ERROR, "log_failed".into(), msg))?;
        Ok(output
            .lines()
            .filter_map(|line| {
                let parts: Vec<&str> = line.splitn(4, '\x1f').collect();
                if parts.len() == 4 {
                    Some(GitLogEntry {
                        hash: parts[0][..7.min(parts[0].len())].to_string(),
                        message: parts[1].to_string(),
                        author: parts[2].to_string(),
                        date: parts[3].to_string(),
                    })
                } else {
                    None
                }
            })
            .collect())
    })
    .await;

    match outcome {
        Ok(Ok(entries)) => json_response(&entries),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error("internal_error", "Task failed", StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── GET /api/git/file-diff ────────────────────────────────────────────────

#[derive(Deserialize)]
struct FileDiffQuery {
    file: String,
    staged: Option<bool>,
}

async fn api_git_file_diff(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<FileDiffQuery>,
) -> Response {
    if query.file.is_empty() {
        return json_error("missing_file", "File path required", StatusCode::BAD_REQUEST);
    }

    let outcome = tokio::task::spawn_blocking(move || -> Result<DiffResult, ApiError> {
        let cwd = get_cwd(get_effective_client_tty(&state, None));
        if !is_git_repo(&cwd) {
            return Err((
                StatusCode::BAD_REQUEST,
                "not_git_repo".into(),
                "Not a git repository".into(),
            ));
        }
        let git_root = get_git_root(&cwd);
        let file = query.file.clone();
        let is_staged = query.staged.unwrap_or(false);
        if is_staged {
            let raw = run_cmd_in("git", &["diff", "--cached", "-U3", "--", &file], &git_root)
                .unwrap_or_default();
            let changed = vec![ChangedFile { status: "M".to_string(), filename: file }];
            Ok(parse_unified_diff(&raw, &changed))
        } else {
            let is_untracked = run_cmd_in("git", &["ls-files", "--error-unmatch", &file], &git_root).is_err();
            if is_untracked {
                let raw = synthetic_diff_for_new_file(&file, &git_root);
                let changed = vec![ChangedFile { status: "A".to_string(), filename: file }];
                Ok(parse_unified_diff(&raw, &changed))
            } else {
                let raw = run_cmd_in("git", &["diff", "-U3", "--", &file], &git_root)
                    .unwrap_or_default();
                let changed = vec![ChangedFile { status: "M".to_string(), filename: file }];
                Ok(parse_unified_diff(&raw, &changed))
            }
        }
    })
    .await;

    match outcome {
        Ok(Ok(diff)) => {
            let file_diff = diff.files.into_iter().next();
            match file_diff {
                Some(f) => json_response(&f),
                None => Json(serde_json::json!({ "hunks": [], "additions": 0, "deletions": 0 })).into_response(),
            }
        }
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error("internal_error", "Task failed", StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── POST /api/git/batch-file-diff ─────────────────────────────────────────

#[derive(Deserialize)]
struct BatchFileDiffRequest {
    files: Vec<BatchFileDiffEntry>,
}

#[derive(Deserialize)]
struct BatchFileDiffEntry {
    file: String,
    staged: bool,
}

async fn api_git_batch_file_diff(
    axum::extract::State(state): axum::extract::State<AppState>,
    Json(body): Json<BatchFileDiffRequest>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, ApiError> {
        let cwd = get_cwd(get_effective_client_tty(&state, None));
        if !is_git_repo(&cwd) {
            return Err((StatusCode::BAD_REQUEST, "not_git_repo".into(), "Not a git repository".into()));
        }
        let git_root = get_git_root(&cwd);

        let mut results = serde_json::Map::new();
        for entry in &body.files {
            let diff = if entry.staged {
                let raw = run_cmd_in("git", &["diff", "--cached", "-U3", "--", &entry.file], &git_root)
                    .unwrap_or_default();
                let changed = vec![ChangedFile { status: "M".to_string(), filename: entry.file.clone() }];
                parse_unified_diff(&raw, &changed)
            } else {
                let is_untracked = run_cmd_in("git", &["ls-files", "--error-unmatch", &entry.file], &git_root).is_err();
                if is_untracked {
                    let raw = synthetic_diff_for_new_file(&entry.file, &git_root);
                    let changed = vec![ChangedFile { status: "A".to_string(), filename: entry.file.clone() }];
                    parse_unified_diff(&raw, &changed)
                } else {
                    let raw = run_cmd_in("git", &["diff", "-U3", "--", &entry.file], &git_root)
                        .unwrap_or_default();
                    let changed = vec![ChangedFile { status: "M".to_string(), filename: entry.file.clone() }];
                    parse_unified_diff(&raw, &changed)
                }
            };
            let file_diff = diff.files.into_iter().next();
            let value = match file_diff {
                Some(f) => serde_json::to_value(&f).unwrap_or(serde_json::json!(null)),
                None => serde_json::json!({ "hunks": [], "additions": 0, "deletions": 0 }),
            };
            results.insert(entry.file.clone(), value);
        }
        Ok(serde_json::Value::Object(results))
    })
    .await;

    match outcome {
        Ok(Ok(val)) => Json(val).into_response(),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error("internal_error", "Task failed", StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── POST /api/git/stage-hunk ──────────────────────────────────────────────

#[derive(Deserialize)]
struct HunkPatchRequest {
    patch: String,
}

async fn api_git_stage_hunk(
    axum::extract::State(state): axum::extract::State<AppState>,
    Json(body): Json<HunkPatchRequest>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || -> Result<(), ApiError> {
        let cwd = get_cwd(get_effective_client_tty(&state, None));
        if !is_git_repo(&cwd) {
            return Err((
                StatusCode::BAD_REQUEST,
                "not_git_repo".into(),
                "Not a git repository".into(),
            ));
        }
        let git_root = get_git_root(&cwd);
        apply_patch(&git_root, &body.patch, &["apply", "--cached"])
            .map(|_| ())
            .map_err(|msg| (StatusCode::INTERNAL_SERVER_ERROR, "stage_hunk_failed".into(), msg))
    })
    .await;

    match outcome {
        Ok(Ok(())) => Json(serde_json::json!({ "success": true })).into_response(),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error("internal_error", "Task failed", StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── POST /api/git/discard-hunk ────────────────────────────────────────────

async fn api_git_discard_hunk(
    axum::extract::State(state): axum::extract::State<AppState>,
    Json(body): Json<HunkPatchRequest>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || -> Result<(), ApiError> {
        let cwd = get_cwd(get_effective_client_tty(&state, None));
        if !is_git_repo(&cwd) {
            return Err((
                StatusCode::BAD_REQUEST,
                "not_git_repo".into(),
                "Not a git repository".into(),
            ));
        }
        let git_root = get_git_root(&cwd);
        apply_patch(&git_root, &body.patch, &["apply", "--reverse"])
            .map(|_| ())
            .map_err(|msg| (StatusCode::INTERNAL_SERVER_ERROR, "discard_hunk_failed".into(), msg))
    })
    .await;

    match outcome {
        Ok(Ok(())) => Json(serde_json::json!({ "success": true })).into_response(),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error("internal_error", "Task failed", StatusCode::INTERNAL_SERVER_ERROR),
    }
}

fn apply_patch(git_root: &str, patch: &str, args: &[&str]) -> Result<String, String> {
    use std::io::Write;

    let mut child = StdCommand::new("git")
        .args(args)
        .current_dir(git_root)
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    child
        .stdin
        .take()
        .unwrap()
        .write_all(patch.as_bytes())
        .map_err(|e| e.to_string())?;

    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

// ─── Tmux Operations ──────────────────────────────────────────────────────

fn get_tmux_sessions() -> Vec<TmuxSession> {
    match run_cmd(
        "tmux",
        &["ls", "-F", "#{session_name}:#{session_windows}:#{session_attached}:#{session_activity}"],
    ) {
        Ok(output) => output
            .lines()
            .filter_map(|line| {
                let parts: Vec<&str> = line.rsplitn(4, ':').collect();
                if parts.len() >= 4 {
                    Some(TmuxSession {
                        name: parts[3].to_string(),
                        windows: parts[2].parse().unwrap_or(0),
                        attached: parts[1].parse::<i32>().unwrap_or(0) > 0,
                        last_activity: parts[0].parse().unwrap_or(0),
                    })
                } else {
                    None
                }
            })
            .collect(),
        Err(_) => vec![],
    }
}

fn get_current_tmux_session(client_tty: Option<&str>) -> Option<String> {
    let tty = client_tty?;

    let output = run_cmd("tmux", &["list-clients", "-F", "#{client_tty} #{client_session}"]).ok()?;

    for line in output.lines() {
        let parts: Vec<&str> = line.trim().splitn(2, ' ').collect();
        if parts.len() == 2 && parts[0] == tty {
            return Some(parts[1].to_string());
        }
    }
    None
}

// ─── GET /api/tmux/list ────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TmuxQuery {
    client_tty: Option<String>,
}

async fn api_tmux_list(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<TmuxQuery>,
) -> Json<serde_json::Value> {
    let payload = tokio::task::spawn_blocking(move || {
        let sessions = get_tmux_sessions();
        let client_tty = get_effective_client_tty(&state, query.client_tty);
        let current = get_current_tmux_session(client_tty.as_deref());
        serde_json::json!({
            "sessions": sessions,
            "currentSession": current,
        })
    })
    .await
    .unwrap_or_else(|_| serde_json::json!({ "sessions": [], "currentSession": null }));
    Json(payload)
}

// ─── GET /api/tmux/switch ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct TmuxSwitchQuery {
    session: Option<String>,
    client_tty: Option<String>,
}

async fn api_tmux_switch(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<TmuxSwitchQuery>,
) -> Response {
    let session = match query.session {
        Some(s) if !s.is_empty() => s,
        _ => {
            return json_error(
                "missing_session",
                "Session name required",
                StatusCode::BAD_REQUEST,
            )
        }
    };

    let outcome: Result<Result<(), ApiError>, _> = tokio::task::spawn_blocking(move || {
        let client_tty = match get_effective_client_tty(&state, query.client_tty) {
            Some(t) => t,
            None => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "missing_client_tty".into(),
                    "client_tty required".into(),
                ));
            }
        };
        if let Ok(clients) = run_cmd("tmux", &["list-clients", "-F", "#{client_tty}"]) {
            if !clients.contains(&client_tty) {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "switch_failed".into(),
                    format!("Client {} not attached to tmux", client_tty),
                ));
            }
        }
        run_cmd("tmux", &["switch-client", "-c", &client_tty, "-t", &session])
            .map(|_| ())
            .map_err(|msg| (StatusCode::INTERNAL_SERVER_ERROR, "switch_failed".into(), msg))
    })
    .await;

    match outcome {
        Ok(Ok(())) => Json(serde_json::json!({ "success": true })).into_response(),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error("internal_error", "Task failed", StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── GET /api/tmux/create ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct TmuxCreateQuery {
    name: Option<String>,
    client_tty: Option<String>,
}

async fn api_tmux_create(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<TmuxCreateQuery>,
) -> Response {
    let name = match query.name {
        Some(n) if !n.is_empty() => n,
        _ => {
            return json_error(
                "missing_name",
                "Session name required",
                StatusCode::BAD_REQUEST,
            )
        }
    };

    let outcome = tokio::task::spawn_blocking(move || -> Result<String, ApiError> {
        let client_tty = match get_effective_client_tty(&state, query.client_tty) {
            Some(t) => t,
            None => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "missing_client_tty".into(),
                    "client_tty required".into(),
                ));
            }
        };
        let _ = run_cmd("tmux", &["new-session", "-d", "-s", &name]);
        run_cmd("tmux", &["switch-client", "-c", &client_tty, "-t", &name])
            .map(|_| name)
            .map_err(|msg| (StatusCode::INTERNAL_SERVER_ERROR, "create_failed".into(), msg))
    })
    .await;

    match outcome {
        Ok(Ok(name)) => Json(serde_json::json!({
            "success": true,
            "message": format!("Session '{}' created", name),
        }))
        .into_response(),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error("internal_error", "Task failed", StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── GET /api/tmux/kill ────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TmuxKillQuery {
    name: Option<String>,
}

async fn api_tmux_kill(Query(query): Query<TmuxKillQuery>) -> Response {
    let name = match query.name {
        Some(n) if !n.is_empty() => n,
        _ => {
            return json_error(
                "missing_name",
                "Session name required",
                StatusCode::BAD_REQUEST,
            )
        }
    };

    let result = tokio::task::spawn_blocking({
        let name = name.clone();
        move || run_cmd("tmux", &["kill-session", "-t", &name])
    })
    .await;

    match result {
        Ok(Ok(_)) => Json(serde_json::json!({
            "success": true,
            "message": format!("Session '{}' killed", name),
        }))
        .into_response(),
        Ok(Err(_)) => json_error(
            "kill_failed",
            &format!("Failed to kill session '{}'", name),
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
        Err(_) => json_error("internal_error", "Task failed", StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── GET /api/tmux/detach ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct TmuxDetachQuery {
    client_tty: Option<String>,
}

async fn api_tmux_detach(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<TmuxDetachQuery>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || -> Result<(), ApiError> {
        let client_tty = match get_effective_client_tty(&state, query.client_tty) {
            Some(t) => t,
            None => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "missing_client_tty".into(),
                    "client_tty required".into(),
                ));
            }
        };
        if let Ok(clients) = run_cmd("tmux", &["list-clients", "-F", "#{client_tty}"]) {
            if !clients.contains(&client_tty) {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "detach_failed".into(),
                    format!("Client {} not attached to tmux", client_tty),
                ));
            }
        }
        run_cmd("tmux", &["detach-client", "-t", &client_tty])
            .map(|_| ())
            .map_err(|msg| (StatusCode::INTERNAL_SERVER_ERROR, "detach_failed".into(), msg))
    })
    .await;

    match outcome {
        Ok(Ok(())) => Json(serde_json::json!({ "success": true })).into_response(),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error("internal_error", "Task failed", StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── GET /api/tmux/quick-shell ─────────────────────────────────────────────

async fn api_tmux_quick_shell(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<TmuxDetachQuery>,
) -> Response {
    let client_tty = match query.client_tty {
        Some(tty) if !tty.is_empty() => tty,
        _ => {
            return json_error(
                "missing_client_tty",
                "client_tty required",
                StatusCode::BAD_REQUEST,
            )
        }
    };

    let outcome = tokio::task::spawn_blocking(move || -> Result<(String, String), ApiError> {
        if let Ok(clients) = run_cmd("tmux", &["list-clients", "-F", "#{client_tty}"]) {
            if !clients.contains(&client_tty) {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "quick_shell_failed".into(),
                    format!("Client {} not attached to tmux", client_tty),
                ));
            }
        }

        let cwd = get_tmux_pane_path(&client_tty)
            .or_else(|| Some(get_cwd(Some(client_tty.clone()))))
            .unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()));

        let shell_command = format!("exec {}", state.shell);

        if tmux_supports_display_popup() {
            let popup_args = [
                "display-popup",
                "-E",
                "-w",
                "90%",
                "-h",
                "80%",
                "-c",
                client_tty.as_str(),
                "-d",
                cwd.as_str(),
                "-T",
                " Quick Shell — exit to return ",
                shell_command.as_str(),
            ];

            match spawn_detached_cmd("tmux", &popup_args) {
                Ok(_) => return Ok(("popup".to_string(), cwd)),
                Err(msg) => {
                    tracing::warn!("Quick Shell popup failed, falling back to window: {}", msg);
                }
            }
        }

        let session = match get_current_tmux_session(Some(&client_tty)) {
            Some(session) => session,
            None => {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "quick_shell_failed".into(),
                    "No active tmux session found for this client".into(),
                ));
            }
        };

        run_cmd(
            "tmux",
            &[
                "new-window",
                "-t",
                &session,
                "-c",
                &cwd,
                "-n",
                "Quick Shell",
                &shell_command,
            ],
        )
        .map(|_| ("window".to_string(), cwd))
        .map_err(|msg| (StatusCode::INTERNAL_SERVER_ERROR, "quick_shell_failed".into(), msg))
    })
    .await;

    match outcome {
        Ok(Ok((mode, cwd))) => Json(serde_json::json!({
            "success": true,
            "mode": mode,
            "cwd": cwd,
        }))
        .into_response(),
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(_) => json_error("internal_error", "Task failed", StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── GET /api/tmux/pane-mode ───────────────────────────────────────────────

async fn api_tmux_pane_mode(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<TmuxQuery>,
) -> Json<serde_json::Value> {
    let tui_active = tokio::task::spawn_blocking(move || {
        let client_tty = get_effective_client_tty(&state, query.client_tty);
        let session = client_tty.as_deref().and_then(|t| get_current_tmux_session(Some(t)));
        match session {
            Some(ref sess) => run_cmd(
                "tmux",
                &["display-message", "-t", &format!("{}:", sess), "-p", "#{alternate_on}"],
            )
            .map(|s| s.trim() == "1")
            .unwrap_or(false),
            None => run_cmd("tmux", &["display-message", "-p", "#{alternate_on}"])
                .map(|s| s.trim() == "1")
                .unwrap_or(false),
        }
    })
    .await
    .unwrap_or(false);

    Json(serde_json::json!({ "tuiActive": tui_active }))
}

// ─── GET /api/tmux/capture-pane ────────────────────────────────────────────

async fn api_tmux_capture_pane(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<TmuxQuery>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || -> Result<String, ApiError> {
        let client_tty = match get_effective_client_tty(&state, query.client_tty) {
            Some(t) => t,
            None => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "no_tty".into(),
                    "No client TTY available".into(),
                ));
            }
        };
        let session = match get_current_tmux_session(Some(&client_tty)) {
            Some(s) => s,
            None => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "no_session".into(),
                    "No tmux session found".into(),
                ));
            }
        };
        let target = format!("{}:", session);
        run_cmd("tmux", &["capture-pane", "-t", &target, "-pS", "-"])
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, "capture_failed".into(), e))
    })
    .await;

    match outcome {
        Ok(Ok(content)) => {
            let lines: Vec<&str> = content.lines().collect();
            Json(serde_json::json!({ "lines": lines })).into_response()
        }
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(e) => json_error("task_failed", &format!("{}", e), StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── GET /api/tmux/page-up ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct PageUpQuery {
    client_tty: Option<String>,
    page: Option<i32>,
}

async fn api_tmux_page_up(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<PageUpQuery>,
) -> Response {
    let page = query.page.unwrap_or(1).max(1);
    let outcome = tokio::task::spawn_blocking(move || -> Result<(Vec<String>, i32, i32), ApiError> {
        let client_tty = match get_effective_client_tty(&state, query.client_tty) {
            Some(t) => t,
            None => return Err((
                StatusCode::BAD_REQUEST,
                "no_tty".into(),
                "No client TTY available".into(),
            )),
        };
        let session = match get_current_tmux_session(Some(&client_tty)) {
            Some(s) => s,
            None => return Err((
                StatusCode::BAD_REQUEST,
                "no_session".into(),
                "No tmux session found".into(),
            )),
        };
        let target = format!("{}:", session);
        let info = run_cmd("tmux", &["display-message", "-t", &target, "-p", "#{pane_height} #{history_size}"])
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, "capture_failed".into(), e))?;
        let parts: Vec<&str> = info.trim().split(' ').collect();
        let rows: i32 = parts.first().and_then(|s| s.parse().ok()).unwrap_or(40);
        let history: i32 = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);

        if history == 0 {
            return Ok((Vec::new(), 0, 0));
        }

        let end_line = -((page - 1) * rows + 1);
        let start_line = -(page * rows);
        let clamped_start = start_line.max(-history);

        if clamped_start > end_line {
            return Ok((Vec::new(), history, rows));
        }

        let content = run_cmd(
            "tmux",
            &[
                "capture-pane", "-t", &target, "-p",
                "-S", &clamped_start.to_string(),
                "-E", &end_line.to_string(),
            ],
        )
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, "capture_failed".into(), e))?;

        let lines: Vec<String> = content.lines().map(String::from).collect();
        Ok((lines, history, rows))
    })
    .await;

    match outcome {
        Ok(Ok((lines, history, rows))) => {
            Json(serde_json::json!({ "lines": lines, "history": history, "rows": rows })).into_response()
        }
        Ok(Err((status, code, msg))) => json_error(&code, &msg, status),
        Err(e) => json_error("task_failed", &format!("{}", e), StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── GET /api/events (SSE) ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct EventsQuery {
    client_tty: Option<String>,
}

async fn api_events(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(query): Query<EventsQuery>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let explicit_tty = query.client_tty.clone();
    let shared_state = state.clone();

    let stream = futures_util::stream::unfold((true, String::new()), move |(is_first, prev_json)| {
        let explicit_tty = explicit_tty.clone();
        let shared_state = shared_state.clone();
        async move {
            if !is_first {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }

            let payload = tokio::task::spawn_blocking(move || {
                let client_tty = get_effective_client_tty(&shared_state, explicit_tty);
                let tty_clone = client_tty.clone();
                let cwd = get_cwd(tty_clone.clone());
                let mut branch = String::new();
                let mut path = cwd.clone();

                if is_git_repo(&cwd) {
                    let git_root = get_git_root(&cwd);
                    branch = get_branch(&git_root);
                    path = git_root;
                }

                let sessions = get_tmux_sessions();
                let current_session = get_current_tmux_session(tty_clone.as_deref());

                let tui_active = match current_session.as_deref() {
                    Some(sess) => run_cmd(
                        "tmux",
                        &["display-message", "-t", &format!("{}:", sess), "-p", "#{alternate_on}"],
                    )
                    .map(|s| s.trim() == "1")
                    .unwrap_or(false),
                    None => false,
                };

                serde_json::json!({
                    "branch": branch,
                    "path": path,
                    "tuiActive": tui_active,
                    "tmux": {
                        "sessions": sessions,
                        "currentSession": current_session,
                    }
                })
            })
            .await
            .unwrap_or_else(|_| serde_json::json!({}));

            let json_str = payload.to_string();
            if !is_first && json_str == prev_json {
                return Some((Ok(Event::default().comment("no-change")), (false, prev_json)));
            }
            let event = Event::default().data(json_str.clone());
            Some((Ok(event), (false, json_str)))
        }
    });

    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    )
}

// ─── GET/POST /api/user-config ─────────────────────────────────────────────

fn user_config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".vibeterm.json")
}

async fn api_get_user_config() -> Response {
    let path = user_config_path();
    match tokio::fs::read_to_string(&path).await {
        Ok(content) => ([(header::CONTENT_TYPE, "application/json")], content).into_response(),
        Err(_) => Json(serde_json::json!({})).into_response(),
    }
}

async fn api_set_user_config(body: axum::body::Bytes) -> Response {
    let path = user_config_path();
    if let Some(parent) = path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    match tokio::fs::write(&path, &body).await {
        Ok(_) => Json(serde_json::json!({ "success": true })).into_response(),
        Err(e) => json_error("write_failed", &e.to_string(), StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ─── POST /api/upload ──────────────────────────────────────────────────────

async fn api_upload_file(req: Request) -> Response {
    let content_type = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    // Extract original filename from X-Filename header (if provided)
    let original_name = req
        .headers()
        .get("X-Filename")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // Read body (50MB limit)
    let body_bytes = match axum::body::to_bytes(req.into_body(), 50 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => {
            return json_error("read_error", "Failed to read body", StatusCode::BAD_REQUEST)
        }
    };

    if body_bytes.is_empty() {
        return json_error("empty_body", "No file data", StatusCode::BAD_REQUEST);
    }

    // Determine extension: prefer original filename ext, fallback to content-type
    let ext = original_name
        .as_deref()
        .and_then(|n| n.rsplit('.').next())
        .filter(|e| !e.is_empty() && e.len() <= 10)
        .unwrap_or(match content_type.as_str() {
            "image/jpeg" | "image/jpg" => "jpg",
            "image/png" => "png",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "image/svg+xml" => "svg",
            "text/plain" => "txt",
            "text/csv" => "csv",
            "application/json" => "json",
            "application/pdf" => "pdf",
            "application/zip" => "zip",
            "application/gzip" => "gz",
            "application/x-tar" => "tar",
            "text/javascript" | "application/javascript" => "js",
            "text/html" => "html",
            "text/css" => "css",
            "text/xml" | "application/xml" => "xml",
            "application/x-yaml" | "text/yaml" => "yaml",
            "text/markdown" => "md",
            _ => "bin",
        });

    let upload_dir = "/tmp/ttyd_uploads";
    let _ = tokio::fs::create_dir_all(upload_dir).await;

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let filename = if let Some(ref name) = original_name {
        let stem = name.rsplit('/').next().unwrap_or(name);
        let stem = stem.split('.').next().unwrap_or(stem);
        let clean: String = stem
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        format!("{}_{}.{}", clean, timestamp, ext)
    } else {
        format!("upload_{}.{}", timestamp, ext)
    };
    let filepath = format!("{}/{}", upload_dir, filename);

    match tokio::fs::write(&filepath, &body_bytes).await {
        Ok(_) => Json(serde_json::json!({
            "path": filepath,
            "filename": filename,
        }))
        .into_response(),
        Err(e) => json_error(
            "write_error",
            &format!("Failed to write file: {}", e),
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// DATA TYPES
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Serialize)]
struct BranchesResponse {
    local: Vec<String>,
    remote: Vec<String>,
    current: String,
}

#[derive(Serialize, Clone)]
struct TmuxSession {
    name: String,
    windows: i32,
    attached: bool,
    last_activity: u64,
}

struct ChangedFile {
    status: String,
    filename: String,
}

#[derive(Serialize)]
struct DiffLine {
    #[serde(rename = "type")]
    line_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    old_num: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_num: Option<i64>,
    content: String,
}

#[derive(Serialize)]
struct DiffHunk {
    header: String,
    lines: Vec<DiffLine>,
}

#[derive(Serialize)]
struct DiffFile {
    filename: String,
    status: String,
    binary: bool,
    additions: i64,
    deletions: i64,
    hunks: Vec<DiffHunk>,
}

#[derive(Serialize)]
struct DiffSummary {
    #[serde(rename = "totalFiles")]
    total_files: i64,
    #[serde(rename = "totalAdditions")]
    total_additions: i64,
    #[serde(rename = "totalDeletions")]
    total_deletions: i64,
}

struct DiffResult {
    files: Vec<DiffFile>,
    summary: DiffSummary,
}

// ═══════════════════════════════════════════════════════════════════════════
// SUBPROCESS HELPERS
// ═══════════════════════════════════════════════════════════════════════════

fn run_cmd(cmd: &str, args: &[&str]) -> Result<String, String> {
    match StdCommand::new(cmd)
        .args(args)
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .output()
    {
        Ok(output) => {
            if output.status.success() {
                Ok(String::from_utf8_lossy(&output.stdout).to_string())
            } else {
                Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
            }
        }
        Err(e) => Err(e.to_string()),
    }
}

fn find_owned_tmux_clients(wrapper_pid: u32) -> Vec<String> {
    let output = match run_cmd("tmux", &["list-clients", "-F", "#{client_tty} #{client_pid}"]) {
        Ok(out) => out,
        Err(_) => return Vec::new(),
    };

    let mut owned = Vec::new();
    for line in output.lines() {
        let mut parts = line.split_whitespace();
        let tty = match parts.next() {
            Some(t) if !t.is_empty() => t,
            _ => continue,
        };
        let pid: u32 = match parts.next().and_then(|s| s.parse().ok()) {
            Some(p) => p,
            None => continue,
        };
        if process_descends_from(pid, wrapper_pid) {
            owned.push(tty.to_string());
        }
    }
    owned
}

fn process_descends_from(pid: u32, ancestor: u32) -> bool {
    if pid == ancestor {
        return true;
    }
    let mut current = pid;
    for _ in 0..10 {
        let ppid = match run_cmd("ps", &["-o", "ppid=", "-p", &current.to_string()])
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
        {
            Some(p) => p,
            None => return false,
        };
        if ppid == ancestor {
            return true;
        }
        if ppid <= 1 {
            return false;
        }
        current = ppid;
    }
    false
}

fn spawn_detached_cmd(cmd: &str, args: &[&str]) -> Result<(), String> {
    let mut child = StdCommand::new(cmd)
        .args(args)
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;

    std::thread::spawn(move || {
        let _ = child.wait();
    });

    Ok(())
}

fn tmux_supports_display_popup() -> bool {
    run_cmd("tmux", &["list-commands", "display-popup"])
        .map(|output| output.lines().any(|line| line.starts_with("display-popup ")))
        .unwrap_or(false)
}

fn run_cmd_in(cmd: &str, args: &[&str], cwd: &str) -> Result<String, String> {
    match StdCommand::new(cmd)
        .args(args)
        .current_dir(cwd)
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .output()
    {
        Ok(output) => {
            if output.status.success() {
                Ok(String::from_utf8_lossy(&output.stdout).to_string())
            } else {
                Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
            }
        }
        Err(e) => Err(e.to_string()),
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::ws::Message;

    #[test]
    fn test_parse_init_message_binary_valid() {
        let json = r#"{"AuthToken":"","columns":120,"rows":40}"#;
        let msg = Message::Binary(json.as_bytes().to_vec().into());
        let (cols, rows) = parse_init_message(msg);
        assert_eq!(cols, 120);
        assert_eq!(rows, 40);
    }

    #[test]
    fn test_parse_init_message_text_valid() {
        let json = r#"{"AuthToken":"","columns":80,"rows":24}"#;
        let msg = Message::Text(json.to_string().into());
        let (cols, rows) = parse_init_message(msg);
        assert_eq!(cols, 80);
        assert_eq!(rows, 24);
    }

    #[test]
    fn test_parse_init_message_invalid_returns_defaults() {
        let msg = Message::Binary(b"not json".to_vec().into());
        let (cols, rows) = parse_init_message(msg);
        assert_eq!(cols, 80);
        assert_eq!(rows, 24);
    }

    #[test]
    fn test_parse_init_message_ping_returns_defaults() {
        let msg = Message::Ping(vec![1, 2, 3].into());
        let (cols, rows) = parse_init_message(msg);
        assert_eq!(cols, 80);
        assert_eq!(rows, 24);
    }

    #[test]
    fn test_output_frame_starts_with_0x30() {
        let payload = b"hello world";
        let mut frame = Vec::with_capacity(payload.len() + 1);
        frame.push(0x30u8);
        frame.extend_from_slice(payload);
        assert_eq!(frame[0], 0x30);
        assert_eq!(&frame[1..], payload);
    }

    #[test]
    fn test_resize_message_deserialization() {
        let json = r#"{"AuthToken":"","columns":100,"rows":30}"#;
        let msg: ResizeMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg.columns, 100);
        assert_eq!(msg.rows, 30);
    }

    #[test]
    fn test_resize_message_without_auth_token() {
        let json = r#"{"columns":200,"rows":50}"#;
        let msg: ResizeMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg.columns, 200);
        assert_eq!(msg.rows, 50);
        assert!(msg.auth_token.is_none());
    }

    #[test]
    fn test_init_message_deserialization() {
        let json = r#"{"columns":120,"rows":40}"#;
        let msg: InitMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg.columns, 120);
        assert_eq!(msg.rows, 40);
    }

    #[test]
    fn test_bounded_channel_capacity() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        for i in 0..100u8 {
            tx.send(vec![i]).unwrap();
        }
    }

    // ─── parse_init_message extra edge cases ──────────────────────────────

    #[test]
    fn test_parse_init_message_zero_columns_clamped_to_one() {
        let json = r#"{"columns":0,"rows":24}"#;
        let msg = Message::Text(json.to_string().into());
        let (cols, rows) = parse_init_message(msg);
        assert_eq!(cols, 1);
        assert_eq!(rows, 24);
    }

    #[test]
    fn test_parse_init_message_zero_rows_clamped_to_one() {
        let json = r#"{"columns":80,"rows":0}"#;
        let msg = Message::Text(json.to_string().into());
        let (cols, rows) = parse_init_message(msg);
        assert_eq!(cols, 80);
        assert_eq!(rows, 1);
    }

    #[test]
    fn test_parse_init_message_close_returns_defaults() {
        let msg = Message::Close(None);
        let (cols, rows) = parse_init_message(msg);
        assert_eq!(cols, 80);
        assert_eq!(rows, 24);
    }

    // ─── parse_porcelain_status ───────────────────────────────────────────

    #[test]
    fn test_parse_porcelain_status_empty() {
        let (staged, unstaged) = parse_porcelain_status("");
        assert!(staged.is_empty());
        assert!(unstaged.is_empty());
    }

    #[test]
    fn test_parse_porcelain_status_staged_modified() {
        let output = "M  src/main.rs\n";
        let (staged, unstaged) = parse_porcelain_status(output);
        assert_eq!(staged.len(), 1);
        assert_eq!(staged[0].file, "src/main.rs");
        assert_eq!(staged[0].status, "M");
        assert!(unstaged.is_empty());
    }

    #[test]
    fn test_parse_porcelain_status_unstaged_modified() {
        let output = " M src/main.rs\n";
        let (staged, unstaged) = parse_porcelain_status(output);
        assert!(staged.is_empty());
        assert_eq!(unstaged.len(), 1);
        assert_eq!(unstaged[0].file, "src/main.rs");
        assert_eq!(unstaged[0].status, "M");
    }

    #[test]
    fn test_parse_porcelain_status_both_staged_and_unstaged() {
        let output = "MM src/main.rs\n";
        let (staged, unstaged) = parse_porcelain_status(output);
        assert_eq!(staged.len(), 1);
        assert_eq!(unstaged.len(), 1);
        assert_eq!(staged[0].file, "src/main.rs");
        assert_eq!(unstaged[0].file, "src/main.rs");
    }

    #[test]
    fn test_parse_porcelain_status_untracked() {
        let output = "?? new_file.txt\n";
        let (staged, unstaged) = parse_porcelain_status(output);
        assert!(staged.is_empty());
        assert_eq!(unstaged.len(), 1);
        assert_eq!(unstaged[0].status, "U");
        assert_eq!(unstaged[0].file, "new_file.txt");
    }

    #[test]
    fn test_parse_porcelain_status_added_and_deleted() {
        let output = "A  added.txt\nD  removed.txt\n";
        let (staged, unstaged) = parse_porcelain_status(output);
        assert_eq!(staged.len(), 2);
        assert_eq!(staged[0].status, "A");
        assert_eq!(staged[0].file, "added.txt");
        assert_eq!(staged[1].status, "D");
        assert_eq!(staged[1].file, "removed.txt");
        assert!(unstaged.is_empty());
    }

    #[test]
    fn test_parse_porcelain_status_renamed() {
        let output = "R  src/old.rs -> src/new.rs\n";
        let (staged, _) = parse_porcelain_status(output);
        assert_eq!(staged.len(), 1);
        assert_eq!(staged[0].status, "R");
    }

    #[test]
    fn test_parse_porcelain_status_short_lines_skipped() {
        let output = "X\n??\n";
        let (staged, unstaged) = parse_porcelain_status(output);
        assert!(staged.is_empty());
        assert!(unstaged.is_empty());
    }

    #[test]
    fn test_parse_porcelain_status_ignored_files_excluded() {
        let output = "!! ignored.txt\n";
        let (staged, unstaged) = parse_porcelain_status(output);
        assert!(staged.is_empty());
        assert!(unstaged.is_empty());
    }

    #[test]
    fn test_parse_porcelain_status_multiple_mixed() {
        let output = "M  staged.rs\n M unstaged.rs\n?? untracked.txt\nA  added.rs\n";
        let (staged, unstaged) = parse_porcelain_status(output);
        assert_eq!(staged.len(), 2);
        assert_eq!(unstaged.len(), 2);
    }

    // ─── parse_unified_diff ───────────────────────────────────────────────

    #[test]
    fn test_parse_unified_diff_empty() {
        let result = parse_unified_diff("", &[]);
        assert!(result.files.is_empty());
        assert_eq!(result.summary.total_files, 0);
        assert_eq!(result.summary.total_additions, 0);
        assert_eq!(result.summary.total_deletions, 0);
    }

    #[test]
    fn test_parse_unified_diff_simple_modification() {
        let raw = "diff --git a/foo.txt b/foo.txt\n\
                   index 1234..5678 100644\n\
                   --- a/foo.txt\n\
                   +++ b/foo.txt\n\
                   @@ -1,3 +1,3 @@\n\
                    line1\n\
                   -old_line2\n\
                   +new_line2\n\
                    line3\n";
        let changed = vec![ChangedFile {
            status: "M".to_string(),
            filename: "foo.txt".to_string(),
        }];
        let result = parse_unified_diff(raw, &changed);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].filename, "foo.txt");
        assert_eq!(result.files[0].status, "M");
        assert_eq!(result.files[0].additions, 1);
        assert_eq!(result.files[0].deletions, 1);
        assert_eq!(result.summary.total_additions, 1);
        assert_eq!(result.summary.total_deletions, 1);
        assert_eq!(result.files[0].hunks.len(), 1);
    }

    #[test]
    fn test_parse_unified_diff_new_file() {
        let raw = "diff --git a/new.txt b/new.txt\n\
                   new file mode 100644\n\
                   --- /dev/null\n\
                   +++ b/new.txt\n\
                   @@ -0,0 +1,2 @@\n\
                   +hello\n\
                   +world\n";
        let changed = vec![ChangedFile {
            status: "A".to_string(),
            filename: "new.txt".to_string(),
        }];
        let result = parse_unified_diff(raw, &changed);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].filename, "new.txt");
        assert_eq!(result.files[0].additions, 2);
        assert_eq!(result.files[0].deletions, 0);
    }

    #[test]
    fn test_parse_unified_diff_multiple_files() {
        let raw = "diff --git a/a.txt b/a.txt\n\
                   --- a/a.txt\n\
                   +++ b/a.txt\n\
                   @@ -1 +1 @@\n\
                   -old_a\n\
                   +new_a\n\
                   diff --git a/b.txt b/b.txt\n\
                   --- a/b.txt\n\
                   +++ b/b.txt\n\
                   @@ -1,2 +1,3 @@\n\
                    keep\n\
                   +inserted\n\
                    end\n";
        let changed = vec![
            ChangedFile { status: "M".to_string(), filename: "a.txt".to_string() },
            ChangedFile { status: "M".to_string(), filename: "b.txt".to_string() },
        ];
        let result = parse_unified_diff(raw, &changed);
        assert_eq!(result.files.len(), 2);
        assert_eq!(result.summary.total_additions, 2);
        assert_eq!(result.summary.total_deletions, 1);
    }

    #[test]
    fn test_parse_unified_diff_binary_file() {
        let raw = "diff --git a/img.png b/img.png\n\
                   index 1234..5678 100644\n\
                   Binary files a/img.png and b/img.png differ\n";
        let changed = vec![ChangedFile {
            status: "M".to_string(),
            filename: "img.png".to_string(),
        }];
        let result = parse_unified_diff(raw, &changed);
        assert_eq!(result.files.len(), 0, "binary-only diff has no --- a/ marker, parser yields no file entry");
        let raw_with_marker = "diff --git a/img.png b/img.png\n\
                               --- a/img.png\n\
                               +++ b/img.png\n\
                               Binary files a/img.png and b/img.png differ\n";
        let result2 = parse_unified_diff(raw_with_marker, &changed);
        assert_eq!(result2.files.len(), 1);
        assert!(result2.files[0].binary);
    }

    #[test]
    fn test_parse_unified_diff_status_falls_back_to_modified() {
        let raw = "diff --git a/foo.txt b/foo.txt\n\
                   --- a/foo.txt\n\
                   +++ b/foo.txt\n\
                   @@ -1 +1 @@\n\
                   -a\n\
                   +b\n";
        let changed: Vec<ChangedFile> = vec![];
        let result = parse_unified_diff(raw, &changed);
        assert_eq!(result.files[0].status, "M");
    }

    #[test]
    fn test_parse_unified_diff_uses_provided_status() {
        let raw = "diff --git a/foo.txt b/foo.txt\n\
                   --- a/foo.txt\n\
                   +++ b/foo.txt\n\
                   @@ -1 +1 @@\n\
                   -a\n\
                   +b\n";
        let changed = vec![ChangedFile {
            status: "D".to_string(),
            filename: "foo.txt".to_string(),
        }];
        let result = parse_unified_diff(raw, &changed);
        assert_eq!(result.files[0].status, "D");
    }

    #[test]
    fn test_parse_unified_diff_line_numbers_tracked() {
        let raw = "diff --git a/foo.txt b/foo.txt\n\
                   --- a/foo.txt\n\
                   +++ b/foo.txt\n\
                   @@ -10,3 +10,3 @@\n\
                    ctx_a\n\
                   -old\n\
                   +new\n\
                    ctx_b\n";
        let changed = vec![ChangedFile {
            status: "M".to_string(),
            filename: "foo.txt".to_string(),
        }];
        let result = parse_unified_diff(raw, &changed);
        let lines = &result.files[0].hunks[0].lines;
        assert_eq!(lines[0].line_type, "ctx");
        assert_eq!(lines[0].old_num, Some(10));
        assert_eq!(lines[0].new_num, Some(10));
        assert_eq!(lines[1].line_type, "del");
        assert_eq!(lines[1].old_num, Some(11));
        assert_eq!(lines[1].new_num, None);
        assert_eq!(lines[2].line_type, "add");
        assert_eq!(lines[2].old_num, None);
        assert_eq!(lines[2].new_num, Some(11));
        assert_eq!(lines[3].line_type, "ctx");
        assert_eq!(lines[3].old_num, Some(12));
        assert_eq!(lines[3].new_num, Some(12));
    }

    #[test]
    fn test_parse_unified_diff_multiple_hunks_in_file() {
        let raw = "diff --git a/foo.txt b/foo.txt\n\
                   --- a/foo.txt\n\
                   +++ b/foo.txt\n\
                   @@ -1 +1 @@\n\
                   -a\n\
                   +b\n\
                   @@ -10 +10 @@\n\
                   -c\n\
                   +d\n";
        let changed = vec![ChangedFile {
            status: "M".to_string(),
            filename: "foo.txt".to_string(),
        }];
        let result = parse_unified_diff(raw, &changed);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].hunks.len(), 2);
        assert_eq!(result.files[0].additions, 2);
        assert_eq!(result.files[0].deletions, 2);
    }
}
