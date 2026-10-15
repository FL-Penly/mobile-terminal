//! Agent transcripts (Claude Code / Codex jsonl) turned into copyable conversation blocks.
//!
//! Session files are read from the end backwards so that opening the newest page stays fast
//! no matter how large the session has grown. Page cursors are byte offsets into the file.

use serde::Serialize;
use serde_json::Value;

use std::{
    collections::HashMap,
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::SystemTime,
};

pub const DEFAULT_PAGE_BLOCKS: usize = 50;
pub const MAX_PAGE_BLOCKS: usize = 200;

const INITIAL_READ_CHUNK: usize = 128 * 1024;
const MAX_READ_CHUNK: usize = 8 * 1024 * 1024;
// Bounds one request when the tail is dominated by records that produce no blocks.
const MAX_PAGE_SCAN_BYTES: u64 = 48 * 1024 * 1024;
const MAX_FIRST_LINE_BYTES: u64 = 4 * 1024 * 1024;
const CLAUDE_VERIFY_TAIL_BYTES: u64 = 512 * 1024;
const CLAUDE_CANDIDATES: usize = 20;
const CODEX_CANDIDATES: usize = 200;
const CODEX_DAY_DIRS: usize = 400;
const TOOL_SUMMARY_CHARS: usize = 200;

// ─── Public types ──────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
}

impl AgentKind {
    pub fn from_agent(agent: &str) -> Option<Self> {
        match agent.trim().to_ascii_lowercase().as_str() {
            "claude" | "claude-code" | "claude_code" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Block {
    User {
        id: String,
        text: String,
    },
    Assistant {
        id: String,
        text: String,
    },
    Code {
        id: String,
        lang: String,
        text: String,
    },
    Command {
        id: String,
        command: String,
        output: String,
        #[serde(rename = "isError")]
        is_error: bool,
        #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none")]
        exit_code: Option<i64>,
    },
    Tool {
        id: String,
        name: String,
        summary: String,
    },
}

#[derive(Debug, Serialize)]
pub struct TranscriptPage {
    pub blocks: Vec<Block>,
    /// Pass back as `before` to load older blocks; `None` once the file start is reached.
    pub cursor: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SessionRef {
    Id(String),
    Path(PathBuf),
}

#[derive(Clone, Debug, Default)]
pub struct PaneAgent {
    pub agent: Option<String>,
    pub session: Option<SessionRef>,
    pub cwds: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct Roots {
    pub claude_projects: PathBuf,
    pub codex_sessions: PathBuf,
}

impl Roots {
    /// Honors `CLAUDE_CONFIG_DIR` and `CODEX_HOME` like the agents themselves do.
    pub fn from_env() -> Option<Self> {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let claude = std::env::var_os("CLAUDE_CONFIG_DIR")
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|home| home.join(".claude")))?;
        let codex = std::env::var_os("CODEX_HOME")
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|home| home.join(".codex")))?;
        Some(Self {
            claude_projects: claude.join("projects"),
            codex_sessions: codex.join("sessions"),
        })
    }
}

#[derive(Debug, PartialEq)]
pub enum TranscriptError {
    NoAgent,
    UnsupportedAgent(String),
    NotFound(String),
    SessionChanged,
    Io(String),
    Parse(String),
}

impl TranscriptError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoAgent => "no_agent",
            Self::UnsupportedAgent(_) => "unsupported_agent",
            Self::NotFound(_) => "transcript_not_found",
            Self::SessionChanged => "session_changed",
            Self::Io(_) => "transcript_io_failed",
            Self::Parse(_) => "transcript_parse_failed",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::NoAgent => "当前 pane 没有检测到 Claude Code 或 Codex".to_string(),
            Self::UnsupportedAgent(agent) => format!("暂不支持读取 {} 的会话记录", agent),
            Self::NotFound(detail) => format!("没有找到会话记录：{}", detail),
            Self::SessionChanged => "agent 已切换到新的会话，请刷新".to_string(),
            Self::Io(detail) => format!("读取会话记录失败：{}", detail),
            Self::Parse(detail) => format!("会话记录解析失败：{}", detail),
        }
    }
}

// ─── Pane → session file ───────────────────────────────────────────────────

pub struct LoadedTranscript {
    pub agent: AgentKind,
    pub path: PathBuf,
    pub page: TranscriptPage,
}

