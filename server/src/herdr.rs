use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    net::UnixStream,
    process::{Child, ChildStdin, ChildStdout, Command},
};

// ─── Protocol compatibility ───────────────────────────────────────────────

pub const MIN_SUPPORTED_PROTOCOL: u64 = 20;

pub fn is_supported_protocol(protocol: u64) -> bool {
    protocol >= MIN_SUPPORTED_PROTOCOL
}

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
pub enum TerminalEvent {
    Frame {
        bytes: bytes::Bytes,
        full: Option<bool>,
    },
    Closed(String),
}

pub struct TerminalController {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
}

pub struct TerminalProcess {
    #[allow(dead_code)]
    child: Child,
}

pub struct TerminalReader {
    stdout: Lines<BufReader<ChildStdout>>,
}

pub struct TerminalWriter {
    stdin: ChildStdin,
}

pub struct EventSubscription {
    reader: Lines<BufReader<UnixStream>>,
}

impl TerminalController {
    pub async fn spawn(pane_id: &str, cols: u16, rows: u16) -> Result<Self, String> {
        if pane_id.trim().is_empty() {
            return Err("pane id is required".to_string());
        }

        let mut child = Command::new(herdr_binary())
            .args([
                "terminal",
                "session",
                "control",
                pane_id,
                "--takeover",
                "--cols",
                &cols.max(1).to_string(),
                "--rows",
                &rows.max(1).to_string(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("Failed to start herdr terminal controller: {}", error))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open herdr controller stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to open herdr controller stdout".to_string())?;

        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::warn!("herdr terminal controller: {}", line);
                }
            });
        }

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout).lines(),
        })
    }

    pub fn split(self) -> (TerminalProcess, TerminalReader, TerminalWriter) {
        (
            TerminalProcess { child: self.child },
            TerminalReader {
                stdout: self.stdout,
            },
            TerminalWriter { stdin: self.stdin },
        )
    }
}

impl TerminalReader {
    pub async fn next_event(&mut self) -> Result<TerminalEvent, String> {
        match self.stdout.next_line().await {
            Ok(Some(line)) => parse_terminal_line(&line),
            Ok(None) => Err("herdr terminal controller closed its output stream".to_string()),
            Err(error) => Err(format!("Failed reading herdr terminal stream: {}", error)),
        }
    }
}

impl TerminalWriter {
    pub async fn send_input(&mut self, data: &[u8]) -> Result<(), String> {
        self.write_command(json!({
            "type": "terminal.input",
            "bytes": BASE64.encode(data),
        }))
        .await
    }

    pub async fn resize(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        self.write_command(json!({
            "type": "terminal.resize",
            "cols": cols.max(1),
            "rows": rows.max(1),
        }))
        .await
    }

    pub async fn release(&mut self) -> Result<(), String> {
        self.write_command(json!({ "type": "terminal.release" }))
            .await
    }

    async fn write_command(&mut self, command: Value) -> Result<(), String> {
        let mut encoded = serde_json::to_vec(&command)
            .map_err(|error| format!("Failed encoding herdr terminal command: {}", error))?;
        encoded.push(b'\n');
        self.stdin
            .write_all(&encoded)
            .await
            .map_err(|error| format!("Failed writing herdr terminal command: {}", error))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| format!("Failed flushing herdr terminal command: {}", error))
    }
}

pub async fn request(method: &str, params: Value) -> Result<Value, String> {
    let socket_path = socket_path()?;
    let mut stream = UnixStream::connect(&socket_path).await.map_err(|error| {
        format!(
            "Failed to connect to herdr at {}: {}",
            socket_path.display(),
            error
        )
    })?;
    let id = format!(
        "rust-terminal:{}",
        NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
    );
    let envelope = request_envelope(&id, method, params);
    let mut encoded = serde_json::to_vec(&envelope)
        .map_err(|error| format!("Failed encoding herdr request: {}", error))?;
    encoded.push(b'\n');
    stream
        .write_all(&encoded)
        .await
        .map_err(|error| format!("Failed writing herdr request: {}", error))?;
    stream
        .flush()
        .await
        .map_err(|error| format!("Failed flushing herdr request: {}", error))?;

    let mut response = String::new();
    BufReader::new(stream)
        .read_line(&mut response)
        .await
        .map_err(|error| format!("Failed reading herdr response: {}", error))?;
    if response.trim().is_empty() {
        return Err("herdr returned an empty response".to_string());
    }

    parse_response(&id, &response)
}

