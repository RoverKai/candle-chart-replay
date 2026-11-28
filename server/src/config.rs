//! 启动参数、目录解析与显示标签。
//!
//! 这里刻意不写死仓库路径：脚本会 `cd` 到仓库根目录，Docker 里工作目录是 `/app`，
//! 直接跑 `target/release/kline-replay` 时则要能从可执行文件位置向上找到 `web/`。

use std::path::{Path, PathBuf};

pub const DEFAULT_PORT: u16 = 8766;

/// MT4 支持的周期（分钟），从长到短，文件名歧义时优先匹配长周期。
pub const KNOWN_PERIODS: [i32; 9] = [43200, 10080, 1440, 240, 60, 30, 15, 5, 1];

pub const USAGE: &str = "用法: kline-replay [选项]

选项:
  --host <地址>        监听地址 (默认 127.0.0.1)
  --port <端口>        监听端口 (默认 8766；可用环境变量 PORT)
  --open               启动后自动打开浏览器
  --history <目录>     覆盖 MT4 .hst 数据目录
  --web-dir <目录>     覆盖前端静态目录
  --healthcheck <地址> 只做健康检查，例如 127.0.0.1:8766
  -h, --help           显示帮助
";

#[derive(Debug, Clone, Default)]
pub struct Cli {
    pub host: String,
    pub port: u16,
    pub open: bool,
    pub history: Option<PathBuf>,
    pub web_dir: Option<PathBuf>,
    pub healthcheck: Option<String>,
}

#[derive(Debug, Clone)]
pub enum Command {
    Run(Cli),
    Help,
}

/// 解析命令行。`--flag=value` 与 `--flag value` 都支持，方便脚本和手工调用。
pub fn parse_args(args: Vec<String>, env_port: Option<String>) -> Result<Command, String> {
    let mut host = String::from("127.0.0.1");
    let mut port = match env_port {
        Some(raw) => parse_port(&raw)?,
        None => DEFAULT_PORT,
    };
    let mut open = false;
    let mut history = None;
    let mut web_dir = None;
    let mut healthcheck = None;

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "-h" || arg == "--help" {
            return Ok(Command::Help);
        }
        if arg == "--open" {
            open = true;
            i += 1;
            continue;
        }

        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) => (flag, Some(value.to_string())),
            None => (arg.as_str(), None),
        };

        let mut value = |name: &str| -> Result<String, String> {
            if let Some(value) = inline.clone() {
                if value.is_empty() {
                    return Err(format!("{name} 缺少参数值"));
                }
                return Ok(value);
            }
            i += 1;
            match args.get(i) {
                Some(value) if !value.is_empty() => Ok(value.clone()),
                _ => Err(format!("{name} 缺少参数值")),
            }
        };

        match flag {
            "--host" => host = value("--host")?,
            "--port" => port = parse_port(&value("--port")?)?,
            "--history" => history = Some(PathBuf::from(value("--history")?)),
            "--web-dir" => web_dir = Some(PathBuf::from(value("--web-dir")?)),
            "--healthcheck" => healthcheck = Some(value("--healthcheck")?),
            other => return Err(format!("未知参数: {other}")),
        }
        i += 1;
    }

    Ok(Command::Run(Cli {
        host,
        port,
        open,
        history,
        web_dir,
        healthcheck,
    }))
}

fn parse_port(raw: &str) -> Result<u16, String> {
    let trimmed = raw.trim();
    match trimmed.parse::<u16>() {
        Ok(port) if port > 0 => Ok(port),
        _ => Err(format!("端口无效: {raw}")),
    }
}

/// 依次尝试：工作目录、可执行文件目录、以及向上 3 层（覆盖 target/release）。
pub fn root_candidates(cwd: PathBuf, exe: Option<PathBuf>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if !cwd.as_os_str().is_empty() {
        roots.push(cwd);
    }
    if let Some(exe) = exe {
        let mut dir = exe.parent().map(Path::to_path_buf);
        for _ in 0..4 {
            match dir {
                Some(path) => {
                    dir = path.parent().map(Path::to_path_buf);
                    roots.push(path);
                }
                None => break,
            }
        }
    }

    let mut unique = Vec::new();
    for root in roots {
        if !unique.iter().any(|existing: &PathBuf| existing == &root) {
            unique.push(root);
        }
    }
    unique
}

pub fn bundled_history(candidates: &[PathBuf]) -> PathBuf {
    candidates
        .iter()
        .map(|root| root.join("data").join("history"))
        .find(|path| path.is_dir())
        .or_else(|| {
            candidates
                .first()
                .map(|root| root.join("data").join("history"))
        })
        .unwrap_or_else(|| PathBuf::from("data").join("history"))
}

pub fn resolve_web_dir(
    explicit: Option<&Path>,
    env_web: Option<&str>,
    candidates: &[PathBuf],
) -> PathBuf {
    if let Some(path) = explicit {
        return path.to_path_buf();
    }
    if let Some(raw) = env_web {
        if !raw.is_empty() {
            return PathBuf::from(raw);
        }
    }
    candidates
        .iter()
        .map(|root| root.join("web"))
        .find(|path| path.is_dir())
        .or_else(|| candidates.first().map(|root| root.join("web")))
        .unwrap_or_else(|| PathBuf::from("web"))
}

