mod common;

use axum::http::StatusCode;
use rust_terminal::transcript::{
    self, AgentKind, Block, PaneAgent, Roots, SessionRef, TranscriptError,
};
use serde_json::json;
use serial_test::serial;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

const CLAUDE_ID: &str = "11111111-2222-4333-8444-555555555555";
const CODEX_ID: &str = "019a0000-aaaa-7bbb-8ccc-dddddddddddd";

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn read_all(kind: AgentKind, path: &Path) -> Vec<Block> {
    transcript::read_page(kind, path, None, 200).unwrap().blocks
}

fn describe(blocks: &[Block]) -> Vec<String> {
    blocks
        .iter()
        .map(|block| match block {
            Block::User { text, .. } => format!("user: {}", text),
            Block::Assistant { text, .. } => format!("assistant: {}", text),
            Block::Code { lang, text, .. } => format!("code[{}]: {}", lang, text),
            Block::Command {
                command,
                output,
                is_error,
                exit_code,
                ..
            } => format!(
                "command: {} => {:?} error={} exit={:?}",
                command, output, is_error, exit_code
            ),
            Block::Tool { name, summary, .. } => format!("tool: {} {}", name, summary),
        })
        .collect()
}

fn block_id(block: &Block) -> &str {
    match block {
        Block::User { id, .. }
        | Block::Assistant { id, .. }
        | Block::Code { id, .. }
        | Block::Command { id, .. }
        | Block::Tool { id, .. } => id,
    }
}

fn roots_in(dir: &Path) -> Roots {
    Roots {
        claude_projects: dir.join("claude/projects"),
        codex_sessions: dir.join("codex/sessions"),
    }
}

fn pane(agent: &str, session: Option<SessionRef>, cwd: &str) -> PaneAgent {
    PaneAgent {
        agent: Some(agent.to_string()),
        session,
        cwds: vec![cwd.to_string()],
    }
}

fn copy_to(src: &Path, dest: &Path) -> PathBuf {
    fs::create_dir_all(dest.parent().unwrap()).unwrap();
    fs::copy(src, dest).unwrap();
    // fs::copy keeps the source mtime on macOS; lookups rank files by mtime.
    set_mtime(dest, 0);
    dest.to_path_buf()
}

fn set_mtime(path: &Path, seconds_ago: u64) {
    let file = fs::File::options().write(true).open(path).unwrap();
    file.set_modified(SystemTime::now() - Duration::from_secs(seconds_ago))
        .unwrap();
}

// ─── Parsing ───────────────────────────────────────────────────────────────

#[test]
fn claude_fixture_becomes_conversation_blocks() {
    let blocks = read_all(AgentKind::Claude, &fixture("claude-session.jsonl"));
    assert_eq!(
        describe(&blocks),
        vec![
            "user: /model",
            "user: 帮我修一下 Sel 复制时长行被折断的问题，顺便跑一下相关测试",
            "assistant: 问题出在 `Terminal.tsx`：没有看 isWrapped。改成这样：",
            "code[ts]: if (line.isWrapped && out.length > 0) out[out.length - 1] += text\nelse out.push(text)",
            "assistant: 然后跑测试。",
            "tool: Read /work/demo/src/Terminal.tsx",
            "command: cargo test -- copy_mode => \"running 2 tests\\ntest copy_mode::joins ... ok\\ntest copy_mode::flag ... FAILED\" error=true exit=Some(101)",
            "command: ls src => \"lib.rs\\nmain.rs\" error=false exit=None",
            "command: git status --short => \" M src/lib.rs\" error=false exit=None",
            "tool: 中断 用户中断了这次回复",
            "user: 继续，补上 -J",
            "assistant: 已经补上 -J，MR：https://example.com/merge_requests/128?tab=changes",
        ]
    );
    assert!(!describe(&blocks)
        .iter()
        .any(|line| line.contains("SIDECHAIN")));
}

