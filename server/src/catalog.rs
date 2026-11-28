//! 账户 / 品种 / 周期发现，以及安全的 `.hst` 路径解析。

use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::config::{period_label, server_label};
use crate::hst::{parse_filename, read_meta};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub history_root: String,
    pub found: bool,
    pub servers: Vec<ServerEntry>,
}

#[derive(Debug, Serialize)]
pub struct ServerEntry {
    pub id: String,
    pub label: String,
    pub symbols: Vec<SymbolEntry>,
}

#[derive(Debug, Serialize)]
pub struct SymbolEntry {
    pub symbol: String,
    pub periods: Vec<PeriodEntry>,
}

#[derive(Debug, Serialize)]
pub struct PeriodEntry {
    pub period: i32,
    pub label: String,
    pub bars: u64,
    pub first: i64,
    pub last: i64,
    pub digits: i32,
    pub file: String,
    pub size: u64,
    pub mtime: i64,
}

fn is_hst(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("hst"))
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

pub fn build_catalog(history_root: &Path) -> Catalog {
    let display_root = history_root.to_string_lossy().into_owned();
    if !history_root.is_dir() {
        return Catalog {
            history_root: display_root,
            found: false,
            servers: Vec::new(),
        };
    }

    let entries = match fs::read_dir(history_root) {
        Ok(entries) => entries,
        Err(error) => {
            eprintln!("[!] 读取数据目录失败: {} ({error})", history_root.display());
            return Catalog {
                history_root: display_root,
                found: true,
                servers: Vec::new(),
            };
        }
    };

    let mut server_dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    server_dirs.sort_by_key(|path| file_name(path).to_lowercase());

    let mut servers = Vec::new();
    for server_dir in server_dirs {
        let files = match fs::read_dir(&server_dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        let mut hst_files: Vec<PathBuf> = files
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.is_file() && is_hst(path))
            .collect();
        hst_files.sort_by_key(|path| file_name(path));

        let mut symbols: BTreeMap<String, Vec<PeriodEntry>> = BTreeMap::new();
        for path in hst_files {
            let name = file_name(&path);
            let Some((symbol, _)) = parse_filename(&name) else {
                continue;
            };
            let Ok(meta) = read_meta(&path) else {
                continue;
            };
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            let mtime = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs() as i64)
                .unwrap_or(0);

            symbols.entry(symbol).or_default().push(PeriodEntry {
                period: meta.period,
                label: period_label(meta.period),
                bars: meta.bar_count,
                first: meta.first_time,
                last: meta.last_time,
                digits: meta.digits,
                file: name,
                size: meta.size,
                mtime,
            });
        }
        if symbols.is_empty() {
            continue;
        }

        let mut symbol_entries = Vec::with_capacity(symbols.len());
        for (symbol, mut periods) in symbols {
            periods.sort_by_key(|period| period.period);
            symbol_entries.push(SymbolEntry { symbol, periods });
        }

        let id = file_name(&server_dir);
        servers.push(ServerEntry {
            label: server_label(&id),
            id,
            symbols: symbol_entries,
        });
    }

    // 有 XAUUSD 的账户排前面; 同等情况优先实盘
    let has_gold = |server: &ServerEntry| {
        server
            .symbols
            .iter()
            .any(|symbol| symbol.symbol.starts_with("XAUUSD"))
    };
    servers.sort_by(|left, right| {
        let left_gold = !has_gold(left);
        let right_gold = !has_gold(right);
        let left_live = !left.id.to_lowercase().contains("live");
        let right_live = !right.id.to_lowercase().contains("live");
        left_gold
            .cmp(&right_gold)
            .then(left_live.cmp(&right_live))
            .then_with(|| left.id.cmp(&right.id))
    });

    Catalog {
        history_root: display_root,
        found: true,
        servers,
    }
}