/// Loads one page. `expected_session` is the file an earlier page came from, since
/// cursors are only meaningful within that file.
pub fn load(
    pane: &PaneAgent,
    roots: &Roots,
    before: Option<u64>,
    limit: usize,
    expected_session: Option<&str>,
) -> Result<LoadedTranscript, TranscriptError> {
    let agent = pane
        .agent
        .as_deref()
        .map(str::trim)
        .filter(|agent| !agent.is_empty())
        .ok_or(TranscriptError::NoAgent)?;
    let kind = AgentKind::from_agent(agent)
        .ok_or_else(|| TranscriptError::UnsupportedAgent(agent.to_string()))?;
    let path = resolve_session_file(kind, pane, roots)?;
    if expected_session.is_some_and(|expected| Path::new(expected) != path) {
        return Err(TranscriptError::SessionChanged);
    }
    let page = read_page(kind, &path, before, limit)?;
    Ok(LoadedTranscript {
        agent: kind,
        path,
        page,
    })
}

/// Reads `agent`, `agent_session` and the working directories from herdr's pane info.
pub fn pane_agent_from_herdr(pane: &Value) -> PaneAgent {
    let session = pane.get("agent_session");
    let agent = pane
        .get("agent")
        .and_then(Value::as_str)
        .or_else(|| session.and_then(|s| s.get("agent")).and_then(Value::as_str))
        .map(str::to_string);
    let session = session.and_then(|session| {
        let value = session.get("value").and_then(Value::as_str)?.to_string();
        match session.get("kind").and_then(Value::as_str) {
            Some("path") => Some(SessionRef::Path(PathBuf::from(value))),
            Some("id") => Some(SessionRef::Id(value)),
            _ => None,
        }
    });
    let mut cwds = Vec::new();
    for key in ["foreground_cwd", "cwd"] {
        if let Some(cwd) = pane.get(key).and_then(Value::as_str) {
            if !cwd.is_empty() && !cwds.iter().any(|known| known == cwd) {
                cwds.push(cwd.to_string());
            }
        }
    }
    PaneAgent {
        agent,
        session,
        cwds,
    }
}

