use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::{to_bytes, Body, Bytes};
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use flate2::read::GzDecoder;
use kline_replay::api::{self, AppState};
use kline_replay::catalog::build_catalog;
use serde_json::Value;
use std::io::Read;
use tower::ServiceExt;

fn sample_history() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../data/history")
}

fn web_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("index.html"),
        b"<!doctype html><title>test</title><div>ok</div>",
    )
    .unwrap();
    std::fs::create_dir_all(dir.path().join("js")).unwrap();
    let script = "console.log('x');\n".repeat(200);
    std::fs::write(dir.path().join("js/app.js"), script).unwrap();
    dir
}

fn make_app(history: PathBuf, web: &Path) -> axum::Router {
    let state = Arc::new(AppState::new(history));
    api::router(state, web.to_path_buf())
}

async fn request(
    app: axum::Router,
    method: Method,
    uri: &str,
    headers: &[(&str, &str)],
) -> (StatusCode, HeaderMap, Bytes) {
    let mut builder = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let response = app
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, headers, body)
}

fn decode_gzip(bytes: &Bytes) -> Bytes {
    let mut decoder = GzDecoder::new(bytes.as_ref());
    let mut output = Vec::new();
    decoder.read_to_end(&mut output).unwrap();
    Bytes::from(output)
}

