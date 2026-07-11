mod common;

use axum::http::StatusCode;
use common::{assert_status, body_json, send_get, send_post_json, test_app, EnvGuard};
use serde_json::json;
use serial_test::serial;
use std::path::Path;
use std::process::Command;

fn make_env_guard(cwd_file: &Path, tty_file: &Path) -> EnvGuard {
    let cwd_str = cwd_file.to_string_lossy().to_string();
    let tty_str = tty_file.to_string_lossy().to_string();
    EnvGuard::set(&[
        ("RUST_TERMINAL_CWD_FILE", cwd_str.as_str()),
        ("RUST_TERMINAL_TTY_FILE", tty_str.as_str()),
    ])
}

struct TestRepo {
    _repo_tmp: tempfile::TempDir,
    _state_tmp: tempfile::TempDir,
    path: std::path::PathBuf,
    _env: EnvGuard,
}

impl TestRepo {
    fn new() -> Self {
        let repo_tmp = tempfile::TempDir::new().unwrap();
        let state_tmp = tempfile::TempDir::new().unwrap();
        let path = repo_tmp.path().to_path_buf();
        let cwd_file = state_tmp.path().join("cwd");
        let tty_file = state_tmp.path().join("tty");

        run(&path, &["git", "init", "-q", "-b", "main"]);
        run(&path, &["git", "config", "user.email", "test@example.com"]);
        run(&path, &["git", "config", "user.name", "Test"]);
        run(&path, &["git", "config", "commit.gpgsign", "false"]);

        std::fs::write(path.join("README.md"), "# initial\n").unwrap();
        run(&path, &["git", "add", "README.md"]);
        run(&path, &["git", "commit", "-q", "-m", "initial"]);

        std::fs::write(&cwd_file, path.to_string_lossy().as_bytes()).unwrap();
        let env = make_env_guard(&cwd_file, &tty_file);

        Self {
            _repo_tmp: repo_tmp,
            _state_tmp: state_tmp,
            path,
            _env: env,
        }
    }

    fn write(&self, name: &str, contents: &str) {
        std::fs::write(self.path.join(name), contents).unwrap();
    }

    fn git(&self, args: &[&str]) {
        let mut full = vec!["git"];
        full.extend_from_slice(args);
        run(&self.path, &full);
    }
}

struct NonGitDir {
    _repo_tmp: tempfile::TempDir,
    _state_tmp: tempfile::TempDir,
    _env: EnvGuard,
}

impl NonGitDir {
    fn new() -> Self {
        let repo_tmp = tempfile::TempDir::new().unwrap();
        let state_tmp = tempfile::TempDir::new().unwrap();
        let cwd_file = state_tmp.path().join("cwd");
        let tty_file = state_tmp.path().join("tty");
        std::fs::write(&cwd_file, repo_tmp.path().to_string_lossy().as_bytes()).unwrap();
        let env = make_env_guard(&cwd_file, &tty_file);
        Self {
            _repo_tmp: repo_tmp,
            _state_tmp: state_tmp,
            _env: env,
        }
    }
}

fn run(cwd: &Path, args: &[&str]) {
    let output = Command::new(args[0])
        .args(&args[1..])
        .current_dir(cwd)
        .output()
        .unwrap_or_else(|e| panic!("failed to run {:?}: {}", args, e));
    assert!(
        output.status.success(),
        "command {:?} failed: stdout={:?}, stderr={:?}",
        args,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
#[serial]
async fn cwd_endpoint_reports_git_repo() {
    let _repo = TestRepo::new();
    let resp = send_get(test_app(), "/api/cwd").await;
    assert_status(&resp, StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["is_git"], true);
}

#[tokio::test]
#[serial]
async fn diff_endpoint_returns_branch_and_files_for_clean_repo() {
    let _repo = TestRepo::new();
    let resp = send_get(test_app(), "/api/diff").await;
    assert_status(&resp, StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["branch"], "main", "full body: {:?}", body);
    assert!(body["files"].is_array());
    assert!(body["summary"]["totalFiles"].is_number());
}

#[tokio::test]
#[serial]
async fn diff_endpoint_returns_unstaged_modification() {
    let repo = TestRepo::new();
    repo.write("README.md", "# updated\n");

    let resp = send_get(test_app(), "/api/diff").await;
    assert_status(&resp, StatusCode::OK);
    let body = body_json(resp).await;
    let files = body["files"].as_array().unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0]["filename"], "README.md");
    assert!(files[0]["additions"].as_i64().unwrap() >= 1);
    assert!(files[0]["deletions"].as_i64().unwrap() >= 1);
}

