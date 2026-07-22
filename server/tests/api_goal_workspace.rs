mod common;

use axum::http::StatusCode;
use common::{
    assert_status, body_json, send_get, send_post_bytes, send_post_json, test_app, EnvGuard,
};
use serde_json::{json, Value};
use serial_test::serial;

fn workspace() -> Value {
    json!({
        "version": 1,
        "templates": [{
            "id": "template-1",
            "title": "Release goal",
            "variables": [{"name": "TEST_HINT", "defaultValue": "smoke"}],
            "body": "Run the release checks.",
            "createdAt": "2026-07-21T10:00:00+08:00",
            "updatedAt": "2026-07-21T10:00:00+08:00"
        }],
        "workingCopies": [{
            "id": "copy-1",
            "sourceTemplateId": "template-1",
            "sourceTemplateTitle": "Release goal",
            "title": "Release goal · 2026/7/21 10:00",
            "variables": [{"name": "TEST_HINT", "value": "full"}],
            "body": "Run the release checks.\nInclude the mobile flow.",
            "createdAt": "2026-07-21T10:01:00+08:00",
            "updatedAt": "2026-07-21T10:02:00+08:00"
        }],
        "activeItem": {"kind": "copy", "id": "copy-1"}
    })
}

#[tokio::test]
#[serial]
async fn goal_workspace_round_trips_and_uses_atomic_file() {
    let temp = tempfile::TempDir::new().unwrap();
    let home = temp.path().to_string_lossy().to_string();
    let _env = EnvGuard::set(&[("HOME", home.as_str())]);

    let response = send_post_json(test_app(), "/api/goal-workspace", workspace()).await;
    assert_status(&response, StatusCode::OK);

    let response = send_get(test_app(), "/api/goal-workspace").await;
    assert_status(&response, StatusCode::OK);
    assert_eq!(body_json(response).await, workspace());

    let dir = temp.path().join("promptgoal");
    assert!(dir.join("workspace.json").is_file());
    assert!(std::fs::read_dir(dir).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".tmp")));
}

#[tokio::test]
#[serial]
async fn goal_workspace_rejects_invalid_json_ids_and_variable_names() {
    let temp = tempfile::TempDir::new().unwrap();
    let home = temp.path().to_string_lossy().to_string();
    let _env = EnvGuard::set(&[("HOME", home.as_str())]);

    let response = send_post_bytes(
        test_app(),
        "/api/goal-workspace",
        "application/json",
        b"{not json".to_vec(),
    )
    .await;
    assert_status(&response, StatusCode::BAD_REQUEST);
    assert_eq!(body_json(response).await["error"], "invalid_json");

    let mut invalid_id = workspace();
    invalid_id["templates"][0]["id"] = json!("../escape");
    let response = send_post_json(test_app(), "/api/goal-workspace", invalid_id).await;
    assert_status(&response, StatusCode::BAD_REQUEST);
    assert_eq!(body_json(response).await["error"], "invalid_workspace");

    let mut duplicate_variable = workspace();
    duplicate_variable["templates"][0]["variables"] = json!([
        {"name": "TEST_HINT", "defaultValue": "one"},
        {"name": "test_hint", "defaultValue": "two"}
    ]);
    let response = send_post_json(test_app(), "/api/goal-workspace", duplicate_variable).await;
    assert_status(&response, StatusCode::BAD_REQUEST);
    assert_eq!(body_json(response).await["error"], "invalid_workspace");
}

