use axum::body::Body;
use axum::http::{Request, Response, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use rust_terminal::{build_router, AppState};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::path::PathBuf;
use tower::ServiceExt;

#[allow(dead_code)]
pub fn test_app() -> Router {
    let state = AppState::new("zsh", PathBuf::from("/nonexistent"));
    build_router(state)
}

#[allow(dead_code)]
pub fn test_app_with_static_dir(static_dir: PathBuf) -> Router {
    let state = AppState::new("zsh", static_dir);
    build_router(state)
}

#[allow(dead_code)]
pub async fn send_get(app: Router, path: &str) -> Response<Body> {
    app.oneshot(Request::get(path).body(Body::empty()).unwrap())
        .await
        .unwrap()
}

#[allow(dead_code)]
pub async fn send_post_json(app: Router, path: &str, body: Value) -> Response<Body> {
    app.oneshot(
        Request::post(path)
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap(),
    )
    .await
    .unwrap()
}

#[allow(dead_code)]
pub async fn send_post_bytes(
    app: Router,
    path: &str,
    content_type: &str,
    body: Vec<u8>,
) -> Response<Body> {
    app.oneshot(
        Request::post(path)
            .header("content-type", content_type)
            .body(Body::from(body))
            .unwrap(),
    )
    .await
    .unwrap()
}

#[allow(dead_code)]
pub async fn body_json(resp: Response<Body>) -> Value {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap_or_else(|e| {
        panic!(
            "failed to parse JSON: {}; raw body: {:?}",
            e,
            String::from_utf8_lossy(&bytes)
        )
    })
}

#[allow(dead_code)]
pub async fn body_typed<T: DeserializeOwned>(resp: Response<Body>) -> T {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap_or_else(|e| {
        panic!(
            "failed to parse typed JSON: {}; raw body: {:?}",
            e,
            String::from_utf8_lossy(&bytes)
        )
    })
}

#[allow(dead_code)]
pub async fn body_text(resp: Response<Body>) -> String {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    String::from_utf8_lossy(&bytes).to_string()
}

#[allow(dead_code)]
pub fn assert_status(resp: &Response<Body>, expected: StatusCode) {
    assert_eq!(
        resp.status(),
        expected,
        "expected status {}, got {}",
        expected,
        resp.status()
    );
}

pub struct EnvGuard {
    keys: Vec<(&'static str, Option<String>)>,
}

#[allow(dead_code)]
impl EnvGuard {
    pub fn set(keys: &[(&'static str, &str)]) -> Self {
        let saved: Vec<_> = keys
            .iter()
            .map(|(k, v)| {
                let prev = std::env::var(k).ok();
                std::env::set_var(k, v);
                (*k, prev)
            })
            .collect();
        Self { keys: saved }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (k, prev) in &self.keys {
            match prev {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            }
        }
    }
}