/// Claude Code stores a project's sessions under its cwd with every
/// non-alphanumeric character replaced by `-`.
pub fn claude_project_dir_name(cwd: &str) -> String {
    cwd.chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

pub fn resolve_session_file(
    kind: AgentKind,
    pane: &PaneAgent,
    roots: &Roots,
) -> Result<PathBuf, TranscriptError> {
    match &pane.session {
        Some(SessionRef::Path(path)) if path.is_file() => return Ok(path.clone()),
        Some(SessionRef::Id(id)) if is_safe_session_id(id) => {
            let found = match kind {
                AgentKind::Claude => {
                    find_claude_session_by_id(&roots.claude_projects, id, &pane.cwds)
                }
                AgentKind::Codex => find_codex_session_by_id(&roots.codex_sessions, id),
            };
            if let Some(path) = found {
                return Ok(path);
            }
        }
        _ => {}
    }

    let found = match kind {
        AgentKind::Claude => find_claude_session_by_cwd(&roots.claude_projects, &pane.cwds),
        AgentKind::Codex => find_codex_session_by_cwd(&roots.codex_sessions, &pane.cwds),
    };
    found.ok_or_else(|| {
        let cwd = pane.cwds.first().map(String::as_str).unwrap_or("未知目录");
        TranscriptError::NotFound(match kind {
            AgentKind::Claude => format!("~/.claude/projects 下没有 {} 的会话", cwd),
            AgentKind::Codex => format!("~/.codex/sessions 下没有 {} 的会话", cwd),
        })
    })
}

fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn find_claude_session_by_id(projects: &Path, id: &str, cwds: &[String]) -> Option<PathBuf> {
    let file_name = format!("{}.jsonl", id);
    for cwd in cwds {
        let candidate = projects.join(claude_project_dir_name(cwd)).join(&file_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    // The cwd may have changed since the session started; the id is unique anyway.
    fs::read_dir(projects)
        .ok()?
        .flatten()
        .map(|entry| entry.path().join(&file_name))
        .find(|candidate| candidate.is_file())
}

fn find_claude_session_by_cwd(projects: &Path, cwds: &[String]) -> Option<PathBuf> {
    for cwd in cwds {
        let dir = projects.join(claude_project_dir_name(cwd));
        let mut files = jsonl_files_by_mtime(&dir);
        files.truncate(CLAUDE_CANDIDATES);
        if let Some(path) = files
            .into_iter()
            .find(|path| claude_file_matches_cwd(path, cwd))
        {
            return Some(path);
        }
    }
    None
}

fn claude_file_matches_cwd(path: &Path, cwd: &str) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let Ok(len) = file.metadata().map(|meta| meta.len()) else {
        return false;
    };
    let start = len.saturating_sub(CLAUDE_VERIFY_TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }
    let mut tail = Vec::new();
    if file.read_to_end(&mut tail).is_err() {
        return false;
    }
    let text = String::from_utf8_lossy(&tail);
    // The first line may be cut by the seek; it simply fails to parse.
    let found = text
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find_map(|record| {
            record
                .get("cwd")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    found.is_some_and(|recorded| same_dir(&recorded, cwd))
}

fn find_codex_session_by_id(sessions: &Path, id: &str) -> Option<PathBuf> {
    let suffix = format!("{}.jsonl", id);
    codex_day_dirs(sessions).into_iter().find_map(|dir| {
        fs::read_dir(&dir).ok()?.flatten().find_map(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            (name.starts_with("rollout-") && name.ends_with(&suffix)).then(|| entry.path())
        })
    })
}

fn find_codex_session_by_cwd(sessions: &Path, cwds: &[String]) -> Option<PathBuf> {
    let mut files = Vec::new();
    for dir in codex_day_dirs(sessions) {
        files.extend(jsonl_files_by_mtime(&dir));
        if files.len() >= CODEX_CANDIDATES {
            break;
        }
    }
    files.sort_by_key(|path| std::cmp::Reverse(modified(path)));
    files.into_iter().take(CODEX_CANDIDATES).find(|path| {
        codex_session_cwd(path)
            .is_some_and(|recorded| cwds.iter().any(|cwd| same_dir(&recorded, cwd)))
    })
}

/// `sessions/YYYY/MM/DD`, newest first.
fn codex_day_dirs(sessions: &Path) -> Vec<PathBuf> {
    let mut days = Vec::new();
    for year in sorted_subdirs_desc(sessions) {
        for month in sorted_subdirs_desc(&year) {
            for day in sorted_subdirs_desc(&month) {
                days.push(day);
                if days.len() >= CODEX_DAY_DIRS {
                    return days;
                }
            }
        }
    }
    days
}

fn sorted_subdirs_desc(dir: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    dirs.reverse();
    dirs
}

fn codex_session_cwd(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut line = Vec::new();
    BufReader::new(file)
        .take(MAX_FIRST_LINE_BYTES)
        .read_until(b'\n', &mut line)
        .ok()?;
    let record: Value = serde_json::from_slice(&line).ok()?;
    if record.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    record
        .pointer("/payload/cwd")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn jsonl_files_by_mtime(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<(Option<SystemTime>, PathBuf)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl") && path.is_file())
        .map(|path| (modified(&path), path))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.into_iter().map(|(_, path)| path).collect()
}

fn modified(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|meta| meta.modified()).ok()
}

fn same_dir(a: &str, b: &str) -> bool {
    let trim = |path: &str| path.trim_end_matches('/').to_string();
    if trim(a) == trim(b) {
        return true;
    }
    // macOS reports /tmp as /private/tmp depending on who asks.
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

// ─── Reading pages ─────────────────────────────────────────────────────────

pub fn read_page(
    kind: AgentKind,
    path: &Path,
    before: Option<u64>,
    limit: usize,
) -> Result<TranscriptPage, TranscriptError> {
    let file = File::open(path).map_err(|error| TranscriptError::Io(error.to_string()))?;
    let len = file
        .metadata()
        .map_err(|error| TranscriptError::Io(error.to_string()))?
        .len();
    let end = before.unwrap_or(len).min(len);
    let limit = limit.clamp(1, MAX_PAGE_BLOCKS);
    let mut lines = ReverseLines::new(file, end);
    let mut converter = Converter::new(kind);
    let mut groups: Vec<Vec<Block>> = Vec::new();
    let mut count = 0;
    let mut parsed = 0usize;
    let mut failed = 0usize;
    let mut cursor = end;

    while let Some((offset, line)) = lines
        .next_line()
        .map_err(|error| TranscriptError::Io(error.to_string()))?
    {
        cursor = offset;
        let Ok(record) = serde_json::from_slice::<Value>(&line) else {
            // A half-written last line or a corrupt record is skipped, not fatal.
            failed += 1;
            continue;
        };
        parsed += 1;
        let blocks = converter.record_blocks(offset, &record);
        if !blocks.is_empty() {
            count += blocks.len();
            groups.push(blocks);
        }
        // Stop only once results already read have met their tool calls, so a
        // command is never split from its output across pages.
        let settled = converter.pending_results.is_empty() || count >= limit * 2;
        if count >= limit && settled {
            break;
        }
        if end - offset > MAX_PAGE_SCAN_BYTES && count > 0 {
            break;
        }
    }

    if parsed == 0 && failed > 0 {
        return Err(TranscriptError::Parse(format!(
            "{} 行都不是有效的 JSON",
            failed
        )));
    }

    groups.reverse();
    Ok(TranscriptPage {
        blocks: groups.into_iter().flatten().collect(),
        cursor: (cursor > 0).then_some(cursor),
    })
}

struct ReverseLines {
    file: File,
    /// Bytes `[pos, pos + buf.len())` are read but not yet returned.
    pos: u64,
    buf: Vec<u8>,
    chunk: usize,
}

impl ReverseLines {
    fn new(file: File, end: u64) -> Self {
        Self {
            file,
            pos: end,
            buf: Vec::new(),
            chunk: INITIAL_READ_CHUNK,
        }
    }

    fn next_line(&mut self) -> io::Result<Option<(u64, Vec<u8>)>> {
        loop {
            if let Some(index) = self.buf.iter().rposition(|byte| *byte == b'\n') {
                let line = self.buf.split_off(index + 1);
                self.buf.truncate(index);
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                return Ok(Some((self.pos + index as u64 + 1, line)));
            }
            if self.pos == 0 {
                if self.buf.iter().all(u8::is_ascii_whitespace) {
                    self.buf.clear();
                    return Ok(None);
                }
                return Ok(Some((0, std::mem::take(&mut self.buf))));
            }
            let size = (self.chunk as u64).min(self.pos);
            self.pos -= size;
            self.file.seek(SeekFrom::Start(self.pos))?;
            let mut chunk = vec![0; size as usize];
            self.file.read_exact(&mut chunk)?;
            chunk.extend_from_slice(&self.buf);
            self.buf = chunk;
            // Long lines (tool results with images) grow the read size geometrically.
            self.chunk = (self.chunk * 2).min(MAX_READ_CHUNK);
        }
    }
}

// ─── Record conversion ─────────────────────────────────────────────────────

#[derive(Clone, Debug, Default)]
struct ToolOutput {
    text: String,
    is_error: bool,
    exit_code: Option<i64>,
}

struct Converter {
    kind: AgentKind,
    pending_results: HashMap<String, ToolOutput>,
}

impl Converter {
    fn new(kind: AgentKind) -> Self {
        Self {
            kind,
            pending_results: HashMap::new(),
        }
    }

    fn record_blocks(&mut self, offset: u64, record: &Value) -> Vec<Block> {
        let mut out = BlockSink::new(offset);
        match self.kind {
            AgentKind::Claude => self.claude_record(record, &mut out),
            AgentKind::Codex => self.codex_record(record, &mut out),
        }
        out.blocks
    }

    fn take_result(&mut self, id: &str) -> ToolOutput {
        self.pending_results.remove(id).unwrap_or_default()
    }

    // ─── Claude Code ───────────────────────────────────────────────────────

    fn claude_record(&mut self, record: &Value, out: &mut BlockSink) {
        let record_type = record.get("type").and_then(Value::as_str).unwrap_or("");
        if !matches!(record_type, "user" | "assistant") {
            return;
        }
        if record.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            return;
        }
        let content = record.pointer("/message/content");
        if record_type == "user" {
            if record.get("isMeta").and_then(Value::as_bool) == Some(true) {
                return;
            }
            if record.get("isCompactSummary").and_then(Value::as_bool) == Some(true) {
                out.tool("上下文", "已压缩，之前的对话见更早的记录");
                return;
            }
            match content {
                Some(Value::String(text)) => claude_user_text(text, out),
                Some(Value::Array(items)) => {
                    let mut texts = Vec::new();
                    for item in items {
                        match item.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(text) = item.get("text").and_then(Value::as_str) {
                                    texts.push(text.to_string());
                                }
                            }
                            Some("tool_result") => self.claude_tool_result(record, item),
                            _ => {}
                        }
                    }
                    if !texts.is_empty() {
                        claude_user_text(&texts.join("\n"), out);
                    }
                }
                _ => {}
            }
            return;
        }

        let Some(Value::Array(items)) = content else {
            return;
        };
        for item in items {
            match item.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        out.assistant_markdown(text);
                    }
                }
                Some("tool_use") => self.claude_tool_use(item, out),
                _ => {}
            }
        }
    }

    fn claude_tool_result(&mut self, record: &Value, item: &Value) {
        let Some(id) = item.get("tool_use_id").and_then(Value::as_str) else {
            return;
        };
        let is_error = item.get("is_error").and_then(Value::as_bool) == Some(true);
        let content_text = tool_result_text(item.get("content"));
        // Bash results carry clean stdout/stderr next to the model-facing text.
        let text = match record.get("toolUseResult") {
            Some(result @ Value::Object(_)) if result.get("stdout").is_some() => {
                let stdout = result.get("stdout").and_then(Value::as_str).unwrap_or("");
                let stderr = result.get("stderr").and_then(Value::as_str).unwrap_or("");
                join_nonempty(stdout, stderr)
            }
            _ => content_text.clone(),
        };
        let exit_code: Option<i64> = content_text
            .strip_prefix("Exit code ")
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|code| code.parse().ok());
        let text = match (exit_code, text.strip_prefix("Exit code ")) {
            (Some(_), Some(rest)) => rest
                .split_once('\n')
                .map(|(_, body)| body)
                .unwrap_or("")
                .to_string(),
            _ => text,
        };
        self.pending_results.insert(
            id.to_string(),
            ToolOutput {
                text,
                is_error,
                exit_code,
            },
        );
    }

    fn claude_tool_use(&mut self, item: &Value, out: &mut BlockSink) {
        let name = item.get("name").and_then(Value::as_str).unwrap_or("Tool");
        let input = item.get("input").cloned().unwrap_or(Value::Null);
        let result = item
            .get("id")
            .and_then(Value::as_str)
            .map(|id| self.take_result(id))
            .unwrap_or_default();
        if name == "Bash" {
            let command = input.get("command").and_then(Value::as_str).unwrap_or("");
            out.command(command, result);
            return;
        }
        out.tool(name, &claude_tool_summary(name, &input));
    }

    // ─── Codex ─────────────────────────────────────────────────────────────

    fn codex_record(&mut self, record: &Value, out: &mut BlockSink) {
        let Some(payload) = record.get("payload") else {
            return;
        };
        let payload_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
        match (record.get("type").and_then(Value::as_str), payload_type) {
            (Some("event_msg"), "item_completed") => {
                if let Some(item) = payload.get("item") {
                    self.codex_item(item, out);
                }
            }
            // Older rollouts have no item events and describe turns with these instead.
            (Some("event_msg"), "user_message") => {
                if let Some(text) = payload.get("message").and_then(Value::as_str) {
                    codex_user_text(text, out);
                }
            }
            (Some("event_msg"), "agent_message") => {
                if let Some(text) = payload.get("message").and_then(Value::as_str) {
                    out.assistant_markdown(text);
                }
            }
            (Some("response_item"), "function_call_output" | "custom_tool_call_output") => {
                if let Some(id) = payload.get("call_id").and_then(Value::as_str) {
                    self.pending_results
                        .insert(id.to_string(), codex_call_output(payload.get("output")));
                }
            }
            (Some("response_item"), "function_call") => self.codex_function_call(payload, out),
            (Some("response_item"), "custom_tool_call") => {
                let output = payload
                    .get("call_id")
                    .and_then(Value::as_str)
                    .map(|id| self.take_result(id));
                let name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                // Code-mode `exec` wrappers are reported again as CommandExecution items.
                if name != "exec" {
                    let input = payload.get("input").and_then(Value::as_str).unwrap_or("");
                    out.tool(name, &codex_patch_summary(input));
                }
                drop(output);
            }
            _ => {}
        }
    }

    fn codex_item(&mut self, item: &Value, out: &mut BlockSink) {
        match item.get("type").and_then(Value::as_str) {
            Some("UserMessage") => {
                let text = content_texts(item.get("content"));
                codex_user_text(&text, out);
            }
            Some("AgentMessage") => out.assistant_markdown(&content_texts(item.get("content"))),
            Some("CommandExecution") => {
                let command = item
                    .pointer("/parsed_cmd/0/cmd")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| codex_shell_command(item.get("command")))
                    .unwrap_or_default();
                let text = ["aggregated_output", "formatted_output", "stdout"]
                    .iter()
                    .find_map(|key| item.get(*key).and_then(Value::as_str))
                    .unwrap_or("")
                    .to_string();
                let exit_code = item.get("exit_code").and_then(Value::as_i64);
                let is_error = exit_code.is_some_and(|code| code != 0)
                    || item.get("status").and_then(Value::as_str) == Some("failed");
                out.command(
                    &command,
                    ToolOutput {
                        text,
                        is_error,
                        exit_code,
                    },
                );
            }
            Some("FileChange") => {
                let files: Vec<String> = item
                    .get("changes")
                    .and_then(Value::as_object)
                    .map(|changes| changes.keys().cloned().collect())
                    .unwrap_or_default();
                out.tool("Edit", &files.join(", "));
            }
            Some("McpToolCall") => {
                let server = item.get("server").and_then(Value::as_str).unwrap_or("mcp");
                let tool = item.get("tool").and_then(Value::as_str).unwrap_or("tool");
                let title = item
                    .pointer("/arguments/title")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                out.tool(&format!("{}.{}", server, tool), title);
            }
            Some("ImageView") => {
                let path = item.get("path").and_then(Value::as_str).unwrap_or("");
                out.tool("Image", path.trim_start_matches("file://"));
            }
            Some("WebSearch") => {
                let query = item.get("query").and_then(Value::as_str).unwrap_or("");
                out.tool("WebSearch", query);
            }
            _ => {}
        }
    }

    fn codex_function_call(&mut self, payload: &Value, out: &mut BlockSink) {
        let name = payload
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool");
        let output = payload
            .get("call_id")
            .and_then(Value::as_str)
            .map(|id| self.take_result(id))
            .unwrap_or_default();
        let arguments: Value = payload
            .get("arguments")
            .and_then(Value::as_str)
            .and_then(|raw| serde_json::from_str(raw).ok())
            .unwrap_or(Value::Null);
        if matches!(
            name,
            "shell" | "shell_command" | "exec_command" | "local_shell" | "container.exec"
        ) {
            let command = ["command", "cmd"]
                .iter()
                .find_map(|key| codex_shell_command(arguments.get(*key)))
                .unwrap_or_default();
            out.command(&command, output);
            return;
        }
        // Waiting and polling helpers carry nothing worth copying.
        if matches!(name, "wait" | "sleep" | "write_stdin") {
            return;
        }
        out.tool(name, &first_string_field(&arguments));
    }
}

