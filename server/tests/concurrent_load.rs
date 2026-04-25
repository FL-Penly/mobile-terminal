mod common;

use common::{body_json, send_get, test_app};
use std::time::Instant;

#[tokio::test]
async fn fifty_concurrent_health_complete_quickly() {
    let app = test_app();
    let start = Instant::now();
    let mut handles = Vec::with_capacity(50);
    for _ in 0..50 {
        let app = app.clone();
        handles.push(tokio::spawn(async move {
            let resp = send_get(app, "/api/health").await;
            assert_eq!(resp.status(), 200);
        }));
    }
    for h in handles {
        h.await.unwrap();
    }
    let elapsed = start.elapsed();
    assert!(
        elapsed.as_millis() < 1000,
        "50 concurrent /api/health took {}ms, expected <1s",
        elapsed.as_millis()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fifty_concurrent_cwd_dont_serialize_each_other() {
    let app = test_app();
    let start = Instant::now();
    let mut handles = Vec::with_capacity(50);
    for _ in 0..50 {
        let app = app.clone();
        handles.push(tokio::spawn(async move {
            let resp = send_get(app, "/api/cwd").await;
            assert_eq!(resp.status(), 200);
            let body = body_json(resp).await;
            assert!(body["cwd"].is_string());
        }));
    }
    for h in handles {
        h.await.unwrap();
    }
    let elapsed = start.elapsed();
    eprintln!(
        "[concurrent /api/cwd × 50] elapsed = {}ms",
        elapsed.as_millis()
    );
    assert!(
        elapsed.as_millis() < 5000,
        "50 concurrent /api/cwd took {}ms, expected well under 5s after Phase 2 spawn_blocking refactor",
        elapsed.as_millis()
    );
}

#[tokio::test]
async fn concurrent_pane_mode_does_not_block_health() {
    let app = test_app();
    let pane_app = app.clone();
    let pane_handle = tokio::spawn(async move {
        let mut handles = Vec::with_capacity(20);
        for _ in 0..20 {
            let app = pane_app.clone();
            handles.push(tokio::spawn(async move {
                let _ = send_get(app, "/api/tmux/pane-mode").await;
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
    });

    let start = Instant::now();
    let resp = send_get(app, "/api/health").await;
    let health_elapsed = start.elapsed();
    assert_eq!(resp.status(), 200);
    assert!(
        health_elapsed.as_millis() < 500,
        "/api/health latency under pane-mode load was {}ms",
        health_elapsed.as_millis()
    );

    pane_handle.await.unwrap();
}
