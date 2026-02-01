#!/usr/bin/env python3
"""Diff Server - HTTP API for git diff queries and tmux session management."""

import json
import os
import re
import subprocess
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

CWD_FILE = "/tmp/ttyd_cwd"
DEFAULT_PORT = 7683


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
        if os.path.exists(CWD_FILE):
            with open(CWD_FILE, "r") as f:
                return f.read().strip()
        return os.path.expanduser("~")

    def _is_git_repo(self, path: str) -> bool:
        result = subprocess.run(
            ["git", "rev-parse", "--git-dir"],
            cwd=path,
            capture_output=True,
            text=True,
        )
        return result.returncode == 0

    def _get_git_root(self, path: str) -> str:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=path,
            capture_output=True,
            text=True,
        )
        return result.stdout.strip() if result.returncode == 0 else path

    def _get_branch(self, path: str) -> str:
        result = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=path,
            capture_output=True,
            text=True,
        )
        return result.stdout.strip() if result.returncode == 0 else "unknown"

    def _get_changed_files(self, path: str) -> list:
        # git add -N: stage untracked files as "intent to add" so they appear in diff
        subprocess.run(["git", "add", "-N", "."], cwd=path, capture_output=True)

        result = subprocess.run(
            ["git", "diff", "--name-status"],
            cwd=path,
            capture_output=True,
            text=True,
        )

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
        result = subprocess.run(
            ["git", "show", f"HEAD:{filename}"],
            cwd=path,
            capture_output=True,
            text=True,
        )
        return result.stdout if result.returncode == 0 else ""

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
        result = subprocess.run(
            ["git", "diff", "--numstat", "--", filename],
            cwd=path,
            capture_output=True,
            text=True,
        )
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
        result = subprocess.run(
            ["git", "diff", "--numstat", "--", filename],
            cwd=path,
            capture_output=True,
            text=True,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.startswith("-\t-")
        return False

    def _get_tmux_sessions(self) -> list:
        result = subprocess.run(
            [
                "tmux",
                "ls",
                "-F",
                "#{session_name}:#{session_windows}:#{session_attached}",
            ],
            capture_output=True,
            text=True,
        )
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
        result = subprocess.run(
            ["tmux", "kill-session", "-t", name],
            capture_output=True,
            text=True,
        )
        return result.returncode == 0

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
            self._send_json({"sessions": sessions})

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

        else:
            self._send_json({"error": "not_found"}, 404)

    def log_message(self, format, *args):
        pass


class ReuseAddrHTTPServer(HTTPServer):
    allow_reuse_address = True


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