struct BlockSink {
    offset: u64,
    blocks: Vec<Block>,
}

impl BlockSink {
    fn new(offset: u64) -> Self {
        Self {
            offset,
            blocks: Vec::new(),
        }
    }

    fn next_id(&self) -> String {
        format!("{}-{}", self.offset, self.blocks.len())
    }

    fn user(&mut self, text: &str) {
        let text = text.trim();
        if !text.is_empty() {
            let id = self.next_id();
            self.blocks.push(Block::User {
                id,
                text: text.to_string(),
            });
        }
    }

    fn assistant_markdown(&mut self, markdown: &str) {
        for segment in split_markdown(markdown) {
            let id = self.next_id();
            self.blocks.push(match segment {
                Segment::Text(text) => Block::Assistant { id, text },
                Segment::Code { lang, text } => Block::Code { id, lang, text },
            });
        }
    }

    fn command(&mut self, command: &str, output: ToolOutput) {
        let id = self.next_id();
        self.blocks.push(Block::Command {
            id,
            command: command.trim().to_string(),
            output: output.text.trim_end().to_string(),
            is_error: output.is_error,
            exit_code: output.exit_code,
        });
    }

    fn tool(&mut self, name: &str, summary: &str) {
        let id = self.next_id();
        self.blocks.push(Block::Tool {
            id,
            name: name.to_string(),
            summary: truncate_chars(summary.trim(), TOOL_SUMMARY_CHARS),
        });
    }
}