#[tokio::test]
#[serial]
async fn git_status_returns_branch_and_porcelain_breakdown() {
    let repo = TestRepo::new();
    repo.write("README.md", "# updated\n");
    repo.write("new.txt", "hello\n");
    repo.git(&["add", "new.txt"]);

    let resp = send_get(test_app(), "/api/git/status").await;
    assert_status(&resp, StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["branch"], "main");
    let staged = body["staged"].as_array().unwrap();
    let unstaged = body["unstaged"].as_array().unwrap();
    assert!(staged.iter().any(|f| f["file"] == "new.txt"));
    assert!(unstaged.iter().any(|f| f["file"] == "README.md"));
}

#[tokio::test]
#[serial]
async fn git_branches_returns_local_branches() {
    let repo = TestRepo::new();
    repo.git(&["checkout", "-q", "-b", "feature"]);

    let resp = send_get(test_app(), "/api/git/branches").await;
    assert_status(&resp, StatusCode::OK);
    let body = body_json(resp).await;
    let local = body["local"].as_array().unwrap();
    assert!(local.iter().any(|b| b == "main"));
    assert!(local.iter().any(|b| b == "feature"));
    assert_eq!(body["current"], "feature");
}

#[tokio::test]
#[serial]
async fn git_log_returns_recent_commits() {
    let _repo = TestRepo::new();
    let resp = send_get(test_app(), "/api/git/log?count=10").await;
    assert_status(&resp, StatusCode::OK);
    let body = body_json(resp).await;
    let entries = body.as_array().unwrap();
    assert!(!entries.is_empty());
    assert!(entries[0]["hash"].is_string());
    assert!(entries[0]["message"].is_string());
    assert!(entries[0]["context"].is_string());
    assert_eq!(entries[0]["message"], "initial");
}

