mod common;

use axum::http::StatusCode;
use serde_json::{json, Value};
use serial_test::serial;
use std::sync::{Arc, Mutex};

#[tokio::test]
#[serial]
async fn herdr_rename_writes_the_tab_and_lists_its_new_label() {
    let tab_label = Arc::new(Mutex::new("1".to_string()));
    let current = tab_label.clone();
    let herdr = common::fake_herdr(move |method, params| match method {
        "pane.list" => json!({"panes": [
            {"pane_id": "w1:p1", "workspace_id": "w1", "tab_id": "w1:t1", "terminal_title_stripped": "vim"},
        ]}),
        "workspace.list" => json!({"workspaces": [{"workspace_id": "w1", "label": "api"}]}),
        "tab.list" => json!({"tabs": [
            {"tab_id": "w1:t1", "workspace_id": "w1", "label": *current.lock().unwrap(), "pane_count": 1},
        ]}),
        "agent.list" => json!({"agents": []}),
        "tab.rename" => {
            *current.lock().unwrap() = params["label"].as_str().unwrap().to_string();
            json!({"type": "tab_info"})
        }
        _ => json!({}),
    });

    let resp = common::send_post_json(
        common::test_app(),
        "/api/herdr/rename",
        json!({"kind": "tab", "id": "w1:t1", "label": " logs "}),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = common::body_json(resp).await;
    assert_eq!(body["kind"], "tab");
    assert_eq!(body["label"], "logs");

    let renames: Vec<Value> = herdr
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter(|call| call["method"].as_str().unwrap_or("").ends_with(".rename"))
        .cloned()
        .collect();
    assert_eq!(renames.len(), 1);
    assert_eq!(renames[0]["method"], "tab.rename");
    assert_eq!(
        renames[0]["params"],
        json!({"tab_id": "w1:t1", "label": "logs"})
    );

    let list =
        common::body_json(common::send_get(common::test_app(), "/api/herdr/list").await).await;
    assert_eq!(list["tabs"][0]["label"], "logs");
    assert_eq!(
        list["panes"][0]["pane_id"], "w1:p1",
        "pane identity is unchanged"
    );
}

#[tokio::test]
#[serial]
async fn herdr_rename_rejects_blank_names_without_calling_herdr() {
    let herdr = common::fake_herdr(|_, _| json!({}));
    let resp = common::send_post_json(
        common::test_app(),
        "/api/herdr/rename",
        json!({"kind": "workspace", "id": "w1", "label": "   "}),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert_eq!(common::body_json(resp).await["error"], "invalid_rename");
    assert!(herdr.calls.lock().unwrap().is_empty());
}