fn claude_user_text(text: &str, out: &mut BlockSink) {
    let text = strip_paste_markers(&strip_tag_sections(text, "system-reminder"));
    let trimmed = text.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("<local-command-caveat>")
        || trimmed.starts_with("<local-command-stdout>")
        || trimmed.starts_with("<local-command-stderr>")
        || trimmed.starts_with("<bash-stdout>")
        || trimmed.starts_with("<bash-stderr>")
    {
        return;
    }
    if trimmed == "[Request interrupted by user]"
        || trimmed == "[Request interrupted by user for tool use]"
    {
        out.tool("中断", "用户中断了这次回复");
        return;
    }
    if let Some(name) = tag_content(trimmed, "command-name") {
        let args = tag_content(trimmed, "command-args").unwrap_or_default();
        out.user(&format!("{} {}", name.trim(), args.trim()));
        return;
    }
    if trimmed.starts_with("<task-notification>") {
        let summary = tag_content(trimmed, "summary").unwrap_or_default();
        out.tool("后台任务", &summary);
        return;
    }
    if let Some(command) = tag_content(trimmed, "bash-input") {
        out.user(&format!("! {}", command.trim()));
        return;
    }
    out.user(trimmed);
}

fn codex_user_text(text: &str, out: &mut BlockSink) {
    let trimmed = text.trim();
    // Context injected by the CLI rather than typed by the user.
    for tag in [
        "<environment_context>",
        "<user_instructions>",
        "<permissions instructions>",
        "<turn_aborted>",
    ] {
        if trimmed.starts_with(tag) {
            return;
        }
    }
    out.user(trimmed);
}