/// 只允许单一路径组件；拒绝 `/`、`\`、NUL、控制字符、`.`/`..` 以及盘符/绝对路径。
pub fn valid_component(value: &str) -> bool {
    if value.is_empty() || value == "." || value == ".." {
        return false;
    }
    if value.chars().any(|character| {
        character == '/' || character == '\\' || character == '\0' || character.is_control()
    }) {
        return false;
    }
    let mut components = Path::new(value).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

/// 精确文件名优先，其次大小写不敏感扫描。
///
/// 只允许单一路径组件，所以查询参数无法穿越；账户目录或 `.hst` 本身是软链接时按用户配置
/// 跟随，与旧 Python 行为一致（Wine / 外部 MT4 目录常通过软链接挂进来）。
pub fn find_hst(history_root: &Path, server: &str, symbol: &str, period: i64) -> Option<PathBuf> {
    if !valid_component(server) || !valid_component(symbol) {
        return None;
    }

    let base = history_root.join(server);
    if !base.is_dir() {
        return None;
    }

    let candidate = base.join(format!("{symbol}{period}.hst"));
    if candidate.is_file() && candidate.parent() == Some(base.as_path()) {
        return Some(candidate);
    }

    let wanted_symbol = symbol.to_lowercase();
    let entries = fs::read_dir(&base).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.parent() != Some(base.as_path()) || !path.is_file() || !is_hst(&path) {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some((file_symbol, file_period)) = parse_filename(name) else {
            continue;
        };
        if file_period as i64 == period && file_symbol.to_lowercase() == wanted_symbol {
            return Some(path);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hst::HEADER_SIZE;

    fn write_stub_hst(
        dir: &Path,
        name: &str,
        symbol: &str,
        period: i32,
        digits: i32,
        mtime_placeholder: u64,
    ) {
        let _ = mtime_placeholder;
        let path = dir.join(name);
        let mut bytes = vec![0u8; HEADER_SIZE as usize];
        bytes[0..4].copy_from_slice(&401i32.to_le_bytes());
        let symbol_bytes = symbol.as_bytes();
        let symbol_len = symbol_bytes.len().min(12);
        bytes[68..68 + symbol_len].copy_from_slice(&symbol_bytes[..symbol_len]);
        bytes[80..84].copy_from_slice(&period.to_le_bytes());
        bytes[84..88].copy_from_slice(&digits.to_le_bytes());
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn builds_catalog_with_python_sorting_and_labels() {
        let root = tempfile::tempdir().unwrap();
        for server in [
            "TradeMaxGlobal-Demo-2",
            "TradeMaxGlobal-Live14",
            "default",
            "AAA",
        ] {
            std::fs::create_dir_all(root.path().join(server)).unwrap();
        }
        write_stub_hst(
            &root.path().join("TradeMaxGlobal-Live14"),
            "XAUUSD5.hst",
            "XAUUSD",
            5,
            2,
            0,
        );
        write_stub_hst(
            &root.path().join("TradeMaxGlobal-Live14"),
            "EURUSD240.hst",
            "EURUSD",
            240,
            5,
            0,
        );
        write_stub_hst(
            &root.path().join("TradeMaxGlobal-Demo-2"),
            "XAUUSD1.hst",
            "XAUUSD",
            1,
            2,
            0,
        );
        write_stub_hst(
            &root.path().join("default"),
            "EURUSD240.hst",
            "EURUSD",
            240,
            5,
            0,
        );

        let catalog = build_catalog(root.path());
        assert!(catalog.found);
        assert_eq!(
            catalog
                .servers
                .iter()
                .map(|server| server.id.as_str())
                .collect::<Vec<_>>(),
            vec!["TradeMaxGlobal-Live14", "TradeMaxGlobal-Demo-2", "default"]
        );
        assert_eq!(catalog.servers[0].label, "Live14");
        assert_eq!(catalog.servers[1].label, "Demo 2");
        let live = &catalog.servers[0];
        assert_eq!(live.symbols[0].symbol, "EURUSD");
        assert_eq!(live.symbols[1].symbol, "XAUUSD");
        assert_eq!(live.symbols[1].periods[0].label, "M5");
        assert_eq!(live.symbols[1].periods[0].digits, 2);
    }

    #[test]
    fn missing_root_reports_not_found() {
        let missing = tempfile::tempdir().unwrap().path().join("nope");
        let catalog = build_catalog(&missing);
        assert!(!catalog.found);
        assert!(catalog.servers.is_empty());
    }

    #[test]
    fn finds_files_case_insensitively_and_blocks_traversal() {
        let root = tempfile::tempdir().unwrap();
        let server = root.path().join("TradeMaxGlobal-Live14");
        std::fs::create_dir_all(&server).unwrap();
        write_stub_hst(&server, "XAUUSD5.hst", "XAUUSD", 5, 2, 0);

        assert!(find_hst(root.path(), "TradeMaxGlobal-Live14", "XAUUSD", 5).is_some());
        assert!(find_hst(root.path(), "TradeMaxGlobal-Live14", "xauusd", 5).is_some());
        assert!(find_hst(root.path(), "..", "XAUUSD", 5).is_none());
        assert!(find_hst(root.path(), "TradeMaxGlobal-Live14", "../XAUUSD", 5).is_none());
        assert!(find_hst(root.path(), "TradeMaxGlobal-Live14", "XAUUSD", 15).is_none());
    }

    #[test]
    fn valid_component_rules() {
        assert!(valid_component("TradeMaxGlobal-Live14"));
        assert!(valid_component("JD.NAS"));
        assert!(!valid_component(""));
        assert!(!valid_component("."));
        assert!(!valid_component(".."));
        assert!(!valid_component("a/b"));
        assert!(!valid_component("a\\b"));
        assert!(!valid_component("a\nb"));
        assert!(!valid_component("/etc"));
        assert!(!valid_component("C:\\Windows"));
        assert!(!valid_component("a/../b"));
    }

    #[cfg(unix)]
    #[test]
    fn follows_symlinked_account_and_file() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        write_stub_hst(external.path(), "XAUUSD5.hst", "XAUUSD", 5, 2, 0);

        // 账户目录本身是软链接
        symlink(external.path(), root.path().join("LinkedAccount")).unwrap();
        assert!(find_hst(root.path(), "LinkedAccount", "XAUUSD", 5).is_some());
        let catalog = build_catalog(root.path());
        assert!(catalog
            .servers
            .iter()
            .any(|server| server.id == "LinkedAccount"));

        // 账户目录下的单个 .hst 是指向外部文件的软链接
        let server = root.path().join("Srv");
        std::fs::create_dir_all(&server).unwrap();
        write_stub_hst(external.path(), "EURUSD240.hst", "EURUSD", 240, 5, 0);
        symlink(
            external.path().join("EURUSD240.hst"),
            server.join("EURUSD240.hst"),
        )
        .unwrap();
        assert!(find_hst(root.path(), "Srv", "EURUSD", 240).is_some());
    }
}
