mod common;

use futures_util::{SinkExt, StreamExt};
use rust_terminal::{build_router, AppState};
use serde_json::{json, Value};
use serial_test::serial;

use std::{path::PathBuf, time::Duration};

use tokio::{net::TcpStream, task::JoinHandle};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
    MaybeTlsStream, WebSocketStream,
};

// ─── Real HTTP upgrade harness ─────────────────────────────────────────────

type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Server {
    url: String,
    task: JoinHandle<()>,
    _env: common::EnvGuard,
}

impl Server {
    async fn start(extra_env: &[(&'static str, &str)]) -> Self {
        let fixture =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-herdr.py");
        let mut env = vec![("HERDR_BIN_PATH", fixture.to_str().unwrap())];
        env.extend_from_slice(extra_env);
        let guard = common::EnvGuard::set(&env);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "ws://{}/ws?mux=herdr&pane=test:p1",
            listener.local_addr().unwrap()
        );
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                build_router(AppState::new("zsh", PathBuf::from("/nonexistent"))),
            )
            .await
            .unwrap();
        });
        Self {
            url,
            task,
            _env: guard,
        }
    }

    async fn connect(&self, features: Option<&[&str]>) -> Client {
        let (mut client, _) = connect_async(&self.url).await.unwrap();
        let mut init = json!({"AuthToken":"", "columns":80, "rows":24});
        if let Some(features) = features {
            init["features"] = json!(features);
        }
        client
            .send(Message::Binary(init.to_string().into_bytes().into()))
            .await
            .unwrap();
        client
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn receive(client: &mut Client) -> Message {
    tokio::time::timeout(Duration::from_secs(6), client.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}

fn control(message: Message) -> Value {
    let Message::Binary(data) = message else {
        panic!("expected binary control");
    };
    assert_eq!(data[0], b'4');
    serde_json::from_slice(&data[1..]).unwrap()
}

#[tokio::test]
#[serial]
async fn upgrade_works_with_accept_encoding_gzip() {
    let server = Server::start(&[]).await;
    let mut request = server.url.clone().into_client_request().unwrap();
    request
        .headers_mut()
        .insert("accept-encoding", "gzip".parse().unwrap());
    let (mut client, response) = connect_async(request).await.unwrap();
    assert_eq!(response.status(), 101);
    client.close(None).await.unwrap();
}

#[tokio::test]
#[serial]
async fn legacy_client_gets_no_hello_and_raw_output() {
    let server = Server::start(&[]).await;
    let mut client = server.connect(None).await;
    assert_eq!(receive(&mut client).await.into_data(), &b"0FULL-1"[..]);
    client
        .send(Message::Binary(b"0x".to_vec().into()))
        .await
        .unwrap();
    assert_eq!(receive(&mut client).await.into_data(), &b"0ECHO:x"[..]);
    assert!(tokio::time::timeout(Duration::from_secs(6), client.next())
        .await
        .is_err());
    client.close(None).await.unwrap();
}

#[tokio::test]
#[serial]
async fn modern_client_gets_hello_before_output() {
    let server = Server::start(&[]).await;
    let mut client = server
        .connect(Some(&["heartbeat", "deflate", "flow", "unknown"]))
        .await;
    assert_eq!(
        control(receive(&mut client).await),
        json!({"type":"hello","features":["heartbeat","deflate","flow"]})
    );
    assert!(matches!(receive(&mut client).await, Message::Binary(_)));
    client.close(None).await.unwrap();
}

#[tokio::test]
#[serial]
async fn heartbeat_arrives_within_interval() {
    let server = Server::start(&[]).await;
    let mut client = server.connect(Some(&["heartbeat"])).await;
    assert_eq!(control(receive(&mut client).await)["type"], "hello");
    assert_eq!(receive(&mut client).await.into_data(), &b"0FULL-1"[..]);
    assert_eq!(
        control(receive(&mut client).await),
        json!({"type":"heartbeat"})
    );
    client.close(None).await.unwrap();
}

#[tokio::test]
#[serial]
async fn takeover_sends_closed_control_before_close() {
    let server = Server::start(&[("FAKE_HERDR_TAKEOVER", "1")]).await;
    let mut client = server.connect(Some(&["heartbeat"])).await;
    let _ = receive(&mut client).await;
    let _ = receive(&mut client).await;
    assert_eq!(
        control(receive(&mut client).await),
        json!({"type":"closed","reason":"taken_over","retry":false})
    );
    assert!(receive(&mut client)
        .await
        .into_data()
        .starts_with(b"0\r\n[Herdr]"));
    assert!(matches!(receive(&mut client).await, Message::Close(_)));
    let _ = client.flush().await;
}

#[tokio::test]
#[serial]
async fn modern_client_receives_deflated_output() {
    let server = Server::start(&[]).await;
    let mut client = server.connect(Some(&["deflate"])).await;
    assert_eq!(control(receive(&mut client).await)["type"], "hello");
    let mut decoder = flate2::Decompress::new(false);
    for expected in ["FULL-1", "ECHO:x"] {
        if expected.starts_with("ECHO") {
            client
                .send(Message::Binary(b"0x".to_vec().into()))
                .await
                .unwrap();
        }
        let frame = receive(&mut client).await.into_data();
        assert_eq!(frame[0], b'5');
        let mut decoded = [0; 64];
        let before = decoder.total_out();
        decoder
            .decompress(&frame[1..], &mut decoded, flate2::FlushDecompress::Sync)
            .unwrap();
        assert_eq!(
            &decoded[..(decoder.total_out() - before) as usize],
            expected.as_bytes()
        );
    }
    client.close(None).await.unwrap();
}

#[tokio::test]
#[serial]
async fn flow_drops_stale_frames_and_resyncs_with_keyframe() {
    let server = Server::start(&[]).await;
    let mut client = server.connect(Some(&["flow"])).await;
    assert_eq!(control(receive(&mut client).await)["type"], "hello");
    let mut received = receive(&mut client).await.into_data().len();
    client
        .send(Message::Binary(b"0FLOOD".to_vec().into()))
        .await
        .unwrap();
    while let Ok(Some(Ok(Message::Binary(frame)))) =
        tokio::time::timeout(Duration::from_millis(300), client.next()).await
    {
        received += frame.len();
    }
    assert!(received >= 16 * 1024);
    assert!(received <= 16 * 1024 + 1025);
    // A resize while skipping updates the writer's dimensions even if its full frame is dropped.
    client
        .send(Message::Binary(
            br#"1{"columns":91,"rows":31}"#.to_vec().into(),
        ))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    client
        .send(Message::Binary(
            format!("4{}", json!({"type":"ack", "bytes":received}))
                .into_bytes()
                .into(),
        ))
        .await
        .unwrap();
    let frame = tokio::time::timeout(Duration::from_secs(2), client.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_data();
    assert!(frame.starts_with(b"0FULL-"));
    assert!(frame.ends_with(b"SIZE:91x31"));
    client
        .send(Message::Binary(b"0x".to_vec().into()))
        .await
        .unwrap();
    assert_eq!(receive(&mut client).await.into_data(), &b"0ECHO:x"[..]);
    client.close(None).await.unwrap();
}

async fn receive_entire_flood(server: &Server, features: Option<&[&str]>) {
    let mut client = server.connect(features).await;
    if features.is_some() {
        assert_eq!(control(receive(&mut client).await)["type"], "hello");
    }
    assert_eq!(receive(&mut client).await.into_data(), &b"0FULL-1"[..]);
    client
        .send(Message::Binary(b"0FLOOD".to_vec().into()))
        .await
        .unwrap();
    for index in 0..200 {
        let frame = receive(&mut client).await.into_data();
        assert!(frame.starts_with(format!("0FLOOD-{index:03}:").as_bytes()));
    }
    client.close(None).await.unwrap();
}

#[tokio::test]
#[serial]
async fn flow_disabled_without_full_field() {
    let server = Server::start(&[("FAKE_HERDR_NO_FULL", "1")]).await;
    receive_entire_flood(&server, Some(&["flow"])).await;
}

#[tokio::test]
#[serial]
async fn legacy_client_receives_all_frames() {
    let server = Server::start(&[]).await;
    receive_entire_flood(&server, None).await;
}

#[tokio::test]
#[serial]
async fn compressed_flow_resync_preserves_the_connection_dictionary() {
    let server = Server::start(&[]).await;
    let mut client = server.connect(Some(&["flow", "deflate"])).await;
    assert_eq!(control(receive(&mut client).await)["type"], "hello");
    let mut decoder = flate2::Decompress::new(false);
    let mut decode = |frame: &[u8]| {
        assert_eq!(frame[0], b'5');
        let mut output = [0; 4096];
        let before = decoder.total_out();
        let input_before = decoder.total_in();
        decoder
            .decompress(&frame[1..], &mut output, flate2::FlushDecompress::Sync)
            .unwrap();
        assert_eq!(
            (decoder.total_in() - input_before) as usize,
            frame.len() - 1
        );
        output[..(decoder.total_out() - before) as usize].to_vec()
    };
    let first = receive(&mut client).await.into_data();
    assert_eq!(decode(&first), b"FULL-1");
    let mut wire_bytes = first.len();
    client
        .send(Message::Binary(b"0FLOOD_RANDOM".to_vec().into()))
        .await
        .unwrap();
    let mut frames = 0;
    while let Ok(Some(Ok(Message::Binary(frame)))) =
        tokio::time::timeout(Duration::from_millis(300), client.next()).await
    {
        let payload = decode(&frame);
        assert!(payload.starts_with(format!("RANDOM-{frames:03}:").as_bytes()));
        frames += 1;
        wire_bytes += frame.len();
    }
    assert!(frames > 0 && frames < 200);
    assert!((16 * 1024..=16 * 1024 + 1200).contains(&wire_bytes));
    client
        .send(Message::Binary(
            format!("4{}", json!({"type":"ack", "bytes":wire_bytes}))
                .into_bytes()
                .into(),
        ))
        .await
        .unwrap();
    let full = receive(&mut client).await.into_data();
    assert!(decode(&full).starts_with(b"FULL-2"));
    client
        .send(Message::Binary(b"0still-alive".to_vec().into()))
        .await
        .unwrap();
    assert_eq!(
        decode(&receive(&mut client).await.into_data()),
        b"ECHO:still-alive"
    );
    client.close(None).await.unwrap();
}

#[tokio::test]
#[serial]
async fn silent_herdr_client_is_reclaimed_after_ten_minutes() {
    let server = Server::start(&[]).await;
    let mut client = server.connect(None).await;
    assert_eq!(receive(&mut client).await.into_data(), &b"0FULL-1"[..]);
    // Keep virtual time from auto-advancing while the real socket becomes readable.
    let (clock_guard, clock_wait) = std::sync::mpsc::channel::<()>();
    let clock_task = tokio::task::spawn_blocking(move || clock_wait.recv());
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(599)).await;
    assert!(matches!(
        client.next().await.unwrap().unwrap(),
        Message::Ping(_)
    ));
    // Do not read/write again before the deadline: that would flush an automatic Pong.
    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::task::yield_now().await;
    tokio::time::resume();
    let closed = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match client.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                _ => {}
            }
        }
    })
    .await;
    drop(clock_guard);
    let _ = clock_task.await;
    assert!(closed.is_ok(), "silent herdr connection was not reclaimed");
}