fn claude_tool_summary(name: &str, input: &Value) -> String {
    let field = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_string);
    let summary = match name {
        "Read" | "Write" | "Edit" | "MultiEdit" => field("file_path"),
        "NotebookEdit" => field("notebook_path"),
        "Grep" => field("pattern").map(|pattern| match field("path") {
            Some(path) => format!("{}  {}", pattern, path),
            None => pattern,
        }),
        "Glob" => field("pattern"),
        "WebFetch" => field("url"),
        "WebSearch" => field("query"),
        "Agent" | "Task" => field("description"),
        "Skill" => field("skill"),
        "TodoWrite" => input
            .get("todos")
            .and_then(Value::as_array)
            .map(|todos| format!("{} 项", todos.len())),
        _ => None,
    };
    summary.unwrap_or_else(|| first_string_field(input))
}

fn first_string_field(value: &Value) -> String {
    value
        .as_object()
        .and_then(|object| object.values().find_map(Value::as_str))
        .unwrap_or("")
        .to_string()
}

fn codex_shell_command(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(command) => Some(command.clone()),
        Value::Array(parts) => {
            let parts: Vec<&str> = parts.iter().filter_map(Value::as_str).collect();
            // ["bash", "-lc", "<script>"] → the script is what the agent wrote.
            match parts.as_slice() {
                [_, flag, script] if flag.starts_with('-') && flag.ends_with('c') => {
                    Some(script.to_string())
                }
                _ => Some(parts.join(" ")),
            }
        }
        _ => None,
    }
}

