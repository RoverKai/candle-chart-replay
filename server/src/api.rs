//! HTTP 路由与 JSON 契约。
//!
//! 所有字段名、排序、中文报错都与旧 Python 服务端保持一致；额外做了两件事：
//! 1. `server` / `symbol` 参数先做路径组件白名单，再 canonicalize 校验，杜绝穿越。
//! 2. `/api/bars` 的 identity + gzip 字节级缓存，热请求不再重复序列化。

use axum::body::{Body, Bytes};
use axum::extract::{RawQuery, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use flate2::write::GzEncoder;
use flate2::Compression;
use percent_encoding::percent_decode_str;
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use tower_http::compression::CompressionLayer;
use tower_http::services::ServeDir;

use crate::cache::{BodyCache, CacheKey, CachedPayload};
use crate::catalog::{build_catalog, find_hst, valid_component};
use crate::config::period_label;
use crate::hst::{read_bars, read_meta, HstMeta, RoundedBars};

const GZIP_THRESHOLD: usize = 1400;

pub struct AppState {
    pub history: PathBuf,
    pub cache: BodyCache,
}

impl AppState {
    pub fn new(history: PathBuf) -> Self {
        Self {
            history,
            cache: BodyCache::default_limits(),
        }
    }
}

pub fn router(state: Arc<AppState>, web_dir: PathBuf) -> Router {
    Router::new()
        .route("/api/catalog", get(api_catalog))
        .route("/api/health", get(api_health))
        .route("/api/refresh", get(api_refresh))
        .route("/api/bars", get(api_bars))
        .fallback_service(ServeDir::new(web_dir))
        .layer(middleware::from_fn(log_api))
        .layer(CompressionLayer::new().gzip(true))
        .with_state(state)
}

async fn log_api(request: Request, next: Next) -> Response {
    if request.uri().path().starts_with("/api/") {
        eprintln!("  {} {}", request.method(), request.uri());
    }
    next.run(request).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Health {
    ok: bool,
    history_root: String,
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

#[derive(Serialize)]
struct BarsResponse<'a> {
    server: &'a str,
    symbol: &'a str,
    period: i64,
    label: String,
    digits: i32,
    file: String,
    count: usize,
    bars: RoundedBars<'a>,
}

async fn api_health(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let body = Health {
        ok: true,
        history_root: state.history.to_string_lossy().into_owned(),
    };
    match serde_json::to_vec(&body) {
        Ok(json) => respond_json(StatusCode::OK, json, accepts_gzip(&headers)),
        Err(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "读取失败: 内部序列化失败",
        ),
    }
}

async fn api_refresh(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    state.cache.clear();
    respond_json(
        StatusCode::OK,
        br#"{"ok":true}"#.to_vec(),
        accepts_gzip(&headers),
    )
}

async fn api_catalog(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let history = state.history.clone();
    let catalog = match tokio::task::spawn_blocking(move || build_catalog(&history)).await {
        Ok(catalog) => catalog,
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "读取失败: 内部任务失败"),
    };
    match serde_json::to_vec(&catalog) {
        Ok(json) => respond_json(StatusCode::OK, json, accepts_gzip(&headers)),
        Err(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "读取失败: 内部序列化失败",
        ),
    }
}

async fn api_bars(
    State(state): State<Arc<AppState>>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Response {
    let accept_gzip = accepts_gzip(&headers);
    let query = parse_query(raw.as_deref().unwrap_or(""));
    let server = first_value(&query, "server").unwrap_or_default();
    let symbol = first_value(&query, "symbol").unwrap_or_default();
    let raw_period = first_value(&query, "period").unwrap_or_else(|| "0".to_string());

    // 与 Python `parse_qs` 一致：空值会被丢弃，按默认 0 处理，最终报“缺少参数”；
    // 只有非空且无法解析（包括纯空白）才报“必须是整数”。
    let period = if raw_period.is_empty() {
        0
    } else {
        match raw_period.trim().parse::<i64>() {
            Ok(period) => period,
            Err(_) => return json_error(StatusCode::BAD_REQUEST, "period 必须是整数"),
        }
    };
    if server.is_empty() || symbol.is_empty() || period == 0 {
        return json_error(
            StatusCode::BAD_REQUEST,
            "缺少参数: server / symbol / period",
        );
    }
    if !valid_component(&server) || !valid_component(&symbol) {
        return json_error(StatusCode::BAD_REQUEST, "参数不合法: server / symbol");
    }

    let history = state.history.clone();
    let server_for_find = server.clone();
    let symbol_for_find = symbol.clone();
    let found = tokio::task::spawn_blocking(move || {
        find_hst(&history, &server_for_find, &symbol_for_find, period)
    })
    .await;
    let path = match found {
        Ok(Some(path)) => path,
        Ok(None) => {
            return json_error(
                StatusCode::NOT_FOUND,
                format!("找不到数据文件: {server}/{symbol}{period}.hst"),
            )
        }
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "读取失败: 内部任务失败"),
    };

    let path_for_meta = path.clone();
    let meta_read = tokio::task::spawn_blocking(move || -> Result<(HstMeta, u64, u128), String> {
        let meta = read_meta(&path_for_meta).map_err(|error| format!("读取失败: {error}"))?;
        let metadata =
            fs::metadata(&path_for_meta).map_err(|error| format!("读取失败: {error}"))?;
        let size = metadata.len();
        let mtime_ns = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        Ok((meta, size, mtime_ns))
    })
    .await;

    let (meta, size, mtime_ns) = match meta_read {
        Ok(Ok(values)) => values,
        Ok(Err(message)) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, message),
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "读取失败: 内部任务失败"),
    };

    let key = CacheKey {
        path: path.clone(),
        mtime_ns,
        size,
        digits: meta.digits,
        server: server.clone(),
        symbol: symbol.clone(),
        period,
    };
    if let Some(payload) = state.cache.get(&key) {
        return respond_cached(StatusCode::OK, &payload, accept_gzip);
    }

    let build_path = path.clone();
    let build_digits = meta.digits;
    let build_server = server.clone();
    let build_symbol = symbol.clone();
    let built = tokio::task::spawn_blocking(move || {
        build_bars_payload(build_path, build_digits, build_server, build_symbol, period)
    })
    .await;

    let payload = match built {
        Ok(Ok(payload)) => Arc::new(payload),
        Ok(Err(message)) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, message),
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "读取失败: 内部任务失败"),
    };
    let payload = state.cache.insert(key, payload);
    respond_cached(StatusCode::OK, &payload, accept_gzip)
}

