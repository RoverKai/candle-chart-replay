use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use kline_replay::api::{self, AppState};
use kline_replay::config::{self, Cli, Command};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = match config::parse_args(args, std::env::var("PORT").ok()) {
        Ok(command) => command,
        Err(message) => {
            eprintln!("{message}\n\n{}", config::USAGE);
            return ExitCode::from(2);
        }
    };

    let cli = match command {
        Command::Help => {
            print!("{}", config::USAGE);
            return ExitCode::SUCCESS;
        }
        Command::Run(cli) => cli,
    };

    if let Some(address) = cli.healthcheck.as_deref() {
        return healthcheck(address);
    }

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("[x] 无法启动异步运行时: {error}");
            return ExitCode::FAILURE;
        }
    };

    match runtime.block_on(serve(cli)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

async fn serve(cli: Cli) -> Result<(), String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    let exe = std::env::current_exe().ok();
    let roots = config::root_candidates(cwd, exe);
    let env_mt4 = std::env::var("MT4_HISTORY").ok();
    let env_web = std::env::var("KLINE_WEB_DIR").ok();
    let platform_default = config::platform_default_history();

    let (history, bundled) = config::resolve_history_dir(
        cli.history.as_deref(),
        env_mt4.as_deref(),
        &roots,
        &platform_default,
    );
    let web_dir = config::resolve_web_dir(cli.web_dir.as_deref(), env_web.as_deref(), &roots);

    if !web_dir.is_dir() {
        return Err(format!("[x] 找不到前端目录: {}", web_dir.display()));
    }
    if !history.is_dir() {
        eprintln!("[!] 找不到 MT4 历史目录: {}", history.display());
        eprintln!("    可用环境变量 MT4_HISTORY 指定 .hst 所在目录");
    }

    let state = Arc::new(AppState::new(history.clone()));
    let app = api::router(state, web_dir);

    let mut port = cli.port;
    let mut listener = None;
    for _ in 0..20 {
        match tokio::net::TcpListener::bind((cli.host.as_str(), port)).await {
            Ok(bound) => {
                listener = Some(bound);
                break;
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::AddrInUse | std::io::ErrorKind::AddrNotAvailable
                ) =>
            {
                if port == u16::MAX {
                    break;
                }
                port += 1;
            }
            Err(error) => {
                return Err(format!("[x] 无法监听 {}:{}: {error}", cli.host, port));
            }
        }
    }
    let Some(listener) = listener else {
        return Err("[x] 没有可用端口".to_string());
    };

    let url = format!("http://{}:{}/", cli.host, port);
    let suffix = if history == bundled {
        "  (仓库自带样例)"
    } else {
        ""
    };
    println!("{}", "=".repeat(56));
    println!("  本地 K 线复盘  (MT4 -> TradingView 风格图表)");
    println!("{}", "=".repeat(56));
    println!("  数据目录 : {}{}", history.display(), suffix);
    println!("  访问地址 : {url}");
    println!("  停止服务 : Ctrl+C");
    println!("{}", "=".repeat(56));

    if cli.open {
        let open_url = format!("http://{}:{}/", browser_host(&cli.host), port);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(600)).await;
            open_browser(&open_url);
        });
    }

    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;

    match result {
        Ok(()) => {
            println!("\n已停止");
            Ok(())
        }
        Err(error) => Err(format!("[x] 服务异常退出: {error}")),
    }
}

fn browser_host(host: &str) -> &str {
    match host {
        "0.0.0.0" | "::" | "[::]" => "127.0.0.1",
        other => other,
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[cfg(target_os = "windows")]
fn open_browser(url: &str) {
    if std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .is_err()
    {
        eprintln!("  (未能自动打开浏览器，请手动打开 {url})");
    }
}

#[cfg(target_os = "macos")]
fn open_browser(url: &str) {
    if std::process::Command::new("open").arg(url).spawn().is_err() {
        eprintln!("  (未能自动打开浏览器，请手动打开 {url})");
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_browser(url: &str) {
    let candidates: [(&str, &[&str]); 4] = [
        ("xdg-open", &[]),
        ("gio", &["open"]),
        ("sensible-browser", &[]),
        ("x-www-browser", &[]),
    ];
    for (program, prefix) in candidates {
        let mut command = std::process::Command::new(program);
        command.args(prefix).arg(url);
        if command
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .is_ok()
        {
            return;
        }
    }
    eprintln!("  (未找到浏览器启动命令，请手动打开 {url})");
}

fn healthcheck(address: &str) -> ExitCode {
    let Ok(addresses) = address.to_socket_addrs() else {
        eprintln!("[x] 无法解析健康检查地址: {address}");
        return ExitCode::FAILURE;
    };
    let request =
        format!("GET /api/health HTTP/1.0\r\nHost: {address}\r\nConnection: close\r\n\r\n");
    for address in addresses {
        let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_secs(2)) else {
            continue;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        if stream.write_all(request.as_bytes()).is_err() {
            continue;
        }
        let mut response = [0u8; 128];
        let Ok(read) = stream.read(&mut response) else {
            continue;
        };
        let head = String::from_utf8_lossy(&response[..read]);
        if head
            .lines()
            .next()
            .is_some_and(|line| line.starts_with("HTTP/1.") && line.contains(" 200 "))
        {
            return ExitCode::SUCCESS;
        }
    }
    ExitCode::FAILURE
}