#[tokio::test]
#[serial]
async fn git_commit_diff_uses_log_repository_context_after_cwd_changes() {
    let first_repo = TestRepo::new();
    first_repo.write("first.txt", "from first repo\n");
    first_repo.git(&["add", "."]);
    first_repo.git(&["commit", "-q", "-m", "first repo commit"]);
    let app = test_app();

    let log_resp = send_get(app.clone(), "/api/git/log?count=1").await;
    assert_status(&log_resp, StatusCode::OK);
    let log_body = body_json(log_resp).await;
    let hash = log_body[0]["hash"].as_str().unwrap();
    let context = log_body[0]["context"].as_str().unwrap();

    let _second_repo = TestRepo::new();
    let path = format!("/api/git/commit-diff?hash={}&context={}", hash, context);
    let diff_resp = send_get(app, &path).await;
    assert_status(&diff_resp, StatusCode::OK);
    let diff_body = body_json(diff_resp).await;
    assert!(diff_body["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|file| file["filename"] == "first.txt"));
}

#[tokio::test]
#[serial]
async fn git_commit_diff_returns_files_and_hunks() {
    let repo = TestRepo::new();
    repo.write("README.md", "# updated\n");
    repo.write("added.txt", "new file\n");
    repo.git(&["add", "."]);
    repo.git(&["commit", "-q", "-m", "update files"]);

    let resp = send_get(test_app(), "/api/git/commit-diff?hash=HEAD").await;
    assert_status(&resp, StatusCode::OK);
    let body = body_json(resp).await;
    let files = body["files"].as_array().unwrap();
    assert_eq!(files.len(), 2);
    assert!(files.iter().any(|file| file["filename"] == "README.md"));
    assert!(files.iter().any(|file| file["filename"] == "added.txt"));
    assert!(body["summary"]["totalAdditions"].as_i64().unwrap() >= 2);
}

#[tokio::test]
#[serial]
async fn git_commit_diff_rejects_unknown_commit() {
    let _repo = TestRepo::new();
    let resp = send_get(test_app(), "/api/git/commit-diff?hash=deadbeef").await;
    assert_status(&resp, StatusCode::NOT_FOUND);
    let body = body_json(resp).await;
    assert_eq!(body["error"], "commit_not_found");
}

#[tokio::test]
#[serial]
async fn git_stage_and_unstage_round_trip() {
    let repo = TestRepo::new();
    repo.write("a.txt", "hi\n");

    let resp = send_post_json(test_app(), "/api/git/stage", json!({"files": ["a.txt"]})).await;
    assert_status(&resp, StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["success"], true);

    let resp2 = send_post_json(test_app(), "/api/git/unstage", json!({"files": ["a.txt"]})).await;
    assert_status(&resp2, StatusCode::OK);
}

#[tokio::test]
#[serial]
async fn git_commit_succeeds_with_staged_changes() {
    let repo = TestRepo::new();
    repo.write("c.txt", "x\n");
    repo.git(&["add", "c.txt"]);

    let resp = send_post_json(
        test_app(),
        "/api/git/commit",
        json!({"message": "test commit"}),
    )
    .await;
    assert_status(&resp, StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["success"], true);
}

#[tokio::test]
#[serial]
async fn git_file_diff_returns_hunks_for_modified_file() {
    let repo = TestRepo::new();
    repo.write("README.md", "# updated\n");

    let resp = send_get(test_app(), "/api/git/file-diff?file=README.md").await;
    assert_status(&resp, StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["filename"], "README.md");
    let hunks = body["hunks"].as_array().unwrap();
    assert!(
        !hunks.is_empty(),
        "expected at least one hunk, got body {:?}",
        body
    );
}

#[tokio::test]
#[serial]
async fn git_file_diff_returns_empty_hunks_for_unchanged_file() {
    let _repo = TestRepo::new();
    let resp = send_get(test_app(), "/api/git/file-diff?file=README.md").await;
    assert_status(&resp, StatusCode::OK);
    let body = body_json(resp).await;
    let hunks = body["hunks"].as_array().unwrap();
    assert!(hunks.is_empty(), "expected no hunks, got {:?}", body);
}

#[tokio::test]
#[serial]
async fn git_checkout_switches_branch() {
    let repo = TestRepo::new();
    repo.git(&["branch", "feature"]);

    let resp = send_get(test_app(), "/api/git/checkout?branch=feature").await;
    assert_status(&resp, StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["success"], true);
    assert_eq!(body["branch"], "feature");

    let status_resp = send_get(test_app(), "/api/git/status").await;
    let status_body = body_json(status_resp).await;
    assert_eq!(status_body["branch"], "feature");
}

#[tokio::test]
#[serial]
async fn git_checkout_unknown_branch_returns_500() {
    let _repo = TestRepo::new();
    let resp = send_get(test_app(), "/api/git/checkout?branch=does-not-exist").await;
    assert_status(&resp, StatusCode::INTERNAL_SERVER_ERROR);
    let body = body_json(resp).await;
    assert_eq!(body["error"], "checkout_failed");
}

#[tokio::test]
#[serial]
async fn cwd_endpoint_returns_exact_tempdir_path() {
    let repo = TestRepo::new();
    let resp = send_get(test_app(), "/api/cwd").await;
    let body = body_json(resp).await;
    let expected = repo.path.canonicalize().unwrap_or(repo.path.clone());
    let actual = std::path::PathBuf::from(body["cwd"].as_str().unwrap());
    let actual = actual.canonicalize().unwrap_or(actual);
    assert_eq!(actual, expected, "cwd was {:?}", body);
    assert_eq!(body["is_git"], true);
}

#[tokio::test]
#[serial]
async fn diff_in_non_git_dir_returns_not_git_repo() {
    let _dir = NonGitDir::new();
    let resp = send_get(test_app(), "/api/diff").await;
    let body = body_json(resp).await;
    assert_eq!(body["error"], "not_git_repo", "full body: {:?}", body);
}

#[tokio::test]
#[serial]
async fn git_branches_in_non_git_dir_returns_400() {
    let _dir = NonGitDir::new();
    let resp = send_get(test_app(), "/api/git/branches").await;
    let status = resp.status();
    let body = body_json(resp).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "not_git_repo");
}