fn codex_call_output(output: Option<&Value>) -> ToolOutput {
    let raw = match output {
        Some(Value::String(text)) => text.clone(),
        Some(value @ Value::Array(_)) => content_texts(Some(value)),
        _ => String::new(),
    };
    // Legacy shell output is JSON: {"output": "...", "metadata": {"exit_code": N}}.
    if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
        if let Some(text) = parsed.get("output").and_then(Value::as_str) {
            let exit_code = parsed
                .pointer("/metadata/exit_code")
                .and_then(Value::as_i64);
            return ToolOutput {
                text: text.to_string(),
                is_error: exit_code.is_some_and(|code| code != 0),
                exit_code,
            };
        }
    }
    let exit_code = raw
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("Exit code: "))
        .and_then(|code| code.trim().parse().ok());
    let text = raw
        .split_once("\nOutput:\n")
        .map(|(_, body)| body.to_string())
        .unwrap_or(raw.clone());
    ToolOutput {
        text,
        is_error: exit_code.is_some_and(|code| code != 0),
        exit_code,
    }
}

fn codex_patch_summary(input: &str) -> String {
    let files: Vec<&str> = input
        .lines()
        .filter_map(|line| {
            ["*** Update File: ", "*** Add File: ", "*** Delete File: "]
                .iter()
                .find_map(|prefix| line.strip_prefix(prefix))
        })
        .collect();
    if files.is_empty() {
        input.lines().next().unwrap_or("").to_string()
    } else {
        files.join(", ")
    }
}

fn tool_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(value @ Value::Array(_)) => content_texts(Some(value)),
        _ => String::new(),
    }
}

fn content_texts(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter(|item| {
                matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("text" | "input_text" | "output_text" | "Text")
                )
            })
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn join_nonempty(a: &str, b: &str) -> String {
    match (a.trim_end().is_empty(), b.trim_end().is_empty()) {
        (false, false) => format!("{}\n{}", a.trim_end(), b.trim_end()),
        (false, true) => a.to_string(),
        (true, false) => b.to_string(),
        (true, true) => String::new(),
    }
}

fn tag_content(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(text[start..end].to_string())
}

