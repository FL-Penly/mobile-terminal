//! A bounded, router-local cache. Every request still checks file metadata so a
//! rebuilt frontend is visible without restarting the terminal server.
use axum::http::{header, HeaderMap};
use bytes::Bytes;
use flate2::{write::GzEncoder, Compression};
use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Mutex;

const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_CACHE_BYTES: usize = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 32;

struct Entry {
    etag: String,
    raw: Bytes,
    gzip: Option<Bytes>,
}

#[derive(Default)]
struct Entries {
    files: HashMap<PathBuf, Entry>,
    bytes: usize,
}

#[derive(Clone, Default)]
pub(crate) struct StaticCache(Arc<Mutex<Entries>>);

impl StaticCache {
    pub(crate) async fn read(
        &self,
        path: &Path,
        etag: &str,
        size: u64,
        gzip: bool,
    ) -> std::io::Result<(Bytes, bool)> {
        if size > MAX_FILE_BYTES {
            return tokio::fs::read(path).await.map(|raw| (raw.into(), false));
        }
        // Single-flight reads/compression avoid multiplying CPU and allocations
        // during concurrent refreshes. API and terminal traffic never use this lock.
        let mut cache = self.0.lock().await;
        if let Some(entry) = cache.files.get(path) {
            if entry.etag == etag && (!gzip || entry.gzip.is_some()) {
                return Ok(if gzip {
                    (entry.gzip.as_ref().unwrap().clone(), true)
                } else {
                    (entry.raw.clone(), false)
                });
            }
        }
        let raw = match cache.files.get(path).filter(|entry| entry.etag == etag) {
            Some(entry) => entry.raw.clone(),
            None => tokio::fs::read(path).await?.into(),
        };
        let compressed = if gzip {
            let input = raw.clone();
            Some(
                tokio::task::spawn_blocking(move || {
                    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
                    encoder.write_all(&input)?;
                    encoder.finish().map(Bytes::from)
                })
                .await
                .map_err(std::io::Error::other)??,
            )
        } else {
            None
        };
        let response = match &compressed {
            Some(bytes) => (bytes.clone(), true),
            None => (raw.clone(), false),
        };
        let bytes = raw.len() + compressed.as_ref().map_or(0, Bytes::len);
        if let Some(old) = cache.files.remove(path) {
            cache.bytes -= old.raw.len() + old.gzip.as_ref().map_or(0, Bytes::len);
        }
        if bytes <= MAX_CACHE_BYTES {
            if cache.bytes + bytes > MAX_CACHE_BYTES || cache.files.len() >= MAX_ENTRIES {
                cache.files.clear();
                cache.bytes = 0;
            }
            cache.bytes += bytes;
            cache.files.insert(
                path.into(),
                Entry {
                    etag: etag.into(),
                    raw,
                    gzip: compressed,
                },
            );
        }
        Ok(response)
    }
}

pub(crate) fn file_etag(metadata: &std::fs::Metadata) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("W/\"{:x}-{:x}\"", metadata.len(), modified)
}

// Only intercept an explicit, highest-priority gzip preference. Leave wildcard,
// lower-quality, malformed, and unsupported negotiations to CompressionLayer.
pub(crate) fn prefers_gzip(headers: &HeaderMap) -> bool {
    let mut gzip = None;
    let mut highest = 0.0_f32;
    for value in headers.get_all(header::ACCEPT_ENCODING) {
        let Ok(value) = value.to_str() else {
            return false;
        };
        for coding in value.split(',') {
            let mut parts = coding.trim().split(';');
            let name = parts.next().unwrap_or_default().trim();
            let mut quality = 1.0_f32;
            for parameter in parts {
                let Some((key, value)) = parameter.trim().split_once('=') else {
                    return false;
                };
                if !key.trim().eq_ignore_ascii_case("q") {
                    return false;
                }
                let Ok(parsed) = value.trim().parse::<f32>() else {
                    return false;
                };
                if !(0.0..=1.0).contains(&parsed) {
                    return false;
                }
                quality = parsed;
            }
            highest = highest.max(quality);
            if name.eq_ignore_ascii_case("gzip") {
                if gzip.is_some() {
                    return false;
                }
                gzip = Some(quality);
            }
        }
    }
    gzip.is_some_and(|quality| quality > 0.0 && quality >= highest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gzip_preferences_respect_disabling_and_quality() {
        for (value, expected) in [
            ("gzip, deflate", true),
            ("GZIP", true),
            ("gzip;q=0.5", true),
            ("gzip;q=0", false),
            ("*", false),
            ("gzip;q=0, *;q=1", false),
            ("gzip;q=0.5, identity;q=1", false),
            ("br, gzip", true),
            ("gzip;q=NaN", false),
            ("gzip;q=2", false),
            ("gzip;q=x", false),
            ("gzip;q=1, gzip;q=0", false),
            ("", false),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::ACCEPT_ENCODING, value.parse().unwrap());
            assert_eq!(prefers_gzip(&headers), expected, "{value}");
        }
        assert!(!prefers_gzip(&HeaderMap::new()));
    }

    #[tokio::test]
    async fn repeated_reads_share_bytes_and_updated_versions_replace_them() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("index.html");
        std::fs::write(&path, "original content".repeat(100)).unwrap();
        let cache = StaticCache::default();
        let first = cache.read(&path, "first", 1600, true).await.unwrap().0;
        let second = cache.read(&path, "first", 1600, true).await.unwrap().0;
        assert_eq!(first.as_ptr(), second.as_ptr());
        std::fs::write(&path, "modified content".repeat(100)).unwrap();
        let changed = cache.read(&path, "second", 1600, true).await.unwrap().0;
        assert_ne!(first, changed);
        let raw = cache.read(&path, "second", 1600, false).await.unwrap();
        assert!(!raw.1);
        assert_eq!(raw.0, "modified content".repeat(100));
    }

    #[tokio::test]
    async fn cache_stays_bounded_across_many_paths() {
        let dir = tempfile::tempdir().unwrap();
        let cache = StaticCache::default();
        for index in 0..MAX_ENTRIES * 2 {
            let path = dir.path().join(index.to_string());
            std::fs::write(&path, vec![b'a'; 512 * 1024]).unwrap();
            cache
                .read(&path, "version", 512 * 1024, true)
                .await
                .unwrap();
            let entries = cache.0.lock().await;
            assert!(entries.files.len() <= MAX_ENTRIES);
            assert!(entries.bytes <= MAX_CACHE_BYTES);
        }
    }
}
