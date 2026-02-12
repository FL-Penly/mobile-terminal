#!/usr/bin/env python3
"""Diff Server - HTTP API for git diff queries and tmux session management."""

import json
import os
import re
import subprocess
import sys
import time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

CWD_FILE = "/tmp/ttyd_cwd"
TTY_FILE = "/tmp/ttyd_client_tty"
DEFAULT_PORT = 7683
SUBPROCESS_TIMEOUT = 10


class DiffHandler(BaseHTTPRequestHandler):
    def _send_json(self, data: dict, status: int = 200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def _get_cwd(self) -> str:
        cwd = self._get_tmux_pane_path()
        if cwd:
            return cwd
        if os.path.exists(CWD_FILE):
            with open(CWD_FILE, "r") as f:
                return f.read().strip()
        return os.path.expanduser("~")

    def _get_tmux_pane_path(self) -> str | None:
        client_tty = self._get_client_tty()
        if not client_tty:
            return None
        try:
            session_result = subprocess.run(
                [
                    "tmux",
                    "display-message",
                    "-c",
                    client_tty,
                    "-p",
                    "#{client_session}",
                ],
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
            if session_result.returncode != 0 or not session_result.stdout.strip():
                return None
            session_name = session_result.stdout.strip()

            path_result = subprocess.run(
                [
                    "tmux",
                    "display-message",
                    "-t",
                    session_name,
                    "-p",
                    "#{pane_current_path}",
                ],
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
            if path_result.returncode == 0 and path_result.stdout.strip():
                return path_result.stdout.strip()
        except subprocess.TimeoutExpired:
            pass
        return None
        try:
            result = subprocess.run(
                [
                    "tmux",
                    "display-message",
                    "-c",
                    client_tty,
                    "-p",
                    "#{pane_current_path}",
                ],
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()
        except subprocess.TimeoutExpired:
            pass
        return None

    def _is_git_repo(self, path: str) -> bool:
        try:
            result = subprocess.run(
                ["git", "rev-parse", "--git-dir"],
                cwd=path,
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
            return result.returncode == 0
        except subprocess.TimeoutExpired:
            return False

    def _get_git_root(self, path: str) -> str:
        try:
            result = subprocess.run(
                ["git", "rev-parse", "--show-toplevel"],
                cwd=path,
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
            return result.stdout.strip() if result.returncode == 0 else path
        except subprocess.TimeoutExpired:
            return path

    def _get_branch(self, path: str) -> str:
        try:
            result = subprocess.run(
                ["git", "branch", "--show-current"],
                cwd=path,
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
            return result.stdout.strip() if result.returncode == 0 else "unknown"
        except subprocess.TimeoutExpired:
            return "unknown"

    def _get_all_branches(self, path: str) -> dict:
        branches = {"local": [], "remote": [], "current": ""}
        try:
            current = subprocess.run(
                ["git", "branch", "--show-current"],
                cwd=path,
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
            if current.returncode == 0:
                branches["current"] = current.stdout.strip()

            local = subprocess.run(
                ["git", "branch", "--format=%(refname:short)"],
                cwd=path,
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
            if local.returncode == 0:
                branches["local"] = [b for b in local.stdout.strip().split("\n") if b]

            remote = subprocess.run(
                ["git", "branch", "-r", "--format=%(refname:short)"],
                cwd=path,
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
            if remote.returncode == 0:
                branches["remote"] = [
                    b
                    for b in remote.stdout.strip().split("\n")
                    if b and not b.endswith("/HEAD")
                ]
        except subprocess.TimeoutExpired:
            pass
        return branches

    def _checkout_branch(self, path: str, branch: str) -> tuple[bool, str]:
        try:
            result = subprocess.run(
                ["git", "checkout", branch],
                cwd=path,
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
            if result.returncode == 0:
                return True, ""
            return False, result.stderr.strip()
        except subprocess.TimeoutExpired:
            return False, "Timeout"

    def _get_changed_files(self, path: str) -> list:
        try:
            subprocess.run(
                ["git", "add", "-N", "."],
                cwd=path,
                capture_output=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
            result = subprocess.run(
                ["git", "diff", "--name-status"],
                cwd=path,
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            return []

        files = []
        for line in result.stdout.strip().split("\n"):
            if not line:
                continue
            parts = line.split("\t", 1)
            if len(parts) == 2:
                status, filename = parts
                files.append({"status": status, "filename": filename})
        return files

    def _get_file_content_head(self, path: str, filename: str) -> str:
        try:
            result = subprocess.run(
                ["git", "show", f"HEAD:{filename}"],
                cwd=path,
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
            return result.stdout if result.returncode == 0 else ""
        except subprocess.TimeoutExpired:
            return ""

    def _get_file_content_workdir(self, path: str, filename: str) -> str:
        filepath = os.path.join(path, filename)
        if os.path.exists(filepath):
            try:
                with open(filepath, "r", encoding="utf-8", errors="replace") as f:
                    return f.read()
            except Exception:
                return ""
        return ""

    def _get_file_diff_stats(self, path: str, filename: str) -> tuple:
        try:
            result = subprocess.run(
                ["git", "diff", "--numstat", "--", filename],
                cwd=path,
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            return 0, 0
        if result.returncode == 0 and result.stdout.strip():
            parts = result.stdout.strip().split("\t")
            if len(parts) >= 2:
                try:
                    additions = int(parts[0]) if parts[0] != "-" else 0
                    deletions = int(parts[1]) if parts[1] != "-" else 0
                    return additions, deletions
                except ValueError:
                    pass
        return 0, 0

    def _get_files_diff(self, path: str) -> dict:
        changed_files = self._get_changed_files(path)

        files = []
        total_additions = 0
        total_deletions = 0

        for file_info in changed_files:
            filename = file_info["filename"]
            status = file_info["status"]

            if self._is_binary_file(path, filename):
                files.append(
                    {
                        "filename": filename,
                        "status": status,
                        "binary": True,
                        "oldValue": "",
                        "newValue": "",
                        "additions": 0,
                        "deletions": 0,
                    }
                )
                continue

            old_content = (
                "" if status == "A" else self._get_file_content_head(path, filename)
            )
            new_content = (
                "" if status == "D" else self._get_file_content_workdir(path, filename)
            )
            additions, deletions = self._get_file_diff_stats(path, filename)

            total_additions += additions
            total_deletions += deletions

            files.append(
                {
                    "filename": filename,
                    "status": status,
                    "binary": False,
                    "oldValue": old_content,
                    "newValue": new_content,
                    "additions": additions,
                    "deletions": deletions,
                }
            )

        return {
            "files": files,
            "summary": {
                "totalFiles": len(files),
                "totalAdditions": total_additions,
                "totalDeletions": total_deletions,
            },
        }

    def _is_binary_file(self, path: str, filename: str) -> bool:
        try:
            result = subprocess.run(
                ["git", "diff", "--numstat", "--", filename],
                cwd=path,
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            return False
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.startswith("-\t-")
        return False

    def _get_current_tmux_session(self) -> str | None:
        client_tty = self._get_client_tty()
        if not client_tty:
            return None
        try:
            result = subprocess.run(
                [
                    "tmux",
                    "display-message",
                    "-c",
                    client_tty,
                    "-p",
                    "#{client_session}",
                ],
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()
        except subprocess.TimeoutExpired:
            pass
        return None

    def _get_tmux_sessions(self) -> list:
        try:
            result = subprocess.run(
                [
                    "tmux",
                    "ls",
                    "-F",
                    "#{session_name}:#{session_windows}:#{session_attached}",
                ],
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            return []
        if result.returncode != 0:
            return []

        sessions = []
        for line in result.stdout.strip().split("\n"):
            if not line:
                continue
            parts = line.split(":")
            if len(parts) >= 3:
                sessions.append(
                    {
                        "name": parts[0],
                        "windows": int(parts[1]),
                        "attached": int(parts[2]) > 0,
                    }
                )
        return sessions

    def _kill_tmux_session(self, name: str) -> bool:
        try:
            result = subprocess.run(
                ["tmux", "kill-session", "-t", name],
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
            return result.returncode == 0
        except subprocess.TimeoutExpired:
            return False

    def _get_client_tty(self) -> str | None:
        if not os.path.exists(TTY_FILE):
            return None
        try:
            with open(TTY_FILE, "r") as f:
                return f.read().strip()
        except Exception:
            return None

    def _switch_tmux_session(self, session_name: str) -> tuple[bool, str]:
        client_tty = self._get_client_tty()
        if not client_tty:
            return False, "No client tty found"

        try:
            clients = subprocess.run(
                ["tmux", "list-clients", "-F", "#{client_tty}"],
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
            if client_tty not in clients.stdout:
                return False, f"Client {client_tty} not attached to tmux"

            result = subprocess.run(
                ["tmux", "switch-client", "-c", client_tty, "-t", session_name],
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
            if result.returncode == 0:
                return True, ""
            return False, result.stderr.strip()
        except subprocess.TimeoutExpired:
            return False, "Timeout"

    def _create_tmux_session(self, name: str) -> tuple[bool, str]:
        client_tty = self._get_client_tty()
        if not client_tty:
            return False, "No client tty found"

        try:
            subprocess.run(
                ["tmux", "new-session", "-d", "-s", name],
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
            result = subprocess.run(
                ["tmux", "switch-client", "-c", client_tty, "-t", name],
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT,
            )
            if result.returncode == 0:
                return True, ""
            return False, result.stderr.strip()
        except subprocess.TimeoutExpired:
            return False, "Timeout"

    def _handle_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        try:
            while True:
                cwd = self._get_cwd()
                branch = ""
                path = cwd

                if self._is_git_repo(cwd):
                    git_root = self._get_git_root(cwd)
                    branch = self._get_branch(git_root)
                    path = git_root

                sessions = self._get_tmux_sessions()
                current_session = self._get_current_tmux_session()

                payload = {
                    "branch": branch,
                    "path": path,
                    "tmux": {
                        "sessions": sessions,
                        "currentSession": current_session,
                    },
                }

                data = json.dumps(payload, ensure_ascii=False)
                self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
                self.wfile.flush()
                time.sleep(3)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/cwd":
            cwd = self._get_cwd()
            self._send_json({"cwd": cwd, "is_git": self._is_git_repo(cwd)})

        elif path == "/api/diff":
            cwd = self._get_cwd()

            if not self._is_git_repo(cwd):
                self._send_json(
                    {
                        "error": "not_git_repo",
                        "message": f"'{cwd}' is not a git repository",
                        "cwd": cwd,
                    }
                )
                return

            git_root = self._get_git_root(cwd)
            diff_data = self._get_files_diff(git_root)
            branch = self._get_branch(git_root)

            self._send_json(
                {
                    "cwd": cwd,
                    "git_root": git_root,
                    "branch": branch,
                    **diff_data,
                }
            )

        elif path == "/api/health":
            self._send_json({"status": "ok"})

        elif path == "/api/tmux/list":
            sessions = self._get_tmux_sessions()
            current = self._get_current_tmux_session()
            self._send_json({"sessions": sessions, "currentSession": current})

        elif path == "/api/tmux/kill":
            query = parse_qs(parsed.query)
            name = query.get("name", [None])[0]
            if not name:
                self._send_json(
                    {"error": "missing_name", "message": "Session name required"}, 400
                )
                return
            if self._kill_tmux_session(name):
                self._send_json(
                    {"success": True, "message": f"Session '{name}' killed"}
                )
            else:
                self._send_json(
                    {
                        "error": "kill_failed",
                        "message": f"Failed to kill session '{name}'",
                    },
                    500,
                )

        elif path == "/api/tmux/switch":
            query = parse_qs(parsed.query)
            session = query.get("session", [None])[0]
            if not session:
                self._send_json(
                    {"error": "missing_session", "message": "Session name required"},
                    400,
                )
                return
            success, msg = self._switch_tmux_session(session)
            if success:
                self._send_json({"success": True})
            else:
                self._send_json({"error": "switch_failed", "message": msg}, 500)

        elif path == "/api/tmux/create":
            query = parse_qs(parsed.query)
            name = query.get("name", [None])[0]
            if not name:
                self._send_json(
                    {"error": "missing_name", "message": "Session name required"}, 400
                )
                return
            success, msg = self._create_tmux_session(name)
            if success:
                self._send_json(
                    {"success": True, "message": f"Session '{name}' created"}
                )
            else:
                self._send_json({"error": "create_failed", "message": msg}, 500)

        elif path == "/api/git/branches":
            cwd = self._get_cwd()
            if not self._is_git_repo(cwd):
                self._send_json({"error": "not_git_repo"}, 400)
                return
            git_root = self._get_git_root(cwd)
            branches = self._get_all_branches(git_root)
            self._send_json(branches)

        elif path == "/api/events":
            self._handle_sse()
            return

        elif path == "/api/git/checkout":
            query = parse_qs(parsed.query)
            branch = query.get("branch", [None])[0]
            if not branch:
                self._send_json(
                    {"error": "missing_branch", "message": "Branch name required"}, 400
                )
                return
            cwd = self._get_cwd()
            if not self._is_git_repo(cwd):
                self._send_json({"error": "not_git_repo"}, 400)
                return
            git_root = self._get_git_root(cwd)
            success, msg = self._checkout_branch(git_root, branch)
            if success:
                self._send_json({"success": True, "branch": branch})
            else:
                self._send_json({"error": "checkout_failed", "message": msg}, 500)

        else:
            self._send_json({"error": "not_found"}, 404)

    def log_message(self, format, *args):
        pass


class ReuseAddrHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    server = ReuseAddrHTTPServer(("0.0.0.0", port), DiffHandler)
    print(f"Diff server running on http://0.0.0.0:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
