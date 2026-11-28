//! `/api/bars` 的字节级 LRU 缓存。
//!
//! 每个条目在冷路径一次性生成 identity JSON 与 gzip 两个版本；热请求只做
//! `Bytes` 克隆和写响应，不再重复序列化 / 压缩。总权重和条目数都有上限，
//! 避免把多个大周期全部驻留导致内存无限增长。

use axum::body::Bytes;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

pub const DEFAULT_MAX_BYTES: usize = 128 * 1024 * 1024;
pub const DEFAULT_MAX_ENTRIES: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CacheKey {
    pub path: std::path::PathBuf,
    pub mtime_ns: u128,
    pub size: u64,
    pub digits: i32,
    pub server: String,
    pub symbol: String,
    pub period: i64,
}

#[derive(Debug)]
pub struct CachedPayload {
    pub identity: Bytes,
    pub gzip: Option<Bytes>,
}

impl CachedPayload {
    pub fn new(identity: Bytes, gzip: Option<Bytes>) -> Self {
        Self { identity, gzip }
    }

    pub fn weight(&self) -> usize {
        self.identity.len() + self.gzip.as_ref().map_or(0, |body| body.len())
    }

    pub fn body(&self, accept_gzip: bool) -> (&Bytes, bool) {
        match (accept_gzip, self.gzip.as_ref()) {
            (true, Some(body)) => (body, true),
            _ => (&self.identity, false),
        }
    }
}

struct Inner {
    map: HashMap<CacheKey, Arc<CachedPayload>>,
    order: VecDeque<CacheKey>,
    bytes: usize,
}

pub struct BodyCache {
    max_bytes: usize,
    max_entries: usize,
    inner: Mutex<Inner>,
}

impl BodyCache {
    pub fn new(max_bytes: usize, max_entries: usize) -> Self {
        Self {
            max_bytes,
            max_entries,
            inner: Mutex::new(Inner {
                map: HashMap::new(),
                order: VecDeque::new(),
                bytes: 0,
            }),
        }
    }

    pub fn default_limits() -> Self {
        Self::new(DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES)
    }

    pub fn get(&self, key: &CacheKey) -> Option<Arc<CachedPayload>> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let payload = inner.map.get(key).cloned()?;
        if let Some(position) = inner.order.iter().position(|entry| entry == key) {
            if let Some(entry) = inner.order.remove(position) {
                inner.order.push_back(entry);
            }
        }
        Some(payload)
    }

    pub fn insert(&self, key: CacheKey, payload: Arc<CachedPayload>) -> Arc<CachedPayload> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(existing) = inner.map.get(&key) {
            return Arc::clone(existing);
        }
        inner.bytes += payload.weight();
        inner.map.insert(key.clone(), Arc::clone(&payload));
        inner.order.push_back(key);
        Self::evict(&mut inner, self.max_bytes, self.max_entries);
        payload
    }

    fn evict(inner: &mut Inner, max_bytes: usize, max_entries: usize) {
        while inner.bytes > max_bytes || inner.map.len() > max_entries {
            if inner.map.len() <= 1 {
                break;
            }
            let Some(key) = inner.order.pop_front() else {
                break;
            };
            if let Some(removed) = inner.map.remove(&key) {
                inner.bytes = inner.bytes.saturating_sub(removed.weight());
            }
        }
    }

    pub fn clear(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        inner.map.clear();
        inner.order.clear();
        inner.bytes = 0;
    }

    #[cfg(test)]
    fn stats(&self) -> (usize, usize) {
        let inner = self.inner.lock().unwrap();
        (inner.map.len(), inner.bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn key(name: &str) -> CacheKey {
        CacheKey {
            path: PathBuf::from(name),
            mtime_ns: 1,
            size: 10,
            digits: 2,
            server: "s".into(),
            symbol: "X".into(),
            period: 1,
        }
    }

    fn payload(bytes: usize) -> Arc<CachedPayload> {
        Arc::new(CachedPayload::new(Bytes::from(vec![0u8; bytes]), None))
    }

    #[test]
    fn stores_and_returns_payloads() {
        let cache = BodyCache::new(1024, 4);
        let first = payload(100);
        cache.insert(key("a"), Arc::clone(&first));
        let hit = cache.get(&key("a")).unwrap();
        assert!(Arc::ptr_eq(&hit, &first));
        assert_eq!(cache.stats(), (1, 100));
    }

    #[test]
    fn evicts_least_recently_used_by_bytes() {
        let cache = BodyCache::new(250, 10);
        cache.insert(key("a"), payload(100));
        cache.insert(key("b"), payload(100));
        assert!(cache.get(&key("a")).is_some());
        cache.insert(key("c"), payload(100));
        assert!(cache.get(&key("a")).is_some(), "a should be refreshed");
        assert!(cache.get(&key("b")).is_none(), "b was least recently used");
        assert!(cache.get(&key("c")).is_some());
        let (entries, bytes) = cache.stats();
        assert_eq!(entries, 2);
        assert_eq!(bytes, 200);
    }

    #[test]
    fn evicts_by_entry_count_and_keeps_newest() {
        let cache = BodyCache::new(1024, 2);
        cache.insert(key("a"), payload(1));
        cache.insert(key("b"), payload(1));
        cache.insert(key("c"), payload(1));
        assert!(cache.get(&key("a")).is_none());
        assert!(cache.get(&key("b")).is_some());
        assert!(cache.get(&key("c")).is_some());
    }

    #[test]
    fn oversized_single_entry_stays_and_clear_works() {
        let cache = BodyCache::new(10, 2);
        cache.insert(key("big"), payload(100));
        assert!(cache.get(&key("big")).is_some());
        cache.clear();
        assert_eq!(cache.stats(), (0, 0));
    }

    #[test]
    fn gzip_variant_only_when_present() {
        let plain = CachedPayload::new(Bytes::from_static(b"{}"), None);
        assert_eq!(plain.body(true).0.as_ref(), b"{}");
        assert!(!plain.body(true).1);

        let gz = CachedPayload::new(Bytes::from_static(b"{}"), Some(Bytes::from_static(b"gzip")));
        assert_eq!(gz.body(true).0.as_ref(), b"gzip");
        assert!(gz.body(true).1);
        assert_eq!(gz.body(false).0.as_ref(), b"{}");
    }
}