fn strip_tag_sections(text: &str, tag: &str) -> String {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    let mut rest = text;
    let mut out = String::with_capacity(text.len());
    while let Some(start) = rest.find(&open) {
        out.push_str(&rest[..start]);
        match rest[start..].find(&close) {
            Some(end) => rest = &rest[start + end + close.len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Claude Code wraps multi-line pastes in `<pasted_content id="…">` marker lines.
fn strip_paste_markers(text: &str) -> String {
    if !text.contains("pasted_content") {
        return text.to_string();
    }
    text.lines()
        .filter(|line| {
            let line = line.trim();
            !((line.starts_with("<pasted_content") || line.starts_with("</pasted_content"))
                && line.ends_with('>'))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn truncate_chars(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((index, _)) => format!("{}…", &text[..index]),
        None => text.to_string(),
    }
}

// ─── Markdown fences ───────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
enum Segment {
    Text(String),
    Code { lang: String, text: String },
}

/// Splits fenced code blocks out of a reply; an unclosed fence runs to the end.
fn split_markdown(markdown: &str) -> Vec<Segment> {
    let mut segments = Vec::new();
    let mut text = Vec::new();
    let mut code: Option<(String, String, Vec<&str>)> = None;

    for line in markdown.lines() {
        match &mut code {
            Some((fence, lang, body)) => {
                let trimmed = line.trim();
                if trimmed.starts_with(fence.as_str()) && trimmed.trim_start_matches('`').is_empty()
                {
                    segments.push(Segment::Code {
                        lang: std::mem::take(lang),
                        text: body.join("\n"),
                    });
                    code = None;
                } else {
                    body.push(line);
                }
            }
            None => {
                let indent = line.len() - line.trim_start().len();
                let trimmed = line.trim_start();
                if indent <= 3 && trimmed.starts_with("```") {
                    flush_text(&mut text, &mut segments);
                    let fence_len = trimmed.chars().take_while(|ch| *ch == '`').count();
                    let lang = trimmed[fence_len..].split_whitespace().next().unwrap_or("");
                    code = Some(("`".repeat(fence_len), lang.to_string(), Vec::new()));
                } else {
                    text.push(line);
                }
            }
        }
    }
    if let Some((_, lang, body)) = code {
        segments.push(Segment::Code {
            lang,
            text: body.join("\n"),
        });
    }
    flush_text(&mut text, &mut segments);
    segments
}

fn flush_text(lines: &mut Vec<&str>, segments: &mut Vec<Segment>) {
    let text = lines.join("\n");
    lines.clear();
    let text = text.trim_matches('\n').trim_end();
    if !text.trim().is_empty() {
        segments.push(Segment::Text(text.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_dir_name_replaces_every_non_alphanumeric_character() {
        assert_eq!(
            claude_project_dir_name("/Users/bytedance/project/mino_server_other"),
            "-Users-bytedance-project-mino-server-other"
        );
        assert_eq!(claude_project_dir_name("/a/b.c d"), "-a-b-c-d");
    }

    #[test]
    fn markdown_fences_become_separate_code_segments() {
        let segments =
            split_markdown("改成这样：\n\n```ts\nconst a = 1\n\n  return a\n```\n\n完成。");
        assert_eq!(
            segments,
            vec![
                Segment::Text("改成这样：".into()),
                Segment::Code {
                    lang: "ts".into(),
                    text: "const a = 1\n\n  return a".into()
                },
                Segment::Text("完成。".into()),
            ]
        );
    }

    #[test]
    fn unclosed_fence_runs_to_the_end_and_longer_fences_nest() {
        assert_eq!(
            split_markdown("````md\n```js\nx\n```\n````"),
            vec![Segment::Code {
                lang: "md".into(),
                text: "```js\nx\n```".into()
            }]
        );
        assert_eq!(
            split_markdown("a\n```\nstill code"),
            vec![
                Segment::Text("a".into()),
                Segment::Code {
                    lang: String::new(),
                    text: "still code".into()
                }
            ]
        );
    }

    #[test]
    fn reverse_lines_returns_offsets_and_handles_tiny_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.jsonl");
        fs::write(&path, "first\n\nsecond line\nthird").unwrap();
        let file = File::open(&path).unwrap();
        let mut lines = ReverseLines::new(file, 24);
        lines.chunk = 3;
        let mut seen = Vec::new();
        while let Some((offset, line)) = lines.next_line().unwrap() {
            seen.push((offset, String::from_utf8(line).unwrap()));
        }
        assert_eq!(
            seen,
            vec![
                (19, "third".to_string()),
                (7, "second line".to_string()),
                (0, "first".to_string())
            ]
        );
    }

    #[test]
    fn user_text_cleanup_handles_commands_reminders_and_interrupts() {
        let mut out = BlockSink::new(0);
        claude_user_text(
            "<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>ship it</command-args>",
            &mut out,
        );
        claude_user_text(
            "<local-command-stdout>done</local-command-stdout>",
            &mut out,
        );
        claude_user_text(
            "hello<system-reminder>secret</system-reminder> world",
            &mut out,
        );
        claude_user_text("[Request interrupted by user]", &mut out);
        claude_user_text(
            "\n\n<pasted_content id=\"650d\">\n请解释：\n\n```rust\nx\n```\n</pasted_content id=\"650d\">\n",
            &mut out,
        );
        let texts: Vec<String> = out
            .blocks
            .iter()
            .map(|block| match block {
                Block::User { text, .. } => format!("user:{}", text),
                Block::Tool { name, .. } => format!("tool:{}", name),
                other => format!("{:?}", other),
            })
            .collect();
        assert_eq!(
            texts,
            vec![
                "user:/goal ship it",
                "user:hello world",
                "tool:中断",
                "user:请解释：\n\n```rust\nx\n```"
            ]
        );
    }

    #[test]
    fn codex_legacy_output_formats_are_understood() {
        let json = codex_call_output(Some(&Value::String(
            r#"{"output":"boom\n","metadata":{"exit_code":2}}"#.into(),
        )));
        assert_eq!(json.text, "boom\n");
        assert_eq!(json.exit_code, Some(2));
        assert!(json.is_error);

        let text = codex_call_output(Some(&Value::String(
            "Exit code: 0\nWall time: 0.1 seconds\nOutput:\nok".into(),
        )));
        assert_eq!(text.text, "ok");
        assert_eq!(text.exit_code, Some(0));
        assert!(!text.is_error);
    }

    #[test]
    fn shell_command_prefers_the_script_of_a_login_shell() {
        let command = serde_json::json!(["/bin/zsh", "-lc", "git status"]);
        assert_eq!(codex_shell_command(Some(&command)).unwrap(), "git status");
        let plain = serde_json::json!(["ls", "-la"]);
        assert_eq!(codex_shell_command(Some(&plain)).unwrap(), "ls -la");
    }

    #[test]
    fn session_ids_with_path_characters_are_rejected() {
        assert!(is_safe_session_id("16aa50a5-4f71-42da-bcbc-97de3e6d08eb"));
        assert!(!is_safe_session_id("../../etc/passwd"));
        assert!(!is_safe_session_id(""));
    }
}