#[tokio::test]
#[serial]
async fn goal_dump_is_copy_scoped_preserves_bytes_and_rejects_empty_text() {
    let temp = tempfile::TempDir::new().unwrap();
    let home = temp.path().to_string_lossy().to_string();
    let _env = EnvGuard::set(&[("HOME", home.as_str())]);
    assert_status(
        &send_post_json(test_app(), "/api/goal-workspace", workspace()).await,
        StatusCode::OK,
    );

    let text = "  selected 中文\n\nlast line\n";
    let response = send_post_json(
        test_app(),
        "/api/goal-dump",
        json!({"workingCopyId": "copy-1", "text": text}),
    )
    .await;
    assert_status(&response, StatusCode::OK);
    let path = std::path::PathBuf::from(body_json(response).await["path"].as_str().unwrap());
    assert_eq!(
        path.parent().unwrap(),
        temp.path().join("promptgoal/attachments/copy-1")
    );
    assert_eq!(std::fs::read(path).unwrap(), text.as_bytes());

    let empty = send_post_json(
        test_app(),
        "/api/goal-dump",
        json!({"workingCopyId": "copy-1", "text": ""}),
    )
    .await;
    assert_status(&empty, StatusCode::BAD_REQUEST);
    assert_eq!(body_json(empty).await["error"], "empty_text");

    let unknown = send_post_json(
        test_app(),
        "/api/goal-dump",
        json!({"workingCopyId": "copy-2", "text": "context"}),
    )
    .await;
    assert_status(&unknown, StatusCode::NOT_FOUND);

    let traversal = send_post_json(
        test_app(),
        "/api/goal-dump",
        json!({"workingCopyId": "../copy-1", "text": "context"}),
    )
    .await;
    assert_status(&traversal, StatusCode::BAD_REQUEST);
}

#[tokio::test]
#[serial]
async fn goal_dump_rejects_text_over_fifty_megabytes() {
    let temp = tempfile::TempDir::new().unwrap();
    let home = temp.path().to_string_lossy().to_string();
    let _env = EnvGuard::set(&[("HOME", home.as_str())]);
    assert_status(
        &send_post_json(test_app(), "/api/goal-workspace", workspace()).await,
        StatusCode::OK,
    );

    let response = send_post_json(
        test_app(),
        "/api/goal-dump",
        json!({
            "workingCopyId": "copy-1",
            "text": "x".repeat(50 * 1024 * 1024 + 1)
        }),
    )
    .await;
    assert_status(&response, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body_json(response).await["error"], "body_too_large");
}