pub async fn list() -> Result<Value, String> {
    let (panes, workspaces, tabs, agents) = tokio::try_join!(
        request("pane.list", json!({})),
        request("workspace.list", json!({})),
        request("tab.list", json!({})),
        request("agent.list", json!({})),
    )?;
    let lens = lens_root().await;
    let mut panes = panes.get("panes").cloned().unwrap_or_else(|| json!([]));
    if let Some(root) = lens.as_deref() {
        mark_lens_chat_panes(&mut panes, root);
    }

    Ok(json!({
        "mux": "herdr",
        "protocol": MIN_SUPPORTED_PROTOCOL,
        "panes": panes,
        "workspaces": workspaces.get("workspaces").cloned().unwrap_or_else(|| json!([])),
        "tabs": tabs.get("tabs").cloned().unwrap_or_else(|| json!([])),
        "agents": agents.get("agents").cloned().unwrap_or_else(|| json!([])),
        "lens": { "chat": lens.is_some() },
    }))
}

// ─── herdr-lens chat view ─────────────────────────────────────────────────

const LENS_PLUGIN_ID: &str = "herdr-lens";
const LENS_BINARY: &str = "target/release/herdr-lens";
const LENS_CHAT_ENTRYPOINT: &str = "chat";
const LENS_CHAT_LABEL: &str = "Chat";
const LENS_TARGET_ENV: &str = "HERDR_LENS_TARGET";
const LENS_AGENTS: [&str; 2] = ["claude", "codex"];
const LENS_CACHE_TTL: Duration = Duration::from_secs(60);

static LENS_CACHE: Mutex<Option<(Instant, Option<PathBuf>)>> = Mutex::new(None);

fn lens_plugin_root(plugins: &Value) -> Option<PathBuf> {
    let plugin = plugins
        .get("plugins")?
        .as_array()?
        .iter()
        .find(|plugin| plugin.get("plugin_id").and_then(Value::as_str) == Some(LENS_PLUGIN_ID))?;
    if !plugin
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    plugin
        .get("plugin_root")
        .and_then(Value::as_str)
        .filter(|root| !root.is_empty())
        .map(PathBuf::from)
}

/// `herdr plugin link` does not compile the plugin, so an unbuilt one counts as missing.
pub async fn lens_root() -> Option<PathBuf> {
    if let Ok(cache) = LENS_CACHE.lock() {
        if let Some((checked_at, root)) = cache.as_ref() {
            if checked_at.elapsed() < LENS_CACHE_TTL {
                return root.clone();
            }
        }
    }
    let root = match request("plugin.list", json!({})).await {
        Ok(plugins) => match lens_plugin_root(&plugins) {
            Some(root) => {
                let built = tokio::fs::metadata(root.join(LENS_BINARY))
                    .await
                    .map(|metadata| metadata.is_file())
                    .unwrap_or(false);
                if !built {
                    tracing::warn!("herdr-lens at {} is not built", root.display());
                }
                built.then_some(root)
            }
            None => None,
        },
        Err(error) => {
            tracing::warn!("herdr plugin.list failed: {}", error);
            None
        }
    };
    if let Ok(mut cache) = LENS_CACHE.lock() {
        *cache = Some((Instant::now(), root.clone()));
    }
    root
}

/// Herdr reports plugin panes like any other pane; a chat view is the one herdr-lens
/// runs from its root under the label `Chat`. Marking it lets the browser route taps
/// and wheel to it, since herdr frames never carry the TUI's mouse-mode setup.
fn mark_lens_chat_panes(panes: &mut Value, root: &Path) {
    let Some(panes) = panes.as_array_mut() else {
        return;
    };
    for pane in panes {
        let in_root = ["cwd", "foreground_cwd"]
            .iter()
            .any(|key| pane.get(*key).and_then(Value::as_str).map(Path::new) == Some(root));
        let labelled = pane.get("label").and_then(Value::as_str) == Some(LENS_CHAT_LABEL);
        let agent = pane.get("agent").and_then(Value::as_str).is_some();
        if in_root && labelled && !agent {
            pane["lens_chat"] = json!(true);
        }
    }
}

