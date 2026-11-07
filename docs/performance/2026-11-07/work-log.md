# Mobile / VPN optimization — ongoing

## Verified change: status metadata

Status refresh previously called `/api/diff`, which reads tracked and untracked
file contents, parses all hunks, and transfers them even though the status bar
only consumes `cwd`, `git_root`, and `branch`. Both Herdr refresh and the
non-Herdr polling fallback now request `metadata_only=true`. The server resolves
the same terminal target and Git worktree and returns those same identity fields
without constructing a diff. Default callers, including the diff viewer, retain
the full response. Older servers ignore the added query parameter safely.

The integration fixture includes a modified tracked file and a 10,000-line
untracked file. It verifies identical identity fields, both files still present
in the full response, full JSON >170,000 bytes and metadata JSON <1,024 bytes.
This is a fixture-specific transfer reduction, not a measured phone/VPN latency.

Validation:
- Frontend: 32 test files / 297 tests passed; production build passed.
- Rust: full `cargo test` passed, including Git, static HTTP, WebSocket flow,
  compression, takeover, transcript, and concurrent API tests.
- `cargo clippy` passed with one pre-existing unnecessary_sort_by warning in
  `transcript.rs:421`.
- The initial Rust suite exposed a tmux test using the host's personal config.
  The isolated test now supplies `/dev/null` config and `/bin/sh`, and passes.

## Remaining audit

The overall goal remains active. Inspect first-load transfer and compression
cost, status/SSE render work, sustained terminal rendering and input under
bandwidth/latency limits, and background/reconnect behavior. Validate current
production builds in an isolated browser/server setup before claiming completion.
Historical weak-network reports describe an older revision and are not proof for
the current worktree. Do not run legacy benchmarks against live port 7682.

User clarification: existing functionality and experience are a floor, not a
ceiling; improvements to the interaction itself are allowed and desirable.

## Verified change: bounded static response cache

The router caches raw files and gzip variants with a 16 MiB / 32-entry bound,
excluding individual files larger than 4 MiB. Requests still stat the source file
and use the existing weak ETag; rebuilds invalidate both variants without a server
restart. The entry page is prewarmed before the production server listens. Gzip
negotiation, identity responses and `Vary: accept-encoding` are covered by tests;
unsupported/complex negotiation still goes through the existing compression layer.
API, SSE, and WebSocket handlers do not acquire the static cache lock.

A trial using best compression saved only 334 bytes while adding cold compression
cost, so the final version retains default compression and prewarms the entry.
Final measurements use the same frontend body and 31 localhost full-body requests
per isolated release process, with the first request reported separately:

| Metric | Before cache | Final cache |
|---|---:|---:|
| gzip body bytes | 241,683 | 241,683 |
| First request after readiness | 31.53 ms | 1.22 ms |
| Subsequent full responses, median | 30.72 ms | 0.60 ms |
| Subsequent full responses, p95 | 32.91 ms | 0.92 ms |
| Conditional GET | 304 / 1.02 ms | 304 / 0.67 ms |

These timings exclude VPN latency and server startup; prewarming moves the one-time
compression cost to startup. Raw samples, the exact measuring script and the full
Rust test log are in `2026-11-07/`. The script launches and terminates its own server
on a free port, using an isolated tmux socket and nonexistent Herdr socket. It does
not benchmark live port 7682.

## Verified change: WebGL fallback

Browser testing with WebGL disabled exposed an uncaught `WebGL2 not supported`
error: loading the addon before `term.open` deferred activation beyond the existing
try/catch. The addon now activates after opening, with cleanup on failure. The same
390 x 844 touch viewport on an HTTP LAN-IP URL (`isSecureContext === false`) now
has zero page errors, displays all five `CHECK` key echoes through the real server
WebSocket and the deterministic Herdr fixture, and has no horizontal overflow.
This verifies transport/render integration, not a live Herdr or physical-phone run.
Expected fixture limitations are unavailable Herdr list/Git metadata endpoints;
the user-config endpoint was mocked to avoid touching personal settings.