#[test]
fn codex_fixture_uses_completed_items() {
    let blocks = read_all(AgentKind::Codex, &fixture("codex-session.jsonl"));
    assert_eq!(
        describe(&blocks),
        vec![
            "user: 看看为什么构建失败",
            "assistant: 我先跑一下构建。",
            "command: npm run build => \"> tsc -b\\nsrc/a.ts(3,1): error TS2304: Cannot find name 'x'.\" error=true exit=Some(2)",
            "tool: Edit /work/demo/src/a.ts",
            "command: npm run build => \"built in 1.2s\" error=false exit=Some(0)",
            "assistant: 已修复，补了声明：",
            "code[ts]: const x = 1",
        ]
    );
}

#[test]
fn legacy_codex_rollouts_are_still_readable() {
    let blocks = read_all(AgentKind::Codex, &fixture("codex-legacy-session.jsonl"));
    assert_eq!(
        describe(&blocks),
        vec![
            "user: 列一下文件",
            "command: ls => \"a.ts\\nb.ts\" error=false exit=Some(0)",
            "tool: apply_patch a.ts",
            "assistant: 有 a.ts 和 b.ts，已改好 a.ts。",
        ]
    );
}

#[test]
fn blocks_serialize_with_camel_case_kinds() {
    let blocks = read_all(AgentKind::Claude, &fixture("claude-session.jsonl"));
    let command = blocks
        .iter()
        .find(|block| matches!(block, Block::Command { is_error: true, .. }))
        .unwrap();
    let value = serde_json::to_value(command).unwrap();
    assert_eq!(value["kind"], "command");
    assert_eq!(value["isError"], true);
    assert_eq!(value["exitCode"], 101);
    let user = serde_json::to_value(&blocks[0]).unwrap();
    assert_eq!(user["kind"], "user");
    assert!(user.get("exitCode").is_none());
}

// ─── Pagination ────────────────────────────────────────────────────────────

fn read_in_pages(kind: AgentKind, path: &Path, limit: usize) -> (Vec<Block>, usize) {
    let mut pages = Vec::new();
    let mut before = None;
    loop {
        let page = transcript::read_page(kind, path, before, limit).unwrap();
        assert!(!page.blocks.is_empty() || page.cursor.is_none());
        pages.push(page.blocks);
        match page.cursor {
            Some(cursor) => {
                assert!(before.is_none_or(|previous| cursor < previous));
                before = Some(cursor);
            }
            None => break,
        }
    }
    let count = pages.len();
    pages.reverse();
    (pages.into_iter().flatten().collect(), count)
}

#[test]
fn pages_concatenate_to_the_full_transcript_without_splitting_commands() {
    for (kind, name) in [
        (AgentKind::Claude, "claude-session.jsonl"),
        (AgentKind::Codex, "codex-session.jsonl"),
        (AgentKind::Codex, "codex-legacy-session.jsonl"),
    ] {
        let path = fixture(name);
        let full = read_all(kind, &path);
        for limit in 1..=4 {
            let (paged, pages) = read_in_pages(kind, &path, limit);
            assert_eq!(paged, full, "{} with limit {}", name, limit);
            assert!(
                pages > 1,
                "{} with limit {} should need several pages",
                name,
                limit
            );
        }
    }
}

#[test]
fn newest_page_comes_first_and_ids_are_stable() {
    let path = fixture("claude-session.jsonl");
    let page = transcript::read_page(AgentKind::Claude, &path, None, 2).unwrap();
    assert_eq!(
        describe(&page.blocks),
        vec![
            "user: 继续，补上 -J",
            "assistant: 已经补上 -J，MR：https://example.com/merge_requests/128?tab=changes",
        ]
    );
    let again = transcript::read_page(AgentKind::Claude, &path, None, 2).unwrap();
    let ids: Vec<&str> = page.blocks.iter().map(block_id).collect();
    let again_ids: Vec<&str> = again.blocks.iter().map(block_id).collect();
    assert_eq!(ids, again_ids);
    assert!(page.cursor.is_some());
}

