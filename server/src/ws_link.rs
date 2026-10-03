use bytes::Bytes;
use flate2::{write::DeflateEncoder, Compression};
use serde_json::json;

use std::{
    collections::VecDeque,
    io::Write,
    time::{Duration, Instant},
};

// ═══════════════════════════════════════════════════════════════════════════
// NEGOTIATED TERMINAL LINK
// ═══════════════════════════════════════════════════════════════════════════

pub const OUTPUT_PREFIX: u8 = b'0';
pub const CONTROL_PREFIX: u8 = b'4';
pub const DEFLATE_OUTPUT_PREFIX: u8 = b'5';
pub const INIT_MESSAGE_TIMEOUT: Duration = Duration::from_secs(20);
pub const PING_INTERVAL: Duration = Duration::from_secs(30);
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
pub const CLIENT_IDLE_TIMEOUT: Duration = Duration::from_secs(600);
pub const CLOSE_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkMode {
    Pty,
    Herdr,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Features {
    pub heartbeat: bool,
    pub deflate: bool,
    pub flow: bool,
}

pub fn negotiate(requested: &[String], mode: LinkMode) -> Features {
    let has = |name| requested.iter().any(|feature| feature == name);
    Features {
        heartbeat: mode == LinkMode::Herdr && has("heartbeat"),
        deflate: has("deflate"),
        flow: mode == LinkMode::Herdr && has("flow"),
    }
}

fn control_frame(value: serde_json::Value) -> Bytes {
    let mut frame = vec![CONTROL_PREFIX];
    frame.extend_from_slice(value.to_string().as_bytes());
    frame.into()
}

pub fn hello_frame(features: &Features) -> Option<Bytes> {
    let accepted: Vec<_> = [
        ("heartbeat", features.heartbeat),
        ("deflate", features.deflate),
        ("flow", features.flow),
    ]
    .into_iter()
    .filter_map(|(name, enabled)| enabled.then_some(name))
    .collect();
    (!accepted.is_empty()).then(|| control_frame(json!({"type": "hello", "features": accepted})))
}

pub fn heartbeat_frame() -> Bytes {
    control_frame(json!({"type": "heartbeat"}))
}

pub fn closed_frame(reason: &str) -> Bytes {
    control_frame(json!({"type": "closed", "reason": reason, "retry": false}))
}

// ─── Streaming output encoder ──────────────────────────────────────────────

pub struct OutputEncoder {
    compressor: Option<DeflateEncoder<Vec<u8>>>,
}

impl OutputEncoder {
    pub fn new(deflate: bool) -> Self {
        Self {
            compressor: deflate.then(|| DeflateEncoder::new(Vec::new(), Compression::default())),
        }
    }

    pub fn encode(&mut self, payload: &[u8]) -> std::io::Result<Bytes> {
        let (prefix, output) = match self.compressor.as_mut() {
            Some(compressor) => {
                compressor.write_all(payload)?;
                // Sync flush makes every message immediately decodable without resetting the dictionary.
                compressor.flush()?;
                (DEFLATE_OUTPUT_PREFIX, std::mem::take(compressor.get_mut()))
            }
            None => (OUTPUT_PREFIX, payload.to_vec()),
        };
        let mut frame = Vec::with_capacity(output.len() + 1);
        frame.push(prefix);
        frame.extend_from_slice(&output);
        Ok(frame.into())
    }
}

// ─── Application acknowledgement window ────────────────────────────────────

pub const FLOW_WINDOW_BYTES: u64 = 16 * 1024;
pub const FLOW_MAX_LAG: Duration = Duration::from_millis(2500);
pub const FLOW_MIN_LAG_BYTES: u64 = 2 * 1024;
pub const FLOW_RESUME_BYTES: u64 = 8 * 1024;
pub const KEYFRAME_RETRY_INTERVAL: Duration = Duration::from_secs(2);
pub const KEYFRAME_GIVE_UP: Duration = Duration::from_secs(10);
pub const FLOW_TICK_INTERVAL: Duration = Duration::from_millis(500);

pub fn parse_ack(payload: &[u8]) -> Option<u64> {
    let value: serde_json::Value = serde_json::from_slice(payload).ok()?;
    (value.get("type")?.as_str()? == "ack")
        .then(|| value.get("bytes")?.as_u64())
        .flatten()
}

#[derive(Debug, PartialEq, Eq)]
pub enum GateAction {
    Send,
    Drop,
    None,
    RequestKeyframe,
    Close,
}

struct Skipping {
    since: Instant,
    requested_at: Option<Instant>,
}

pub struct OutputGate {
    enabled: bool,
    sent: u64,
    acked: u64,
    in_flight: VecDeque<(u64, Instant)>,
    skipping: Option<Skipping>,
}

impl OutputGate {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            sent: 0,
            acked: 0,
            in_flight: VecDeque::new(),
            skipping: None,
        }
    }

    fn pending_bytes(&self) -> u64 {
        self.sent - self.acked
    }

    pub fn record_sent(&mut self, len: usize, now: Instant) {
        if !self.enabled {
            return;
        }
        self.sent += len as u64;
        self.in_flight.push_back((self.sent, now));
    }

    pub fn on_frame(&mut self, full: Option<bool>, now: Instant) -> GateAction {
        if full.is_none() {
            self.enabled = false;
            self.skipping = None;
            self.in_flight.clear();
        }
        if !self.enabled {
            return GateAction::Send;
        }
        if self.skipping.is_some() {
            if full == Some(true) && self.pending_bytes() <= FLOW_RESUME_BYTES {
                self.skipping = None;
                return GateAction::Send;
            }
            return GateAction::Drop;
        }
        let old = self
            .in_flight
            .front()
            .is_some_and(|(_, sent_at)| now.duration_since(*sent_at) >= FLOW_MAX_LAG);
        if self.pending_bytes() >= FLOW_WINDOW_BYTES
            || (old && self.pending_bytes() >= FLOW_MIN_LAG_BYTES)
        {
            self.skipping = Some(Skipping {
                since: now,
                requested_at: None,
            });
            return GateAction::Drop;
        }
        GateAction::Send
    }

    pub fn on_ack(&mut self, bytes: u64, now: Instant) -> GateAction {
        if !self.enabled {
            return GateAction::None;
        }
        self.acked = self.acked.max(bytes.min(self.sent));
        while self
            .in_flight
            .front()
            .is_some_and(|(end, _)| *end <= self.acked)
        {
            self.in_flight.pop_front();
        }
        self.request_keyframe(now, false)
    }

    pub fn on_tick(&mut self, now: Instant) -> GateAction {
        if self
            .skipping
            .as_ref()
            .is_some_and(|state| now.duration_since(state.since) >= KEYFRAME_GIVE_UP)
        {
            return GateAction::Close;
        }
        self.request_keyframe(now, true)
    }

    fn request_keyframe(&mut self, now: Instant, retry: bool) -> GateAction {
        let ready = self.pending_bytes() <= FLOW_RESUME_BYTES;
        if let Some(state) = &mut self.skipping {
            let due = state
                .requested_at
                .is_none_or(|last| retry && now.duration_since(last) >= KEYFRAME_RETRY_INTERVAL);
            if ready && due {
                state.requested_at = Some(now);
                return GateAction::RequestKeyframe;
            }
        }
        GateAction::None
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiates_only_features_supported_by_the_mode() {
        let requested = ["heartbeat", "deflate", "flow", "unknown"].map(str::to_owned);
        assert_eq!(
            negotiate(&requested, LinkMode::Pty),
            Features {
                deflate: true,
                ..Features::default()
            }
        );
        assert_eq!(
            negotiate(&requested, LinkMode::Herdr),
            Features {
                heartbeat: true,
                deflate: true,
                flow: true
            }
        );
        assert_eq!(negotiate(&[], LinkMode::Herdr), Features::default());
        assert_eq!(
            negotiate(&["unknown".into()], LinkMode::Herdr),
            Features::default()
        );
    }

    #[test]
    fn control_frames_preserve_the_wire_contract() {
        assert!(hello_frame(&Features::default()).is_none());
        let hello = hello_frame(&Features {
            deflate: true,
            ..Features::default()
        })
        .unwrap();
        assert_eq!(hello[0], CONTROL_PREFIX);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&hello[1..]).unwrap(),
            json!({"type":"hello", "features":["deflate"]})
        );
        let closed = closed_frame("taken_over");
        assert_eq!(closed[0], CONTROL_PREFIX);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&closed[1..]).unwrap(),
            json!({"type":"closed", "reason":"taken_over", "retry":false})
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&heartbeat_frame()[1..]).unwrap(),
            json!({"type":"heartbeat"})
        );
    }
    #[test]
    fn deflate_frames_decode_incrementally() {
        let mut encoder = OutputEncoder::new(true);
        let mut decoder = flate2::Decompress::new(false);
        let mut random = 1_u64;
        let entropy: Vec<u8> = (0..70_000)
            .map(|_| {
                random ^= random << 13;
                random ^= random >> 7;
                random ^= random << 17;
                random as u8
            })
            .collect();
        for payload in [
            "first 中文\n".as_bytes().to_vec(),
            entropy,
            vec![b'x'; 200_000],
        ] {
            let frame = encoder.encode(&payload).unwrap();
            assert_eq!(frame[0], DEFLATE_OUTPUT_PREFIX);
            let mut output = vec![0; payload.len() + 1];
            let before = decoder.total_out();
            decoder
                .decompress(&frame[1..], &mut output, flate2::FlushDecompress::Sync)
                .unwrap();
            output.truncate((decoder.total_out() - before) as usize);
            assert_eq!(output, payload);
        }
        assert_eq!(
            OutputEncoder::new(false).encode(b"raw").unwrap().as_ref(),
            b"0raw"
        );
    }

    #[test]
    fn flate2_fixture_matches_browser_contract() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let mut encoder = OutputEncoder::new(true);
        let frames: Vec<String> = ["hello\n", "中文 😀\n", "\x1b]7337;/dev/pts/42\x1b\\"]
            .into_iter()
            .map(|payload| STANDARD.encode(&encoder.encode(payload.as_bytes()).unwrap()[1..]))
            .collect();
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../frontend/src/utils/__tests__/fixtures/flate2-frames.json");
        if std::env::var("UPDATE_FIXTURES").as_deref() == Ok("1") {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, serde_json::to_string_pretty(&frames).unwrap() + "\n").unwrap();
        }
        let fixture: Vec<String> = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(fixture, frames);
    }
    #[test]
    fn parses_only_valid_cumulative_acknowledgements() {
        assert_eq!(parse_ack(br#"{"type":"ack","bytes":123}"#), Some(123));
        for payload in [
            r#"{"type":"ack","bytes":-1}"#,
            r#"{"type":"ack","bytes":1.5}"#,
            r#"{"type":"ack","bytes":"1"}"#,
            r#"{"type":"heartbeat","bytes":1}"#,
            "null",
            "oops",
        ] {
            assert_eq!(parse_ack(payload.as_bytes()), None);
        }
    }

    #[test]
    fn gate_obeys_window_and_age_boundaries() {
        let now = Instant::now();
        for (bytes, age, expected) in [
            (FLOW_WINDOW_BYTES - 1, Duration::ZERO, GateAction::Send),
            (FLOW_WINDOW_BYTES, Duration::ZERO, GateAction::Drop),
            (FLOW_MIN_LAG_BYTES - 1, FLOW_MAX_LAG, GateAction::Send),
            (
                FLOW_MIN_LAG_BYTES,
                FLOW_MAX_LAG - Duration::from_millis(1),
                GateAction::Send,
            ),
            (FLOW_MIN_LAG_BYTES, FLOW_MAX_LAG, GateAction::Drop),
        ] {
            let mut gate = OutputGate::new(true);
            gate.record_sent(bytes as usize, now);
            assert_eq!(gate.on_frame(Some(false), now + age), expected);
        }
    }

    #[test]
    fn gate_waits_for_ack_then_retries_until_a_full_frame() {
        let now = Instant::now();
        let mut gate = OutputGate::new(true);
        gate.record_sent(FLOW_WINDOW_BYTES as usize, now);
        assert_eq!(gate.on_frame(Some(false), now), GateAction::Drop);
        assert_eq!(gate.on_frame(Some(true), now), GateAction::Drop);
        assert_eq!(gate.on_tick(now), GateAction::None);
        assert_eq!(
            gate.on_ack(FLOW_WINDOW_BYTES - FLOW_RESUME_BYTES - 1, now),
            GateAction::None
        );
        assert_eq!(
            gate.on_ack(FLOW_WINDOW_BYTES - FLOW_RESUME_BYTES, now),
            GateAction::RequestKeyframe
        );
        assert_eq!(gate.on_ack(FLOW_WINDOW_BYTES, now), GateAction::None);
        assert_eq!(
            gate.on_tick(now + KEYFRAME_RETRY_INTERVAL - Duration::from_millis(1)),
            GateAction::None
        );
        assert_eq!(
            gate.on_tick(now + KEYFRAME_RETRY_INTERVAL),
            GateAction::RequestKeyframe
        );
        assert_eq!(gate.on_frame(Some(false), now), GateAction::Drop);
        assert_eq!(gate.on_frame(Some(true), now), GateAction::Send);
        assert_eq!(gate.on_frame(Some(false), now), GateAction::Send);
        assert_eq!(gate.on_tick(now + KEYFRAME_GIVE_UP), GateAction::None);
    }

    #[test]
    fn gate_clamps_acks_and_does_not_move_backwards() {
        let now = Instant::now();
        let mut gate = OutputGate::new(true);
        gate.record_sent(100, now);
        gate.record_sent(100, now);
        gate.on_ack(150, now);
        assert_eq!(gate.pending_bytes(), 50);
        assert_eq!(gate.in_flight.len(), 1);
        gate.on_ack(10, now);
        assert_eq!(gate.pending_bytes(), 50);
        gate.on_ack(u64::MAX, now);
        assert_eq!(gate.pending_bytes(), 0);
        assert!(gate.in_flight.is_empty());
        gate.record_sent(50, now);
        assert_eq!(gate.pending_bytes(), 50);
    }

    #[test]
    fn gate_permanently_disables_without_full_metadata() {
        let now = Instant::now();
        for negotiated in [false, true] {
            let mut gate = OutputGate::new(negotiated);
            gate.record_sent(FLOW_WINDOW_BYTES as usize, now);
            assert_eq!(gate.on_frame(None, now), GateAction::Send);
            assert_eq!(
                gate.on_frame(Some(false), now + KEYFRAME_GIVE_UP),
                GateAction::Send
            );
            assert_eq!(gate.on_tick(now + KEYFRAME_GIVE_UP), GateAction::None);
            assert!(gate.in_flight.is_empty());
        }
        let mut legacy = OutputGate::new(false);
        legacy.record_sent(FLOW_WINDOW_BYTES as usize, now);
        assert_eq!(legacy.on_frame(Some(false), now), GateAction::Send);
    }

    #[test]
    fn gate_tick_requests_after_dropping_aged_frames_and_gives_up() {
        let now = Instant::now();
        let mut gate = OutputGate::new(true);
        gate.record_sent(FLOW_MIN_LAG_BYTES as usize, now);
        let skip = now + FLOW_MAX_LAG;
        assert_eq!(gate.on_frame(Some(false), skip), GateAction::Drop);
        assert_eq!(gate.on_tick(skip), GateAction::RequestKeyframe);
        assert_eq!(
            gate.on_tick(skip + KEYFRAME_GIVE_UP - Duration::from_millis(1)),
            GateAction::RequestKeyframe
        );
        assert_eq!(gate.on_tick(skip + KEYFRAME_GIVE_UP), GateAction::Close);
    }
}