#[tokio::test]
#[serial]
async fn first_get_merges_each_goal_group_without_modifying_source() {
    let temp = tempfile::TempDir::new().unwrap();
    let home = temp.path().to_string_lossy().to_string();
    let _env = EnvGuard::set(&[("HOME", home.as_str())]);
    let legacy = r#"{
      "presetGroups": [
      {
        "id": "daily",
        "label": "日常使用",
        "presets": [{"label": "Ignore", "text": "not a goal"}]
      },
      {
        "id": "codex-goal-mobile",
        "label": "Codex Goal｜移动完整",
        "presets": [
          {"label": "01｜总目标", "text": "before\n【变量区】\n\n\nTEST_HINT = fast\n\n\n【执行区】\n\n\ncommon start"},
          {"label": "02｜TEST_HINTS", "text": "P3 测试补充信息\nTEST_HINTS = test library first line\nsecond line"},
          {"label": "02A｜BOE 部署", "text": "boe deploy"},
          {"label": "02B｜PPE 部署", "text": "ppe deploy"},
          {"label": "03A｜BOE 飞书测试", "text": "boe lark test"},
          {"label": "03B｜BOE Nexus 测试", "text": "boe nexus test"},
          {"label": "03C｜非 IM 测试", "text": "non im test"},
          {"label": "03D｜PPE 测试", "text": "ppe test"},
          {"label": "04｜公共完成条件", "text": "【变量区】\nTEST_HINT = ignored duplicate\nOTHER = two\n【执行区】\ncommon finish"},
          {"label": "05A｜BOE 回归", "text": "boe regression"},
          {"label": "05B｜PPE 回归", "text": "ppe regression"},
          {"label": "临时测试提示", "text": "temporary scratch content"}
        ]
      },
      {
        "id": "ccgoal-test",
        "label": "CC Goal｜测试起",
        "presets": [{"label": "01｜完整内容", "text": "another full goal"}]
      }]
    }"#;
    std::fs::write(temp.path().join(".vibeterm.json"), legacy).unwrap();

    let response = send_get(test_app(), "/api/goal-workspace").await;
    assert_status(&response, StatusCode::OK);
    let body = body_json(response).await;
    assert_eq!(body["templates"].as_array().unwrap().len(), 5);
    for template in body["templates"].as_array().unwrap() {
        assert!(!template["body"].as_str().unwrap().contains("\n\n\n"));
    }
    assert_eq!(
        body["templates"][0]["title"],
        "Codex Goal｜移动完整｜BOE 飞书"
    );
    assert_eq!(
        body["templates"][1]["title"],
        "Codex Goal｜移动完整｜BOE Nexus"
    );
    assert_eq!(body["templates"][2]["title"], "Codex Goal｜移动完整｜非 IM");
    assert_eq!(body["templates"][3]["title"], "Codex Goal｜移动完整｜PPE");
    assert_eq!(body["templates"][4]["title"], "CC Goal｜测试起");
    assert_ne!(body["templates"][0]["id"], body["templates"][1]["id"]);
    assert_eq!(body["templates"][0]["variables"][0]["name"], "TEST_HINT");
    assert_eq!(body["templates"][0]["variables"][0]["defaultValue"], "fast");
    assert_eq!(body["templates"][0]["variables"][1]["name"], "OTHER");
    assert_eq!(body["templates"][0]["variables"][2]["name"], "TEST_HINTS");
    assert_eq!(
        body["templates"][0]["variables"][2]["defaultValue"],
        "test library first line\nsecond line"
    );
    let boe_lark = body["templates"][0]["body"].as_str().unwrap();
    assert!(boe_lark.contains("common start"));
    assert!(boe_lark.contains("boe deploy"));
    assert!(boe_lark.contains("boe lark test"));
    assert!(boe_lark.contains("common finish"));
    assert!(boe_lark.contains("boe regression"));
    assert!(!boe_lark.contains("ppe deploy"));
    assert!(!boe_lark.contains("boe nexus test"));
    assert!(!boe_lark.contains("non im test"));
    assert!(!boe_lark.contains("ppe test"));
    assert!(!boe_lark.contains("temporary scratch content"));
    assert!(!boe_lark.contains("P3 测试补充信息"));
    assert!(!boe_lark.contains("test library first line"));
    let boe_nexus = body["templates"][1]["body"].as_str().unwrap();
    assert!(boe_nexus.contains("boe deploy"));
    assert!(boe_nexus.contains("boe nexus test"));
    assert!(boe_nexus.contains("boe regression"));
    assert!(!boe_nexus.contains("boe lark test"));
    let non_im = body["templates"][2]["body"].as_str().unwrap();
    assert!(non_im.contains("boe deploy"));
    assert!(non_im.contains("non im test"));
    assert!(non_im.contains("boe regression"));
    let ppe = body["templates"][3]["body"].as_str().unwrap();
    assert!(ppe.contains("ppe deploy"));
    assert!(ppe.contains("ppe test"));
    assert!(ppe.contains("ppe regression"));
    assert!(!ppe.contains("boe deploy"));
    assert!(!boe_lark.contains("TEST_HINT = fast"));
    assert_eq!(body["templates"][4]["body"], "another full goal");
    assert_eq!(
        std::fs::read_to_string(temp.path().join(".vibeterm.json")).unwrap(),
        legacy
    );
    assert!(temp.path().join("promptgoal/workspace.json").is_file());
}