#[test]
fn half_written_last_line_is_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("live.jsonl");
    let mut body = fs::read_to_string(fixture("claude-session.jsonl")).unwrap();
    body.push_str(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"still stre"#);
    fs::write(&path, body).unwrap();
    let blocks = read_all(AgentKind::Claude, &path);
    assert_eq!(
        blocks,
        read_all(AgentKind::Claude, &fixture("claude-session.jsonl"))
    );
}

#[test]
fn a_file_without_any_json_is_a_parse_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("broken.jsonl");
    fs::write(&path, "not json\nalso not json\n").unwrap();
    let error = transcript::read_page(AgentKind::Claude, &path, None, 50).unwrap_err();
    assert_eq!(error.code(), "transcript_parse_failed");
}

#[test]
fn empty_file_returns_an_empty_final_page() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("empty.jsonl");
    fs::write(&path, "").unwrap();
    let page = transcript::read_page(AgentKind::Codex, &path, None, 50).unwrap();
    assert!(page.blocks.is_empty());
    assert_eq!(page.cursor, None);
}

// ─── Pane → session file ───────────────────────────────────────────────────

#[test]
fn claude_session_is_found_by_herdr_session_id() {
    let dir = tempfile::tempdir().unwrap();
    let roots = roots_in(dir.path());
    let expected = copy_to(
        &fixture("claude-session.jsonl"),
        &roots
            .claude_projects
            .join("-work-demo")
            .join(format!("{}.jsonl", CLAUDE_ID)),
    );
    let found = transcript::resolve_session_file(
        AgentKind::Claude,
        &pane(
            "claude",
            Some(SessionRef::Id(CLAUDE_ID.into())),
            "/work/demo",
        ),
        &roots,
    )
    .unwrap();
    assert_eq!(found, expected);

    // The pane moved to another directory, but the id still identifies the file.
    let moved = transcript::resolve_session_file(
        AgentKind::Claude,
        &pane(
            "claude",
            Some(SessionRef::Id(CLAUDE_ID.into())),
            "/elsewhere",
        ),
        &roots,
    )
    .unwrap();
    assert_eq!(moved, expected);
}

#[test]
fn claude_cwd_lookup_takes_the_newest_file_whose_records_match() {
    let dir = tempfile::tempdir().unwrap();
    let roots = roots_in(dir.path());
    let project = roots.claude_projects.join("-work-demo");
    let older = copy_to(
        &fixture("claude-session.jsonl"),
        &project.join("older.jsonl"),
    );
    set_mtime(&older, 600);
    // Same encoded directory name, different real cwd (/work_demo vs /work/demo).
    let impostor = project.join("newest.jsonl");
    fs::write(
        &impostor,
        r#"{"type":"user","cwd":"/work_demo","message":{"role":"user","content":"x"}}"#,
    )
    .unwrap();
    let found = transcript::resolve_session_file(
        AgentKind::Claude,
        &pane("claude", None, "/work/demo"),
        &roots,
    )
    .unwrap();
    assert_eq!(found, older);

    let newer = copy_to(
        &fixture("claude-session.jsonl"),
        &project.join("newer.jsonl"),
    );
    let found = transcript::resolve_session_file(
        AgentKind::Claude,
        &pane("claude", None, "/work/demo"),
        &roots,
    )
    .unwrap();
    assert_eq!(found, newer);
}