fn header_text(headers: &HeaderMap, name: header::HeaderName) -> String {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

fn write_hst(
    path: &Path,
    symbol: &str,
    period: i32,
    digits: i32,
    bars: &[(i32, f64, f64, f64, f64, i64)],
    legacy: bool,
) {
    let mut bytes = vec![0u8; 148];
    bytes[0..4].copy_from_slice(&401i32.to_le_bytes());
    let symbol_bytes = symbol.as_bytes();
    let symbol_len = symbol_bytes.len().min(12);
    bytes[68..68 + symbol_len].copy_from_slice(&symbol_bytes[..symbol_len]);
    bytes[80..84].copy_from_slice(&period.to_le_bytes());
    bytes[84..88].copy_from_slice(&digits.to_le_bytes());
    for (time, open, high, low, close, volume) in bars {
        if legacy {
            let mut record = vec![0u8; 44];
            record[0..4].copy_from_slice(&time.to_le_bytes());
            record[4..12].copy_from_slice(&open.to_le_bytes());
            record[12..20].copy_from_slice(&high.to_le_bytes());
            record[20..28].copy_from_slice(&low.to_le_bytes());
            record[28..36].copy_from_slice(&close.to_le_bytes());
            record[36..44].copy_from_slice(&volume.to_le_bytes());
            bytes.extend_from_slice(&record);
        } else {
            let mut record = [0u8; 60];
            record[0..4].copy_from_slice(&time.to_le_bytes());
            record[8..16].copy_from_slice(&open.to_le_bytes());
            record[16..24].copy_from_slice(&high.to_le_bytes());
            record[24..32].copy_from_slice(&low.to_le_bytes());
            record[32..40].copy_from_slice(&close.to_le_bytes());
            record[40..44].copy_from_slice(&(*volume as i32).to_le_bytes());
            bytes.extend_from_slice(&record);
        }
    }
    std::fs::write(path, bytes).unwrap();
}

#[test]
fn bundled_catalog_matches_python_facts() {
    let catalog = build_catalog(&sample_history());
    assert!(catalog.found);
    assert_eq!(
        catalog
            .servers
            .iter()
            .map(|server| server.id.as_str())
            .collect::<Vec<_>>(),
        vec!["TradeMaxGlobal-Live14", "TradeMaxGlobal-Demo-2", "default"]
    );
    let live = &catalog.servers[0];
    let xauusd = live
        .symbols
        .iter()
        .find(|symbol| symbol.symbol == "XAUUSD")
        .unwrap();
    let m1 = xauusd
        .periods
        .iter()
        .find(|period| period.period == 1)
        .unwrap();
    assert_eq!(m1.label, "M1");
    assert_eq!(m1.bars, 112228);
    assert_eq!(m1.first, 1785277680);
    assert_eq!(m1.last, 1795513500);
    assert_eq!(m1.digits, 2);
    assert_eq!(m1.file, "XAUUSD1.hst");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bars_contract_headers_gzip_and_cache() {
    let web = web_dir();
    let app = make_app(sample_history(), web.path());

    let (status, headers, body) = request(
        app.clone(),
        Method::GET,
        "/api/bars?server=TradeMaxGlobal-Live14&symbol=XAUUSD&period=1",
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        header_text(&headers, header::CONTENT_TYPE),
        "application/json; charset=utf-8"
    );
    assert_eq!(header_text(&headers, header::CACHE_CONTROL), "no-store");
    assert_eq!(header_text(&headers, header::VARY), "Accept-Encoding");
    assert_eq!(header_text(&headers, header::CONTENT_ENCODING), "");
    assert_eq!(
        header_text(&headers, header::CONTENT_LENGTH),
        body.len().to_string()
    );

    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["server"], "TradeMaxGlobal-Live14");
    assert_eq!(json["symbol"], "XAUUSD");
    assert_eq!(json["period"], 1);
    assert_eq!(json["label"], "M1");
    assert_eq!(json["digits"], 2);
    assert_eq!(json["file"], "XAUUSD1.hst");
    assert_eq!(json["count"], 112228);
    let bars = json["bars"].as_array().unwrap();
    assert_eq!(bars.len(), 112228);
    assert_eq!(
        bars[0],
        serde_json::json!([1785277680, 4022.52, 4023.69, 4022.18, 4023.68, 147])
    );
    assert_eq!(
        bars[bars.len() - 1],
        serde_json::json!([1795513500, 3623.61, 3624.82, 3623.22, 3623.99, 144])
    );

    // 热请求走字节缓存
    let (status, _, cached_body) = request(
        app.clone(),
        Method::GET,
        "/api/bars?server=TradeMaxGlobal-Live14&symbol=XAUUSD&period=1",
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, cached_body);

    // gzip 解压后与 identity 完全一致
    let (status, gzip_headers, gzip_body) = request(
        app.clone(),
        Method::GET,
        "/api/bars?server=TradeMaxGlobal-Live14&symbol=XAUUSD&period=1",
        &[("accept-encoding", "gzip")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(header_text(&gzip_headers, header::CONTENT_ENCODING), "gzip");
    assert_eq!(
        gzip_body.len(),
        header_text(&gzip_headers, header::CONTENT_LENGTH)
            .parse::<usize>()
            .unwrap()
    );
    assert_eq!(decode_gzip(&gzip_body), body);

    // HEAD 不返回 body，但保留内容长度
    let (status, head_headers, head_body) = request(
        app,
        Method::HEAD,
        "/api/bars?server=TradeMaxGlobal-Live14&symbol=XAUUSD&period=1",
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(head_body.is_empty());
    assert_eq!(
        header_text(&head_headers, header::CONTENT_LENGTH),
        body.len().to_string()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn errors_match_python_messages_and_security() {
    let web = web_dir();
    let app = make_app(sample_history(), web.path());

    let (status, _, body) = request(app.clone(), Method::GET, "/api/bars", &[]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["error"],
        "缺少参数: server / symbol / period"
    );

    let (status, _, body) = request(
        app.clone(),
        Method::GET,
        "/api/bars?server=X&symbol=Y&period=abc",
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["error"],
        "period 必须是整数"
    );

    let (status, _, body) = request(
        app.clone(),
        Method::GET,
        "/api/bars?server=X&symbol=Y&period=5",
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["error"],
        "找不到数据文件: X/Y5.hst"
    );

    let (status, _, body) = request(
        app.clone(),
        Method::GET,
        "/api/bars?server=..&symbol=..%2F..%2F..%2Fetc%2Fpasswd&period=1",
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["error"],
        "参数不合法: server / symbol"
    );

    let (status, _, _) = request(
        app,
        Method::GET,
        "/api/bars?server=TradeMaxGlobal-Live14&symbol=NOPE&period=1",
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn catalog_health_and_refresh_contract() {
    let web = web_dir();
    let app = make_app(sample_history(), web.path());

    let (status, headers, body) = request(
        app.clone(),
        Method::GET,
        "/api/catalog",
        &[("accept-encoding", "gzip")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(header_text(&headers, header::CONTENT_ENCODING), "gzip");
    let catalog: Value = serde_json::from_slice(&decode_gzip(&body)).unwrap();
    assert_eq!(catalog["found"], true);
    assert_eq!(catalog["servers"].as_array().unwrap().len(), 3);
    assert!(!catalog["servers"][0]["symbols"]
        .as_array()
        .unwrap()
        .is_empty());

    let (status, _, body) = request(app.clone(), Method::GET, "/api/health", &[]).await;
    assert_eq!(status, StatusCode::OK);
    let health: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(health["ok"], true);
    assert!(health["historyRoot"]
        .as_str()
        .unwrap()
        .ends_with("data/history"));

    let (status, _, body) = request(app, Method::GET, "/api/refresh", &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["ok"], true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bars_reflect_file_changes() {
    let history = tempfile::tempdir().unwrap();
    let server = history.path().join("Srv");
    std::fs::create_dir_all(&server).unwrap();
    let path = server.join("XAUUSD5.hst");
    write_hst(
        &path,
        "XAUUSD",
        5,
        2,
        &[(100, 1.0, 2.0, 0.5, 1.5, 10), (160, 1.5, 2.5, 1.0, 2.0, 20)],
        false,
    );

    let web = web_dir();
    let app = make_app(history.path().to_path_buf(), web.path());
    let uri = "/api/bars?server=Srv&symbol=XAUUSD&period=5";

    let (_, _, body) = request(app.clone(), Method::GET, uri, &[]).await;
    let first: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(first["count"], 2);

    std::thread::sleep(std::time::Duration::from_millis(20));
    write_hst(
        &path,
        "XAUUSD",
        5,
        2,
        &[(100, 9.0, 9.5, 8.5, 9.1, 10), (160, 9.1, 9.6, 9.0, 9.2, 20)],
        false,
    );
    let (_, _, body) = request(app, Method::GET, uri, &[]).await;
    let second: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(second["count"], 2);
    assert_eq!(second["bars"][0][1], 9.0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn legacy_44_byte_file_is_served() {
    let history = tempfile::tempdir().unwrap();
    let server = history.path().join("Srv");
    std::fs::create_dir_all(&server).unwrap();
    write_hst(
        &server.join("EURUSD240.hst"),
        "EURUSD",
        240,
        5,
        &[(100, 1.1, 1.2, 1.0, 1.15, 1234567890123)],
        true,
    );
    let web = web_dir();
    let app = make_app(history.path().to_path_buf(), web.path());
    let (status, _, body) = request(
        app,
        Method::GET,
        "/api/bars?server=Srv&symbol=EURUSD&period=240",
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["count"], 1);
    assert_eq!(json["digits"], 5);
    assert_eq!(json["bars"][0][5], 1234567890123i64);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn static_files_gzip_304_and_traversal_are_safe() {
    let web = web_dir();
    let app = make_app(sample_history(), web.path());

    let (status, _, body) = request(app.clone(), Method::GET, "/", &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert!(String::from_utf8_lossy(&body).contains("test"));

    let (status, headers, body) = request(
        app.clone(),
        Method::GET,
        "/js/app.js",
        &[("accept-encoding", "gzip")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(header_text(&headers, header::CONTENT_ENCODING), "gzip");
    assert!(String::from_utf8_lossy(&decode_gzip(&body)).contains("console.log"));
    let last_modified = header_text(&headers, header::LAST_MODIFIED);
    assert!(!last_modified.is_empty());

    let (status, _, _) = request(
        app.clone(),
        Method::GET,
        "/js/app.js",
        &[("if-modified-since", last_modified.as_str())],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);

    for uri in [
        "/../server/src/main.rs",
        "/%2e%2e/server/src/main.rs",
        "/nope",
    ] {
        let (status, _, _) = request(app.clone(), Method::GET, uri, &[]).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "uri={uri}");
    }

    let (status, _, _) = request(app, Method::POST, "/", &[]).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn duplicate_query_keys_use_first_value() {
    let history = tempfile::tempdir().unwrap();
    let server = history.path().join("Srv");
    std::fs::create_dir_all(&server).unwrap();
    write_hst(
        &server.join("XAUUSD5.hst"),
        "XAUUSD",
        5,
        2,
        &[(100, 1.0, 2.0, 0.5, 1.5, 10)],
        false,
    );
    write_hst(
        &server.join("XAUUSD15.hst"),
        "XAUUSD",
        15,
        2,
        &[(100, 1.0, 2.0, 0.5, 1.5, 10), (200, 1.0, 2.0, 0.5, 1.5, 10)],
        false,
    );
    let web = web_dir();
    let app = make_app(history.path().to_path_buf(), web.path());
    let (_, _, body) = request(
        app,
        Method::GET,
        "/api/bars?server=Srv&symbol=XAUUSD&period=5&period=15",
        &[],
    )
    .await;
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["period"], 5);
    assert_eq!(json["count"], 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_history_still_serves_catalog_found_false() {
    let history = tempfile::tempdir().unwrap().path().join("missing");
    let web = web_dir();
    let app = make_app(history, web.path());
    let (status, _, body) = request(app, Method::GET, "/api/catalog", &[]).await;
    assert_eq!(status, StatusCode::OK);
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["found"], false);
    assert!(json["servers"].as_array().unwrap().is_empty());
}