fn build_bars_payload(
    path: PathBuf,
    digits: i32,
    server: String,
    symbol: String,
    period: i64,
) -> Result<CachedPayload, String> {
    let bars = read_bars(&path).map_err(|error| format!("读取失败: {error}"))?;
    let file = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let label = if i32::try_from(period).is_ok() {
        period_label(period as i32)
    } else {
        format!("M{period}")
    };
    let body = BarsResponse {
        server: &server,
        symbol: &symbol,
        period,
        label,
        digits,
        file,
        count: bars.len(),
        bars: RoundedBars::new(&bars, digits),
    };
    let json = serde_json::to_vec(&body).map_err(|error| format!("读取失败: {error}"))?;
    Ok(payload_from_json(json))
}

fn payload_from_json(json: Vec<u8>) -> CachedPayload {
    let identity = Bytes::from(json);
    let gzip = if identity.len() > GZIP_THRESHOLD {
        gzip_bytes(&identity)
    } else {
        None
    };
    CachedPayload::new(identity, gzip)
}

fn gzip_bytes(data: &[u8]) -> Option<Bytes> {
    // level 4 与 Python 的 level 6 体积只差约 2%，冷路径压缩耗时约 1/3。
    // 热请求命中的是缓存好的 gzip 体，这里只影响每个文件/版本首次加载。
    let mut encoder = GzEncoder::new(Vec::new(), Compression::new(4));
    encoder.write_all(data).ok()?;
    encoder.finish().ok().map(Bytes::from)
}