#[test]
fn codex_session_is_found_by_id_or_by_cwd() {
    let dir = tempfile::tempdir().unwrap();
    let roots = roots_in(dir.path());
    let expected = copy_to(
        &fixture("codex-session.jsonl"),
        &roots
            .codex_sessions
            .join("2026/10/15")
            .join(format!("rollout-2026-10-15T09-00-00-{}.jsonl", CODEX_ID)),
    );
    let other = copy_to(
        &fixture("codex-legacy-session.jsonl"),
        &roots
            .codex_sessions
            .join("2025/11/10")
            .join("rollout-2025-11-10T14-32-54-019a6c77-af94-78d0-9239-840582e1a628.jsonl"),
    );
    set_mtime(&other, 3600);

    let by_id = transcript::resolve_session_file(
        AgentKind::Codex,
        &pane("codex", Some(SessionRef::Id(CODEX_ID.into())), "/nowhere"),
        &roots,
    )
    .unwrap();
    assert_eq!(by_id, expected);

    let by_cwd = transcript::resolve_session_file(
        AgentKind::Codex,
        &pane("codex", None, "/work/demo"),
        &roots,
    )
    .unwrap();
    assert_eq!(by_cwd, expected);

    let by_path = transcript::resolve_session_file(
        AgentKind::Codex,
        &pane("codex", Some(SessionRef::Path(other.clone())), "/nowhere"),
        &roots,
    )
    .unwrap();
    assert_eq!(by_path, other);
}

#[test]
fn missing_sessions_and_agents_degrade_with_specific_errors() {
    let dir = tempfile::tempdir().unwrap();
    let roots = roots_in(dir.path());

    let no_agent = PaneAgent {
        agent: None,
        session: None,
        cwds: vec!["/work/demo".into()],
    };
    assert_eq!(
        transcript::load(&no_agent, &roots, None, 50, None).err(),
        Some(TranscriptError::NoAgent)
    );

    let unsupported = pane("opencode", None, "/work/demo");
    assert_eq!(
        transcript::load(&unsupported, &roots, None, 50, None)
            .err()
            .map(|error| error.code()),
        Some("unsupported_agent")
    );

    for agent in ["claude", "codex"] {
        let error = transcript::load(&pane(agent, None, "/work/demo"), &roots, None, 50, None)
            .err()
            .unwrap();
        assert_eq!(error.code(), "transcript_not_found", "{}", agent);
        assert!(error.message().contains("/work/demo"));
    }

    // An id that is not on disk falls back to the cwd lookup, then reports not found.
    let stale_id = pane(
        "claude",
        Some(SessionRef::Id(
            "00000000-0000-0000-0000-000000000000".into(),
        )),
        "/work/demo",
    );
    assert_eq!(
        transcript::load(&stale_id, &roots, None, 50, None)
            .err()
            .map(|error| error.code()),
        Some("transcript_not_found")
    );
}

#[test]
fn a_cursor_from_another_session_file_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let roots = roots_in(dir.path());
    let path = copy_to(
        &fixture("claude-session.jsonl"),
        &roots.claude_projects.join("-work-demo/current.jsonl"),
    );
    let pane = pane("claude", None, "/work/demo");
    let loaded = transcript::load(&pane, &roots, None, 50, Some(path.to_str().unwrap())).unwrap();
    assert_eq!(loaded.agent, AgentKind::Claude);
    assert_eq!(
        transcript::load(&pane, &roots, Some(10), 50, Some("/old/session.jsonl")).err(),
        Some(TranscriptError::SessionChanged)
    );
}

#[test]
fn herdr_pane_info_maps_to_agent_session_and_cwds() {
    let agent = transcript::pane_agent_from_herdr(&json!({
        "agent": "claude",
        "agent_session": {"agent": "claude", "kind": "id", "source": "herdr:claude", "value": CLAUDE_ID},
        "cwd": "/work",
        "foreground_cwd": "/work/demo",
    }));
    assert_eq!(agent.agent.as_deref(), Some("claude"));
    assert_eq!(agent.session, Some(SessionRef::Id(CLAUDE_ID.into())));
    assert_eq!(agent.cwds, vec!["/work/demo", "/work"]);

    let by_path = transcript::pane_agent_from_herdr(&json!({
        "agent_session": {"agent": "codex", "kind": "path", "source": "x", "value": "/tmp/s.jsonl"},
        "cwd": "/work",
        "foreground_cwd": "/work",
    }));
    assert_eq!(by_path.agent.as_deref(), Some("codex"));
    assert_eq!(
        by_path.session,
        Some(SessionRef::Path("/tmp/s.jsonl".into()))
    );
    assert_eq!(by_path.cwds, vec!["/work"]);

    let shell = transcript::pane_agent_from_herdr(&json!({"cwd": "/work"}));
    assert_eq!(shell.agent, None);
}

