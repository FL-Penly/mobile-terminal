use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const FIELD_SEPARATOR: &str = "::RUST_TERMINAL_TMUX::";
const GIT_CACHE_TTL: Duration = Duration::from_secs(60);
const GIT_CACHE_CAPACITY: usize = 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TmuxSession {
    pub name: String,
    pub windows: u32,
    pub attached: bool,
    pub last_activity: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSession {
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub command: String,
    pub attached: bool,
    pub windows: u32,
    pub last_activity: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGroup {
    pub project_root: String,
    pub display_name: String,
    pub sessions: Vec<DiscoveredSession>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverySnapshot {
    pub sessions: Vec<TmuxSession>,
    pub scanned_at: u64,
    pub project_groups: Vec<ProjectGroup>,
    pub other_sessions: Vec<DiscoveredSession>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ActivePane {
    name: String,
    path: String,
    command: String,
    windows: u32,
    attached: bool,
    last_activity: u64,
}

#[derive(Clone, Debug)]
struct GitCacheEntry {
    root: Option<String>,
    inserted_at: Instant,
    last_used: Instant,
}

#[derive(Default)]
pub struct GitRootCache {
    entries: HashMap<String, GitCacheEntry>,
}

impl GitRootCache {
    fn resolve_with<F>(&mut self, path: &str, now: Instant, resolver: F) -> Option<String>
    where
        F: FnOnce(&str) -> Option<String>,
    {
        if let Some(entry) = self.entries.get_mut(path) {
            if now.duration_since(entry.inserted_at) < GIT_CACHE_TTL {
                entry.last_used = now;
                return entry.root.clone();
            }
        }

        let root = resolver(path);
        self.entries.insert(
            path.to_string(),
            GitCacheEntry {
                root: root.clone(),
                inserted_at: now,
                last_used: now,
            },
        );
        self.evict_oldest();
        root
    }

    fn evict_oldest(&mut self) {
        while self.entries.len() > GIT_CACHE_CAPACITY {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| key.clone());
            if let Some(key) = oldest {
                self.entries.remove(&key);
            } else {
                break;
            }
        }
    }
}

pub fn scan(cache: &mut GitRootCache) -> Result<DiscoverySnapshot, String> {
    let socket = std::env::var("RUST_TERMINAL_TMUX_SOCKET").ok();
    scan_with_socket(cache, socket.as_deref())
}

fn scan_with_socket(
    cache: &mut GitRootCache,
    socket: Option<&str>,
) -> Result<DiscoverySnapshot, String> {
    let format = format!(
        "#{{session_name}}{s}#{{window_active}}{s}#{{pane_active}}{s}#{{pane_current_path}}{s}#{{pane_current_command}}{s}#{{session_windows}}{s}#{{session_attached}}{s}#{{session_activity}}",
        s = FIELD_SEPARATOR
    );
    let output = tmux_output(socket, &["list-panes", "-a", "-F", &format])?;
    Ok(build_snapshot(
        &output,
        cache,
        Instant::now(),
        resolve_git_root,
    ))
}

fn tmux_output(socket: Option<&str>, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("tmux");
    if let Some(socket) = socket.filter(|socket| !socket.is_empty()) {
        command.args(["-L", socket]);
    }
    let output = command
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn resolve_git_root(path: &str) -> Option<String> {
    let canonical_path = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    let output = Command::new("git")
        .args([
            "-C",
            canonical_path.to_string_lossy().as_ref(),
            "rev-parse",
            "--show-toplevel",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return None;
    }
    Some(
        std::fs::canonicalize(&root)
            .unwrap_or_else(|_| PathBuf::from(&root))
            .to_string_lossy()
            .to_string(),
    )
}

fn parse_active_panes(output: &str) -> Vec<ActivePane> {
    output
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(FIELD_SEPARATOR).collect();
            if fields.len() != 8 || fields[1] != "1" || fields[2] != "1" || fields[3].is_empty() {
                return None;
            }
            Some(ActivePane {
                name: fields[0].to_string(),
                path: fields[3].to_string(),
                command: fields[4].to_string(),
                windows: fields[5].parse().ok()?,
                attached: fields[6].parse::<u32>().ok()? > 0,
                last_activity: fields[7].parse().ok()?,
            })
        })
        .collect()
}

fn build_snapshot<F>(
    output: &str,
    cache: &mut GitRootCache,
    now: Instant,
    mut resolver: F,
) -> DiscoverySnapshot
where
    F: FnMut(&str) -> Option<String>,
{
    let panes = parse_active_panes(output);
    let mut groups: HashMap<String, Vec<DiscoveredSession>> = HashMap::new();
    let mut other_sessions = Vec::new();
    let mut sessions = Vec::new();

    for pane in panes {
        sessions.push(TmuxSession {
            name: pane.name.clone(),
            windows: pane.windows,
            attached: pane.attached,
            last_activity: pane.last_activity,
        });
        let git_root = cache.resolve_with(&pane.path, now, |path| resolver(path));
        let relative_path = git_root
            .as_deref()
            .and_then(|root| Path::new(&pane.path).strip_prefix(root).ok())
            .map(|path| {
                if path.as_os_str().is_empty() {
                    ".".to_string()
                } else {
                    path.to_string_lossy().to_string()
                }
            })
            .unwrap_or_else(|| pane.path.clone());
        let session = DiscoveredSession {
            name: pane.name,
            path: pane.path,
            relative_path,
            command: pane.command,
            attached: pane.attached,
            windows: pane.windows,
            last_activity: pane.last_activity,
        };
        if let Some(root) = git_root {
            groups.entry(root).or_default().push(session);
        } else {
            other_sessions.push(session);
        }
    }

    sessions.sort_by(|a, b| a.name.cmp(&b.name));
    other_sessions.sort_by(|a, b| a.name.cmp(&b.name));
    let mut project_groups: Vec<ProjectGroup> = groups
        .into_iter()
        .map(|(project_root, mut sessions)| {
            sessions.sort_by(|a, b| a.name.cmp(&b.name));
            let display_name = Path::new(&project_root)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| project_root.clone());
            ProjectGroup {
                project_root,
                display_name,
                sessions,
            }
        })
        .collect();
    project_groups.sort_by(|a, b| a.project_root.cmp(&b.project_root));

    DiscoverySnapshot {
        sessions,
        scanned_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        project_groups,
        other_sessions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::process::Command;
    use tempfile::TempDir;

    fn row(fields: [&str; 8]) -> String {
        fields.join(FIELD_SEPARATOR)
    }

    #[test]
    fn parses_only_active_window_and_pane_with_unicode_and_spaces() {
        let output = [
            row(["会话 one", "0", "1", "/tmp/old", "zsh", "2", "0", "10"]),
            row(["会话 one", "1", "0", "/tmp/other", "vim", "2", "0", "10"]),
            row(["会话 one", "1", "1", "/tmp/a b", "codex", "2", "1", "11"]),
            "malformed".to_string(),
        ]
        .join("\n");
        let panes = parse_active_panes(&output);
        assert_eq!(panes.len(), 1);
        assert_eq!(panes[0].name, "会话 one");
        assert_eq!(panes[0].path, "/tmp/a b");
        assert_eq!(panes[0].command, "codex");
    }

    #[test]
    fn skips_missing_or_invalid_fields() {
        let output = [
            row(["bad", "1", "1", "", "zsh", "1", "0", "1"]),
            row(["bad", "1", "1", "/tmp", "zsh", "x", "0", "1"]),
            row(["good", "1", "1", "/tmp", "zsh", "1", "0", "1"]),
        ]
        .join("\n");
        assert_eq!(parse_active_panes(&output).len(), 1);
    }

    #[test]
    fn groups_subdirectories_and_keeps_same_named_roots_separate() {
        let output = [
            row(["a", "1", "1", "/work/one/src", "zsh", "1", "0", "1"]),
            row(["b", "1", "1", "/work/one/web", "node", "1", "0", "2"]),
            row(["c", "1", "1", "/other/one", "vim", "1", "0", "3"]),
            row(["d", "1", "1", "/tmp", "bash", "1", "0", "4"]),
        ]
        .join("\n");
        let mut cache = GitRootCache::default();
        let snapshot = build_snapshot(&output, &mut cache, Instant::now(), |path| {
            if path.starts_with("/work/one") {
                Some("/work/one".to_string())
            } else if path.starts_with("/other/one") {
                Some("/other/one".to_string())
            } else {
                None
            }
        });
        assert_eq!(snapshot.project_groups.len(), 2);
        assert_eq!(snapshot.project_groups[1].sessions[0].relative_path, "src");
        assert_eq!(snapshot.other_sessions[0].name, "d");
    }

    #[test]
    fn path_change_moves_session_between_snapshots() {
        let mut cache = GitRootCache::default();
        let first = build_snapshot(
            &row(["s", "1", "1", "/a/sub", "zsh", "1", "0", "1"]),
            &mut cache,
            Instant::now(),
            |_| Some("/a".to_string()),
        );
        let second = build_snapshot(
            &row(["s", "1", "1", "/b/sub", "zsh", "1", "0", "2"]),
            &mut cache,
            Instant::now(),
            |_| Some("/b".to_string()),
        );
        assert_eq!(first.project_groups[0].project_root, "/a");
        assert_eq!(second.project_groups[0].project_root, "/b");
        assert_ne!(first, second);
    }

    #[test]
    fn cache_covers_positive_negative_and_ttl_expiry() {
        let mut cache = GitRootCache::default();
        let calls = Cell::new(0);
        let now = Instant::now();
        let resolve = |_: &str| {
            calls.set(calls.get() + 1);
            Some("/repo".to_string())
        };
        assert_eq!(
            cache.resolve_with("/repo/a", now, resolve),
            Some("/repo".to_string())
        );
        assert_eq!(
            cache.resolve_with("/repo/a", now + Duration::from_secs(59), resolve),
            Some("/repo".to_string())
        );
        assert_eq!(
            cache.resolve_with("/repo/a", now + Duration::from_secs(61), resolve),
            Some("/repo".to_string())
        );
        assert_eq!(calls.get(), 2);

        let negative_calls = Cell::new(0);
        assert_eq!(
            cache.resolve_with("/none", now, |_| {
                negative_calls.set(negative_calls.get() + 1);
                None
            }),
            None
        );
        assert_eq!(
            cache.resolve_with("/none", now, |_| {
                negative_calls.set(negative_calls.get() + 1);
                None
            }),
            None
        );
        assert_eq!(negative_calls.get(), 1);
    }

    #[test]
    fn cache_evicts_oldest_over_capacity() {
        let mut cache = GitRootCache::default();
        let now = Instant::now();
        for index in 0..=GIT_CACHE_CAPACITY {
            let path = format!("/repo/{index}");
            cache.resolve_with(&path, now + Duration::from_millis(index as u64), |_| None);
        }
        assert_eq!(cache.entries.len(), GIT_CACHE_CAPACITY);
        assert!(!cache.entries.contains_key("/repo/0"));
    }

    struct IsolatedTmux {
        socket: String,
        temp_dir: TempDir,
    }

    impl IsolatedTmux {
        fn new() -> Self {
            Self {
                socket: format!("rust-terminal-test-{}", std::process::id()),
                temp_dir: tempfile::tempdir().unwrap(),
            }
        }

        fn tmux(&self, args: &[&str]) -> String {
            let output = Command::new("tmux")
                .args(["-L", &self.socket])
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "tmux {:?} failed: {}",
                args,
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).to_string()
        }

        fn repo(&self, name: &str) -> PathBuf {
            let path = self.temp_dir.path().join(name);
            std::fs::create_dir_all(&path).unwrap();
            let output = Command::new("git")
                .args(["init", path.to_string_lossy().as_ref()])
                .output()
                .unwrap();
            assert!(output.status.success());
            std::fs::canonicalize(path).unwrap()
        }
    }

    impl Drop for IsolatedTmux {
        fn drop(&mut self) {
            let _ = Command::new("tmux")
                .args(["-L", &self.socket, "kill-server"])
                .output();
        }
    }

    #[test]
    fn isolated_tmux_discovers_moves_switches_windows_and_removes_sessions() {
        let isolated = IsolatedTmux::new();
        let repo_a = isolated.repo("repo-a");
        let repo_b = isolated.repo("repo-b");
        let subdir = repo_a.join("src child");
        std::fs::create_dir_all(&subdir).unwrap();
        isolated.tmux(&[
            "new-session",
            "-d",
            "-s",
            "任意 session",
            "-c",
            subdir.to_string_lossy().as_ref(),
        ]);
        isolated.tmux(&[
            "new-session",
            "-d",
            "-s",
            "second",
            "-c",
            repo_b.to_string_lossy().as_ref(),
        ]);

        let mut cache = GitRootCache::default();
        let first = scan_with_socket(&mut cache, Some(&isolated.socket)).unwrap();
        assert_eq!(first.sessions.len(), 2);
        let group_a = first
            .project_groups
            .iter()
            .find(|group| group.project_root == repo_a.to_string_lossy())
            .unwrap();
        assert_eq!(group_a.sessions[0].name, "任意 session");
        assert_eq!(group_a.sessions[0].relative_path, "src child");

        isolated.tmux(&[
            "send-keys",
            "-t",
            "任意 session",
            &format!("cd {}", shell_escape_path(&repo_b)),
            "Enter",
        ]);
        std::thread::sleep(Duration::from_millis(150));
        let moved = scan_with_socket(&mut cache, Some(&isolated.socket)).unwrap();
        assert!(moved
            .project_groups
            .iter()
            .all(|group| group.project_root != repo_a.to_string_lossy()));
        assert_eq!(
            moved
                .project_groups
                .iter()
                .find(|group| group.project_root == repo_b.to_string_lossy())
                .unwrap()
                .sessions
                .len(),
            2
        );

        isolated.tmux(&[
            "new-window",
            "-d",
            "-t",
            "任意 session",
            "-c",
            repo_a.to_string_lossy().as_ref(),
        ]);
        isolated.tmux(&["select-window", "-t", "任意 session:1"]);
        let switched_window =
            scan_with_socket(&mut GitRootCache::default(), Some(&isolated.socket)).unwrap();
        assert_eq!(
            switched_window
                .project_groups
                .iter()
                .find(|group| group.project_root == repo_a.to_string_lossy())
                .unwrap()
                .sessions[0]
                .name,
            "任意 session"
        );

        isolated.tmux(&["kill-session", "-t", "任意 session"]);
        let killed = scan_with_socket(&mut cache, Some(&isolated.socket)).unwrap();
        assert!(killed
            .sessions
            .iter()
            .all(|session| session.name != "任意 session"));
    }

    #[test]
    fn nonexistent_tmux_socket_returns_error_without_panicking() {
        let result = scan_with_socket(
            &mut GitRootCache::default(),
            Some("rust-terminal-missing-socket"),
        );
        assert!(result.is_err());
    }

    #[test]
    fn resolves_nested_repositories_worktrees_and_invalid_paths() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&["init", repo.to_string_lossy().as_ref()]);
        run_git(&[
            "-C",
            repo.to_string_lossy().as_ref(),
            "config",
            "user.email",
            "test@example.com",
        ]);
        run_git(&[
            "-C",
            repo.to_string_lossy().as_ref(),
            "config",
            "user.name",
            "Test",
        ]);
        std::fs::write(repo.join("README"), "test").unwrap();
        run_git(&["-C", repo.to_string_lossy().as_ref(), "add", "README"]);
        run_git(&[
            "-C",
            repo.to_string_lossy().as_ref(),
            "commit",
            "-m",
            "initial",
        ]);

        let nested = repo.join("vendor/nested");
        std::fs::create_dir_all(&nested).unwrap();
        run_git(&["init", nested.to_string_lossy().as_ref()]);
        let worktree = temp.path().join("worktree");
        run_git(&[
            "-C",
            repo.to_string_lossy().as_ref(),
            "worktree",
            "add",
            "-b",
            "test-worktree",
            worktree.to_string_lossy().as_ref(),
        ]);

        assert_eq!(
            resolve_git_root(repo.join("src").to_string_lossy().as_ref()),
            None
        );
        std::fs::create_dir_all(repo.join("src")).unwrap();
        assert_eq!(
            resolve_git_root(repo.join("src").to_string_lossy().as_ref()),
            Some(
                std::fs::canonicalize(&repo)
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            )
        );
        assert_eq!(
            resolve_git_root(nested.to_string_lossy().as_ref()),
            Some(
                std::fs::canonicalize(&nested)
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            )
        );
        assert_eq!(
            resolve_git_root(worktree.to_string_lossy().as_ref()),
            Some(
                std::fs::canonicalize(&worktree)
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            )
        );
        assert_eq!(
            resolve_git_root(temp.path().join("not-git").to_string_lossy().as_ref()),
            None
        );
    }

    fn run_git(args: &[&str]) {
        let output = Command::new("git").args(args).output().unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn shell_escape_path(path: &Path) -> String {
        format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
    }
}