Updated checks: Rust 181 tests passed (90 unit + 91 integration); clippy still has
only the pre-existing transcript sort warning. Frontend production build and the
Terminal component tests passed after the renderer fix; the earlier full frontend
suite passed 297 tests before this small follow-up.

Chrome CDP cold-load check at 32,000 B/s and configured 400 ms latency (HTTP only;
not a TCP/VPN or WebSocket-frame shaping test): startup shell at 515 ms, app entry
at 7,985 ms, React at 8,003 ms, first terminal output at 8,718 ms. This used the
intermediate cached server before startup prewarming; the final frontend was used.
The 241 KB single-file payload remains a material cold-load bottleneck at this
bandwidth. Next investigate deferring optional code without delaying terminal
input, breaking offline/update behavior, or depending on secure-context features.

## Verified changes: frontend transfer and idle work

- Terser with two safe compression passes keeps the complete app in one HTML
  file, reducing the same-source gzip comparison from 242,968 to 235,374 bytes
  (~3.1%). Build time rises from about 3 to 7 seconds. No optional feature is
  deferred behind an additional network request. Final frontend is 235,430 bytes
  with zlib gzip after the render-isolation changes (the Rust gzip encoder differs
  slightly; actual HTTP bytes are recorded separately).
- Layout now subscribes to the 768px media breakpoint and mounts only the visible
  sidebar. Mobile no longer mounts a hidden desktop tree, and opening its drawer
  mounts exactly one tree. Desktop collapse preference survives breakpoint changes.
- The terminal consumes a separate, memoized mode context. Session-list revisions
  no longer rerender the terminal unless its TUI, scrollback or lens-chat mode
  actually changes. Test: 20 unrelated revisions cause zero additional mode
  consumer renders; lens-chat transition immediately causes one render.
- Full frontend suite: 33 files / 300 tests passed; production build passed.

Real Herdr/browser regression used a new isolated `mtbench` session and
`/tmp/mobile-terminal-perf-20261107/weaknet`, never the default Herdr session.
Input, multiline paste, Ctrl/Alt/Shift arrows, pinch-resize, takeover (P0 and P2),
hide/show restore, Git diff, image upload, and sidebar switching passed. The old
sidebar test expected a raw pane ID in a button; it now expands the actual
terminal-only group and selects its named workspace. Original failed results are
retained. The runner's `--only=1` also accidentally matched 11/12/13; selection is
now by exact scenario number. An interrupted run is retained and is not counted
as a successful regression. The new primary matrix is still running.

Remaining checks include plain/tmux integration and final deployment handling.
The current server has real shell children and established connections, so it
must not be blindly restarted. Inspection also found all server instances share
`/tmp/rust_terminal_wrapper.sh` and shell rc files; plain-shell tests must isolate
these before running beside the daily service.

The initial 12-case matrix completed successfully. Actual Rust HTTP gzip body:
241,653 → 234,155 bytes. P2 (400 ±150 ms per direction, 32 KB/s) cold document:
8,514 → 8,231 ms in this first run; warm navigation uses an actual 304 and only
300 transferred bytes. Candidate page errors are empty in every case; baseline
records its pre-existing unsupported-WebGL exception. All Ctrl-C samples and
buffer-preserving recovery probes completed without timeout. P2 Ctrl-C medians
were 1,016 / 1,033 ms and buffered recovery 1,140 / 1,208 ms (baseline/candidate).
These small differences need repeated samples before interpretation. Exactly two
additional P2 rounds (S1/S3/S4-buffered, both versions) are now running, using unique
round2/round3 output paths. No production code or build output will change during
these measurements. Initial results and all regression attempts are saved under
`2026-11-07/browser/`.

Baseline details: HTML is from HEAD 682dd2b. Its saved release server is the
pre-static-cache build with the additive metadata-only query already implemented;
the baseline frontend never requests that query, so its existing behavior is
unchanged. Candidate uses the current release and built frontend.