fn respond_json(status: StatusCode, json: Vec<u8>, accept_gzip: bool) -> Response {
    let payload = payload_from_json(json);
    respond_cached(status, &Arc::new(payload), accept_gzip)
}

fn respond_cached(status: StatusCode, payload: &CachedPayload, accept_gzip: bool) -> Response {
    let (body, gzipped) = payload.body(accept_gzip);
    let mut response = Response::new(Body::from(body.clone()));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    if let Ok(length) = HeaderValue::from_str(&body.len().to_string()) {
        headers.insert(header::CONTENT_LENGTH, length);
    }
    if gzipped {
        headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    }
    response
}

fn json_error(status: StatusCode, message: impl Into<String>) -> Response {
    let body = ErrorBody {
        error: message.into(),
    };
    match serde_json::to_vec(&body) {
        Ok(json) => respond_json(status, json, false),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

fn accepts_gzip(headers: &HeaderMap) -> bool {
    let Some(raw) = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    raw.split(',').any(|part| {
        let mut pieces = part.split(';');
        let encoding = pieces.next().unwrap_or_default().trim();
        if !encoding.eq_ignore_ascii_case("gzip") {
            return false;
        }
        !pieces.any(|parameter| {
            let value = parameter.trim();
            value.eq_ignore_ascii_case("q=0")
                || value.eq_ignore_ascii_case("q=0.0")
                || value.eq_ignore_ascii_case("q=0.00")
                || value.eq_ignore_ascii_case("q=0.000")
        })
    })
}

/// 与 `urllib.parse.parse_qs` 一致：按 `&` 切分、`+` 视为空格、重复键保留顺序（取第一个）。
pub fn parse_query(raw: &str) -> Vec<(String, String)> {
    raw.split('&')
        .filter(|part| !part.is_empty())
        .map(|part| match part.split_once('=') {
            Some((key, value)) => (decode_component(key), decode_component(value)),
            None => (decode_component(part), String::new()),
        })
        .collect()
}

fn decode_component(raw: &str) -> String {
    let spaced = raw.replace('+', " ");
    percent_decode_str(&spaced).decode_utf8_lossy().into_owned()
}

pub fn first_value(pairs: &[(String, String)], key: &str) -> Option<String> {
    pairs
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_query_with_plus_percent_and_duplicates() {
        let pairs = parse_query("server=A%20B&symbol=XAUUSD&period=5&period=15&flag");
        assert_eq!(first_value(&pairs, "server").unwrap(), "A B");
        assert_eq!(first_value(&pairs, "symbol").unwrap(), "XAUUSD");
        assert_eq!(first_value(&pairs, "period").unwrap(), "5");
        assert_eq!(first_value(&pairs, "flag").unwrap(), "");
        assert!(first_value(&pairs, "missing").is_none());
    }

    #[test]
    fn empty_period_is_treated_as_missing() {
        let query = parse_query("server=X&symbol=Y&period=");
        let raw = first_value(&query, "period").unwrap_or_else(|| "0".to_string());
        assert_eq!(raw, "");
        let period = if raw.is_empty() {
            0
        } else {
            raw.trim().parse::<i64>().unwrap()
        };
        assert_eq!(period, 0);
    }

    #[test]
    fn gzip_negotiation_respects_q_zero() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("br, gzip;q=0.5"),
        );
        assert!(accepts_gzip(&headers));
        headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("gzip;q=0"),
        );
        assert!(!accepts_gzip(&headers));
        headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("br"));
        assert!(!accepts_gzip(&headers));
    }

    #[test]
    fn payload_compresses_above_threshold() {
        let small = payload_from_json(b"{}".to_vec());
        assert!(small.gzip.is_none());
        let large = payload_from_json(vec![b'1'; GZIP_THRESHOLD + 1]);
        assert!(large.gzip.is_some());
    }
}