pub fn resolve_history_dir(
    explicit: Option<&Path>,
    env_mt4: Option<&str>,
    candidates: &[PathBuf],
    platform_default: &Path,
) -> (PathBuf, PathBuf) {
    let bundled = bundled_history(candidates);
    let chosen = if let Some(path) = explicit {
        path.to_path_buf()
    } else if let Some(raw) = env_mt4 {
        if raw.is_empty() {
            fallback_history(platform_default, &bundled)
        } else {
            PathBuf::from(raw)
        }
    } else {
        fallback_history(platform_default, &bundled)
    };
    (chosen, bundled)
}

fn fallback_history(platform_default: &Path, bundled: &Path) -> PathBuf {
    if platform_default.is_dir() {
        platform_default.to_path_buf()
    } else if bundled.is_dir() {
        bundled.to_path_buf()
    } else {
        platform_default.to_path_buf()
    }
}

/// Python 侧默认的 Windows MT4 路径；在 Linux/macOS 上通常不存在，仅作为兜底值和提示。
pub fn platform_default_history() -> PathBuf {
    PathBuf::from(r"C:\Program Files (x86)\MetaTrader 4\history")
}

pub fn period_label(period: i32) -> String {
    match period {
        1 => "M1".into(),
        5 => "M5".into(),
        15 => "M15".into(),
        30 => "M30".into(),
        60 => "H1".into(),
        240 => "H4".into(),
        1440 => "D1".into(),
        10080 => "W1".into(),
        43200 => "MN".into(),
        other => format!("M{other}"),
    }
}

/// TradeMaxGlobal-Live14 -> Live14 ; Demo-2 -> Demo 2
pub fn server_label(name: &str) -> String {
    let mut result = name.to_string();
    for prefix in ["TradeMaxGlobal-", "TradeMax-", "MetaQuotes-"] {
        if let Some(rest) = result.strip_prefix(prefix) {
            result = rest.to_string();
        }
    }
    result.replace('-', " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn parses_flags_and_equals_forms() {
        let parsed = parse_args(
            args(&[
                "--host=0.0.0.0",
                "--port",
                "9000",
                "--open",
                "--history",
                "/tmp/h",
                "--web-dir=/tmp/w",
            ]),
            None,
        )
        .unwrap();
        let Command::Run(cli) = parsed else {
            panic!("expected run")
        };
        assert_eq!(cli.host, "0.0.0.0");
        assert_eq!(cli.port, 9000);
        assert!(cli.open);
        assert_eq!(cli.history.unwrap(), PathBuf::from("/tmp/h"));
        assert_eq!(cli.web_dir.unwrap(), PathBuf::from("/tmp/w"));
    }

    #[test]
    fn env_port_is_default_and_help_wins() {
        let parsed = parse_args(Vec::new(), Some("8899".into())).unwrap();
        let Command::Run(cli) = parsed else {
            panic!("expected run")
        };
        assert_eq!(cli.port, 8899);
        assert_eq!(cli.host, "127.0.0.1");

        assert!(matches!(
            parse_args(args(&["--port", "9000", "--help"]), None).unwrap(),
            Command::Help
        ));
    }

    #[test]
    fn rejects_bad_values() {
        assert!(parse_args(args(&["--port", "0"]), None).is_err());
        assert!(parse_args(args(&["--port", "70000"]), None).is_err());
        assert!(parse_args(args(&["--port"]), None).is_err());
        assert!(parse_args(args(&["--nope"]), None).is_err());
        assert!(parse_args(Vec::new(), Some("abc".into())).is_err());
    }

    #[test]
    fn labels_match_python() {
        assert_eq!(period_label(1), "M1");
        assert_eq!(period_label(60), "H1");
        assert_eq!(period_label(7), "M7");
        assert_eq!(server_label("TradeMaxGlobal-Live14"), "Live14");
        assert_eq!(server_label("TradeMax-Demo-2"), "Demo 2");
        assert_eq!(server_label("MetaQuotes-Demo"), "Demo");
        assert_eq!(server_label("default"), "default");
    }

    #[test]
    fn history_priority_and_bundled_detection() {
        let root = tempfile::tempdir().unwrap();
        let candidates = vec![root.path().to_path_buf()];
        let platform = root.path().join("mt4");
        assert_eq!(
            resolve_history_dir(None, None, &candidates, &platform).0,
            platform
        );

        let bundled = root.path().join("data").join("history");
        std::fs::create_dir_all(&bundled).unwrap();
        let (chosen, bundled_path) = resolve_history_dir(None, None, &candidates, &platform);
        assert_eq!(chosen, bundled);
        assert_eq!(bundled_path, bundled);

        let explicit = root.path().join("explicit");
        assert_eq!(
            resolve_history_dir(Some(&explicit), Some("/env"), &candidates, &platform).0,
            explicit
        );
    }

    #[test]
    fn roots_include_exe_ancestors() {
        let roots = root_candidates(
            PathBuf::from("/repo"),
            Some(PathBuf::from("/repo/server/target/release/kline-replay")),
        );
        assert_eq!(roots[0], PathBuf::from("/repo"));
        assert!(roots.contains(&PathBuf::from("/repo/server/target/release")));
        assert!(roots.contains(&PathBuf::from("/repo")));
        assert_eq!(
            roots
                .iter()
                .filter(|p| *p == &PathBuf::from("/repo"))
                .count(),
            1
        );
    }
}