#[tokio::test]
#[serial]
async fn get_moves_existing_test_hints_into_templates_and_working_copies() {
    let temp = tempfile::TempDir::new().unwrap();
    let home = temp.path().to_string_lossy().to_string();
    let _env = EnvGuard::set(&[("HOME", home.as_str())]);
    let promptgoal = temp.path().join("promptgoal");
    std::fs::create_dir_all(&promptgoal).unwrap();
    let mut saved = workspace();
    saved["templates"][0]["variables"] = json!([]);
    saved["templates"][0]["body"] = json!(
        "before\n\nP3 测试补充信息\nTEST_HINTS = template first\ntemplate second\n\nP3 测试（BOE / 飞书 IM）\nafter"
    );
    saved["workingCopies"][0]["variables"] = json!([]);
    saved["workingCopies"][0]["body"] = json!(
        "before copy\n\nP3 测试补充信息\nTEST_HINTS = pasted content\nwith another line\n\nP3 测试（BOE / 飞书 IM）\nafter copy"
    );
    std::fs::write(
        promptgoal.join("workspace.json"),
        serde_json::to_vec_pretty(&saved).unwrap(),
    )
    .unwrap();

    let response = send_get(test_app(), "/api/goal-workspace").await;
    assert_status(&response, StatusCode::OK);
    let body = body_json(response).await;
    assert_eq!(body["templates"][0]["variables"][0]["name"], "TEST_HINTS");
    assert_eq!(
        body["templates"][0]["variables"][0]["defaultValue"],
        "template first\ntemplate second"
    );
    assert_eq!(
        body["templates"][0]["body"],
        "before\n\nP3 测试（BOE / 飞书 IM）\nafter"
    );
    assert_eq!(
        body["workingCopies"][0]["variables"][0]["name"],
        "TEST_HINTS"
    );
    assert_eq!(
        body["workingCopies"][0]["variables"][0]["value"],
        "pasted content\nwith another line"
    );
    assert_eq!(
        body["workingCopies"][0]["body"],
        "before copy\n\nP3 测试（BOE / 飞书 IM）\nafter copy"
    );

    let persisted: Value =
        serde_json::from_slice(&std::fs::read(promptgoal.join("workspace.json")).unwrap()).unwrap();
    assert_eq!(persisted, body);
}

#[tokio::test]
#[serial]
async fn clean_workspace_is_not_resynced_from_legacy_prompt_library() {
    let temp = tempfile::TempDir::new().unwrap();
    let home = temp.path().to_string_lossy().to_string();
    let _env = EnvGuard::set(&[("HOME", home.as_str())]);
    let saved = workspace();
    assert_status(
        &send_post_json(test_app(), "/api/goal-workspace", saved.clone()).await,
        StatusCode::OK,
    );
    std::fs::write(
        temp.path().join(".vibeterm.json"),
        r#"{"presetGroups":[{"id":"new-goal","label":"Legacy Goal","presets":[{"label":"01｜正文","text":"legacy replacement"}]}]}"#,
    )
    .unwrap();

    let response = send_get(test_app(), "/api/goal-workspace").await;
    assert_status(&response, StatusCode::OK);
    assert_eq!(body_json(response).await, saved);
}

#[tokio::test]
#[serial]
async fn get_repairs_old_per_prompt_migration_when_no_working_copies_exist() {
    let temp = tempfile::TempDir::new().unwrap();
    let home = temp.path().to_string_lossy().to_string();
    let _env = EnvGuard::set(&[("HOME", home.as_str())]);
    let promptgoal = temp.path().join("promptgoal");
    std::fs::create_dir_all(&promptgoal).unwrap();
    std::fs::write(
        promptgoal.join("workspace.json"),
        serde_json::to_vec(&json!({
            "version": 1,
            "templates": [
                {
                    "id": "template-migrated-1",
                    "title": "Codex Goal / 01",
                    "variables": [],
                    "body": "old first block",
                    "createdAt": "2026-07-21T00:00:00Z",
                    "updatedAt": "2026-07-21T00:00:00Z"
                },
                {
                    "id": "template-migrated-2",
                    "title": "Codex Goal / 02",
                    "variables": [],
                    "body": "old second block",
                    "createdAt": "2026-07-21T00:00:00Z",
                    "updatedAt": "2026-07-21T00:00:00Z"
                }
            ],
            "workingCopies": [],
            "activeItem": {"kind": "template", "id": "template-migrated-1"}
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        temp.path().join(".vibeterm.json"),
        r#"{"presetGroups":[{"id":"codex-goal","label":"Codex Goal","presets":[{"label":"01｜开始","text":"first"},{"label":"02｜结束","text":"second"}]}]}"#,
    )
    .unwrap();

    let response = send_get(test_app(), "/api/goal-workspace").await;
    assert_status(&response, StatusCode::OK);
    let body = body_json(response).await;
    assert_eq!(body["templates"].as_array().unwrap().len(), 1);
    assert_eq!(body["templates"][0]["title"], "Codex Goal");
    assert_eq!(body["templates"][0]["body"], "first\n\nsecond");
    assert!(body["templates"][0]["id"]
        .as_str()
        .unwrap()
        .starts_with("template-goal-"));
}