fn check_lens_target(panes: &Value, target: &str) -> Result<(), String> {
    let pane = panes
        .get("panes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|pane| pane.get("pane_id").and_then(Value::as_str) == Some(target))
        .ok_or_else(|| format!("找不到窗格 {}", target))?;
    match pane.get("agent").and_then(Value::as_str) {
        Some(agent) if LENS_AGENTS.contains(&agent) => Ok(()),
        _ => Err(format!("窗格 {} 里没有运行 Claude Code 或 Codex", target)),
    }
}

fn lens_chat_params(target: &str) -> Value {
    json!({
        "plugin_id": LENS_PLUGIN_ID,
        "entrypoint": LENS_CHAT_ENTRYPOINT,
        "env": { LENS_TARGET_ENV: target },
        "focus": true,
        "placement": "overlay",
    })
}

fn lens_chat_pane_id(opened: &Value) -> Option<String> {
    opened
        .pointer("/plugin_pane/pane/pane_id")
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub async fn open_lens_chat(target: &str) -> Result<String, String> {
    let panes = request("pane.list", json!({})).await?;
    check_lens_target(&panes, target)?;
    // Overlay plugin panes always cover herdr's active pane.
    request("pane.focus", json!({ "pane_id": target })).await?;
    let opened = request("plugin.pane.open", lens_chat_params(target)).await?;
    lens_chat_pane_id(&opened).ok_or_else(|| "herdr did not return the chat pane".to_string())
}

pub async fn protocol_version() -> Result<u64, String> {
    let output = Command::new(herdr_binary())
        .args(["api", "schema", "--json"])
        .output()
        .await
        .map_err(|error| format!("Failed to inspect herdr protocol: {}", error))?;
    if !output.status.success() {
        return Err(format!(
            "herdr api schema failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let schema: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Invalid herdr schema output: {}", error))?;
    schema
        .get("protocol")
        .and_then(Value::as_u64)
        .ok_or_else(|| "herdr schema did not include protocol".to_string())
}

fn herdr_binary() -> PathBuf {
    if let Some(path) = std::env::var_os("HERDR_BIN_PATH").filter(|path| !path.is_empty()) {
        return PathBuf::from(path);
    }
    herdr_binary_candidates(
        std::env::var_os("HOME").map(PathBuf::from),
        std::env::var_os("PATH"),
    )
    .into_iter()
    .find(|path| path.is_file())
    .unwrap_or_else(|| PathBuf::from("herdr"))
}

// `herdr update` installs to ~/.local/bin, so a package-manager copy elsewhere may be
// an older release whose controller cannot talk to the running server.
fn herdr_binary_candidates(
    home: Option<PathBuf>,
    path_var: Option<std::ffi::OsString>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(home) = home {
        candidates.push(home.join(".local/bin/herdr"));
    }
    if let Some(path_var) = path_var {
        candidates.extend(std::env::split_paths(&path_var).map(|dir| dir.join("herdr")));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/herdr"));
    candidates.push(PathBuf::from("/usr/local/bin/herdr"));
    candidates
}

impl EventSubscription {
    pub async fn connect(pane_ids: &[String]) -> Result<Self, String> {
        let socket_path = socket_path()?;
        let mut stream = UnixStream::connect(&socket_path).await.map_err(|error| {
            format!(
                "Failed to connect to herdr events at {}: {}",
                socket_path.display(),
                error
            )
        })?;
        let id = format!(
            "rust-terminal-events:{}",
            NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
        );
        // Renames from any Herdr client must reach the sidebar without waiting for maintenance.
        let mut subscriptions = vec![
            json!({ "type": "pane.agent_detected" }),
            json!({ "type": "workspace.renamed" }),
            json!({ "type": "tab.renamed" }),
        ];
        subscriptions.extend(pane_ids.iter().map(|pane_id| {
            json!({
                "type": "pane.agent_status_changed",
                "pane_id": pane_id,
            })
        }));
        let envelope = request_envelope(
            &id,
            "events.subscribe",
            json!({ "subscriptions": subscriptions }),
        );
        let mut encoded = serde_json::to_vec(&envelope)
            .map_err(|error| format!("Failed encoding herdr subscription: {}", error))?;
        encoded.push(b'\n');
        stream
            .write_all(&encoded)
            .await
            .map_err(|error| format!("Failed writing herdr subscription: {}", error))?;
        stream
            .flush()
            .await
            .map_err(|error| format!("Failed flushing herdr subscription: {}", error))?;

        let mut reader = BufReader::new(stream).lines();
        let acknowledgement = reader
            .next_line()
            .await
            .map_err(|error| format!("Failed reading herdr subscription response: {}", error))?
            .ok_or_else(|| "herdr closed the subscription before acknowledgement".to_string())?;
        parse_response(&id, &acknowledgement)?;
        Ok(Self { reader })
    }

    pub async fn next_event(&mut self) -> Result<Value, String> {
        let line = self
            .reader
            .next_line()
            .await
            .map_err(|error| format!("Failed reading herdr event: {}", error))?
            .ok_or_else(|| "herdr event subscription disconnected".to_string())?;
        let value: Value = serde_json::from_str(&line)
            .map_err(|error| format!("Invalid herdr event: {}", error))?;
        if value.get("event").and_then(Value::as_str).is_none() {
            return Err("herdr event did not include event name".to_string());
        }
        Ok(value)
    }
}

fn request_envelope(id: &str, method: &str, params: Value) -> Value {
    json!({
        "id": id,
        "method": method,
        "params": params,
    })
}

fn parse_response(expected_id: &str, response: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(response)
        .map_err(|error| format!("Invalid herdr response: {}", error))?;
    if value.get("id").and_then(Value::as_str) != Some(expected_id) {
        return Err("herdr response id did not match request".to_string());
    }
    if let Some(error) = value.get("error") {
        let code = error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("unknown_error");
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Unknown herdr error");
        return Err(format!("{}: {}", code, message));
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| "herdr response did not include result".to_string())
}

fn parse_terminal_line(line: &str) -> Result<TerminalEvent, String> {
    let value: Value = serde_json::from_str(line)
        .map_err(|error| format!("Invalid herdr terminal message: {}", error))?;
    match value.get("type").and_then(Value::as_str) {
        Some("terminal.frame") => {
            let encoded = value
                .get("bytes")
                .and_then(Value::as_str)
                .ok_or_else(|| "herdr terminal frame did not include bytes".to_string())?;
            BASE64
                .decode(encoded)
                .map(bytes::Bytes::from)
                .map(|bytes| TerminalEvent::Frame {
                    bytes,
                    full: value.get("full").and_then(Value::as_bool),
                })
                .map_err(|error| format!("Invalid base64 in herdr terminal frame: {}", error))
        }
        Some("terminal.closed") => Ok(TerminalEvent::Closed(
            value
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("herdr terminal controller closed")
                .to_string(),
        )),
        Some(message_type) => Err(format!(
            "Unexpected herdr terminal message type: {}",
            message_type
        )),
        None => Err("herdr terminal message did not include type".to_string()),
    }
}

fn socket_path() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("HERDR_SOCKET_PATH") {
        return Ok(PathBuf::from(path));
    }
    let home = std::env::var("HOME")
        .map_err(|_| "HOME is not set and HERDR_SOCKET_PATH was not provided".to_string())?;
    Ok(PathBuf::from(home).join(".config/herdr/herdr.sock"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn herdr_update_location_wins_over_path_and_homebrew() {
        let candidates = herdr_binary_candidates(
            Some(PathBuf::from("/home/u")),
            Some(std::ffi::OsString::from("/opt/homebrew/bin:/usr/bin")),
        );
        assert_eq!(
            candidates,
            vec![
                PathBuf::from("/home/u/.local/bin/herdr"),
                PathBuf::from("/opt/homebrew/bin/herdr"),
                PathBuf::from("/usr/bin/herdr"),
                PathBuf::from("/opt/homebrew/bin/herdr"),
                PathBuf::from("/usr/local/bin/herdr"),
            ]
        );
    }

    fn plugin_list(enabled: bool, root: &str) -> Value {
        json!({
            "type": "plugin_list",
            "plugins": [
                { "plugin_id": "other", "enabled": true, "plugin_root": "/x" },
                { "plugin_id": "herdr-lens", "enabled": enabled, "plugin_root": root },
            ]
        })
    }

    #[test]
    fn lens_root_requires_an_enabled_herdr_lens() {
        assert_eq!(
            lens_plugin_root(&plugin_list(true, "/p/herdr-lens")),
            Some(PathBuf::from("/p/herdr-lens"))
        );
        assert_eq!(lens_plugin_root(&plugin_list(false, "/p/herdr-lens")), None);
        assert_eq!(lens_plugin_root(&plugin_list(true, "")), None);
        assert_eq!(
            lens_plugin_root(&json!({ "plugins": [{ "plugin_id": "other", "enabled": true, "plugin_root": "/x" }] })),
            None
        );
        assert_eq!(lens_plugin_root(&json!({})), None);
    }

    #[test]
    fn marks_only_chat_panes_run_from_the_lens_root() {
        let mut panes = json!([
            { "pane_id": "w:p1", "label": "Chat", "cwd": "/p/herdr-lens" },
            { "pane_id": "w:p2", "label": "Chat", "cwd": "/elsewhere" },
            { "pane_id": "w:p3", "cwd": "/p/herdr-lens" },
            { "pane_id": "w:p4", "label": "Chat", "cwd": "/p/herdr-lens", "agent": "claude" },
            { "pane_id": "w:p5", "label": "Chat", "cwd": "/tmp", "foreground_cwd": "/p/herdr-lens" },
        ]);
        mark_lens_chat_panes(&mut panes, Path::new("/p/herdr-lens"));
        let marked: Vec<&str> = panes
            .as_array()
            .unwrap()
            .iter()
            .filter(|pane| pane.get("lens_chat") == Some(&json!(true)))
            .filter_map(|pane| pane.get("pane_id").and_then(Value::as_str))
            .collect();
        assert_eq!(marked, vec!["w:p1", "w:p5"]);
    }

    #[test]
    fn lens_target_must_be_a_claude_or_codex_pane() {
        let panes = json!({ "panes": [
            { "pane_id": "w:p1", "agent": "claude" },
            { "pane_id": "w:p2", "agent": "codex" },
            { "pane_id": "w:p3", "agent": "pi" },
            { "pane_id": "w:p4" },
        ]});
        assert!(check_lens_target(&panes, "w:p1").is_ok());
        assert!(check_lens_target(&panes, "w:p2").is_ok());
        assert!(check_lens_target(&panes, "w:p3").unwrap_err().contains("Claude Code 或 Codex"));
        assert!(check_lens_target(&panes, "w:p4").is_err());
        assert!(check_lens_target(&panes, "w:p9").unwrap_err().contains("找不到"));
    }

    #[test]
    fn lens_chat_opens_as_an_overlay_aimed_at_the_target() {
        assert_eq!(
            lens_chat_params("w:p1"),
            json!({
                "plugin_id": "herdr-lens",
                "entrypoint": "chat",
                "env": { "HERDR_LENS_TARGET": "w:p1" },
                "focus": true,
                "placement": "overlay",
            })
        );
        let opened = json!({
            "type": "plugin_pane_opened",
            "plugin_pane": { "plugin_id": "herdr-lens", "entrypoint": "chat", "pane": { "pane_id": "w:p7" } }
        });
        assert_eq!(lens_chat_pane_id(&opened), Some("w:p7".to_string()));
        assert_eq!(lens_chat_pane_id(&json!({ "type": "ok" })), None);
    }

    #[test]
    fn supported_protocol_accepts_min_and_newer() {
        assert!(!is_supported_protocol(19));
        assert!(is_supported_protocol(20));
        assert!(is_supported_protocol(22));
    }

    #[test]
    fn request_envelope_always_includes_method_and_params() {
        let value = request_envelope("request-1", "pane.list", json!({}));
        assert_eq!(value["id"], "request-1");
        assert_eq!(value["method"], "pane.list");
        assert_eq!(value["params"], json!({}));
        assert!(value.get("type").is_none());
    }

    #[test]
    fn parses_success_and_error_responses() {
        let success = parse_response(
            "request-1",
            r#"{"id":"request-1","result":{"type":"pong"}}"#,
        )
        .unwrap();
        assert_eq!(success["type"], "pong");

        let error = parse_response(
            "request-2",
            r#"{"id":"request-2","error":{"code":"not_found","message":"missing"}}"#,
        )
        .unwrap_err();
        assert_eq!(error, "not_found: missing");
    }

    #[test]
    fn decodes_terminal_frames_and_preserves_close_reason() {
        let event = parse_terminal_line(
            r#"{"type":"terminal.frame","seq":1,"bytes":"G1sySGkbWzBt","encoding":"ansi","full":true,"width":80,"height":24}"#,
        )
        .unwrap();
        match event {
            TerminalEvent::Frame { bytes, full } => {
                assert_eq!(bytes.as_ref(), b"\x1b[2Hi\x1b[0m");
                assert_eq!(full, Some(true));
            }
            TerminalEvent::Closed(_) => panic!("expected terminal frame"),
        }

        for (field, expected) in [(",\"full\":false", Some(false)), ("", None)] {
            let event = parse_terminal_line(&format!(
                r#"{{"type":"terminal.frame","bytes":"eA=="{field}}}"#
            ))
            .unwrap();
            assert!(matches!(event, TerminalEvent::Frame { full, .. } if full == expected));
        }

        let event = parse_terminal_line(
            r#"{"type":"terminal.closed","reason":"terminal attach taken over"}"#,
        )
        .unwrap();
        match event {
            TerminalEvent::Closed(reason) => {
                assert_eq!(reason, "terminal attach taken over")
            }
            TerminalEvent::Frame { .. } => panic!("expected terminal close"),
        }
    }
}