// ─── HTTP endpoints against a fake herdr socket ────────────────────────────

fn claude_home_with_fixture() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    copy_to(
        &fixture("claude-session.jsonl"),
        &home
            .path()
            .join("projects/-work-demo")
            .join(format!("{}.jsonl", CLAUDE_ID)),
    );
    std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
    home
}

#[tokio::test]
#[serial]
async fn transcript_endpoint_returns_pages_for_an_agent_pane() {
    let _home = claude_home_with_fixture();
    let _herdr = common::fake_herdr(|method, _| match method {
        "pane.get" => json!({"type": "pane_info", "pane": {
            "pane_id": "w1:p1", "agent": "claude", "agent_status": "blocked",
            "agent_session": {"agent": "claude", "kind": "id", "source": "herdr:claude", "value": CLAUDE_ID},
            "cwd": "/work/demo", "foreground_cwd": "/work/demo",
        }}),
        _ => json!({}),
    });

    let resp = common::send_get(
        common::test_app(),
        "/api/herdr/transcript?pane=w1:p1&limit=2",
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let first = common::body_json(resp).await;
    assert_eq!(first["agent"], "claude");
    assert_eq!(first["agentStatus"], "blocked");
    assert_eq!(first["blocks"].as_array().unwrap().len(), 2);
    assert_eq!(first["hasMore"], true);
    let session = first["session"].as_str().unwrap().to_string();

    let url = format!(
        "/api/herdr/transcript?pane=w1:p1&limit=50&before={}&session={}",
        first["cursor"],
        urlencode(&session)
    );
    let older = common::body_json(common::send_get(common::test_app(), &url).await).await;
    assert_eq!(older["hasMore"], false);
    assert_eq!(older["blocks"][0]["text"], "/model");

    let changed = format!(
        "/api/herdr/transcript?pane=w1:p1&before={}&session=%2Fold.jsonl",
        first["cursor"]
    );
    let resp = common::send_get(common::test_app(), &changed).await;
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    assert_eq!(common::body_json(resp).await["error"], "session_changed");
}

#[tokio::test]
#[serial]
async fn transcript_endpoint_explains_why_it_is_unavailable() {
    let _home = claude_home_with_fixture();
    let _herdr = common::fake_herdr(
        |method, params| match (method, params["pane_id"].as_str()) {
            ("pane.get", Some("w1:shell")) => {
                json!({"pane": {"pane_id": "w1:shell", "cwd": "/work/demo"}})
            }
            ("pane.get", _) => {
                json!({"pane": {"pane_id": "w1:p9", "agent": "codex", "cwd": "/no/sessions"}})
            }
            _ => json!({}),
        },
    );

    let resp = common::send_get(common::test_app(), "/api/herdr/transcript").await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    let resp = common::send_get(common::test_app(), "/api/herdr/transcript?pane=w1:shell").await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let body = common::body_json(resp).await;
    assert_eq!(body["error"], "no_agent");
    assert!(body["message"].as_str().unwrap().contains("Claude Code"));

    std::env::set_var("CODEX_HOME", _home.path().join("no-codex"));
    let resp = common::send_get(common::test_app(), "/api/herdr/transcript?pane=w1:p9").await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        common::body_json(resp).await["error"],
        "transcript_not_found"
    );
}

#[tokio::test]
#[serial]
async fn transcript_endpoint_reports_an_unreachable_herdr() {
    std::env::set_var("HERDR_SOCKET_PATH", "/nonexistent/herdr.sock");
    let resp = common::send_get(common::test_app(), "/api/herdr/transcript?pane=w1:p1").await;
    assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(common::body_json(resp).await["error"], "herdr_unavailable");
}

fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{:02X}", byte),
        })
        .collect()
}
