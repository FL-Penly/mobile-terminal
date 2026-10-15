mod common;

use serde_json::json;
use serial_test::serial;
use std::sync::{Arc, Mutex};

#[tokio::test]
#[serial]
async fn herdr_page_up_reads_history_and_restores_the_viewport() {
    // 100 rows of scrollback, 10 visible, user scrolled 5 rows up; `recent` holds 30 rows.
    let offset = Arc::new(Mutex::new(5u64));
    let current = offset.clone();
    let herdr = common::fake_herdr(move |method, params| {
        let rows = |from: u64, to: u64| -> String {
            (from..to).map(|row| format!("row{}\n", row)).collect()
        };
        match method {
            "pane.get" => json!({"pane": {"pane_id": "w1:p1", "scroll": {
                "offset_from_bottom": *current.lock().unwrap(), "max_offset_from_bottom": 90, "viewport_rows": 10,
            }}}),
            "pane.scroll" => {
                *current.lock().unwrap() = params["offset_from_bottom"].as_u64().unwrap();
                json!({"type": "pane_info"})
            }
            "pane.read" => {
                let text = match params["source"].as_str().unwrap() {
                    "recent" => rows(70, 100),
                    "recent_unwrapped" => "joined line\n".to_string() + &rows(72, 100),
                    _ => {
                        let top = 100 - *current.lock().unwrap() - 10;
                        rows(top, top + 10)
                    }
                };
                json!({"read": {"text": text}})
            }
            _ => json!({}),
        }
    });

    let newest = common::body_json(
        common::send_get(common::test_app(), "/api/herdr/page-up?pane=w1:p1").await,
    )
    .await;
    assert_eq!(newest["cursor"], 30);
    assert_eq!(newest["hasMore"], true);
    assert_eq!(newest["lines"][0], "joined line");
    assert!(
        !herdr
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|call| call["method"] == "pane.scroll"),
        "the newest window must not move the live viewport"
    );

    let page = common::body_json(
        common::send_get(
            common::test_app(),
            "/api/herdr/page-up?pane=w1:p1&before=30",
        )
        .await,
    )
    .await;
    let lines: Vec<String> = page["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|line| line.as_str().unwrap().to_string())
        .collect();
    let expected: Vec<String> = (0..70).map(|row| format!("row{}", row)).collect();
    assert_eq!(lines, expected);
    assert_eq!(page["cursor"], 100);
    assert_eq!(page["hasMore"], false);
    assert_eq!(*offset.lock().unwrap(), 5, "viewport is restored");
}
