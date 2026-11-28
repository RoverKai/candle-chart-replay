#!/usr/bin/env bash
#
# K线复盘 启动器 (Linux)
# 用法: ./scripts/start.sh [--port 8766] [--no-open]
#
set -euo pipefail

PORT=8766
OPEN=1

usage() {
  cat <<'EOF'
K线复盘 启动器

用法: ./scripts/start.sh [选项]

选项:
  -p, --port <端口>   监听端口 (默认 8766)
  -n, --no-open       只启动服务，不打开浏览器
  -h, --help          显示本帮助

环境变量:
  MT4_HISTORY         .hst 数据目录；不设则使用本机 MT4 或仓库自带样例数据
  KLINE_BIN           指定服务端二进制路径（跳过自动编译）
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port)
      [[ $# -ge 2 ]] || { echo "缺少端口参数" >&2; exit 2; }
      PORT=$2
      shift 2
      ;;
    --port=*)
      PORT=${1#*=}
      shift
      ;;
    -n|--no-open)
      OPEN=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! [[ $PORT =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "端口无效: $PORT" >&2
  exit 2
fi

SOURCE=${BASH_SOURCE[0]}
if command -v readlink >/dev/null 2>&1; then
  SOURCE=$(readlink -f -- "$SOURCE" 2>/dev/null || printf '%s' "$SOURCE")
fi
SCRIPT_DIR=$(cd -- "$(dirname -- "$SOURCE")" && pwd -P)
ROOT_DIR=$(dirname -- "$SCRIPT_DIR")

cd "$ROOT_DIR"

http_health() {
  local port=$1 fd line
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 2 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1
    return $?
  fi
  # 没有 curl 时，用 bash 的 /dev/tcp 发一个最小 HTTP/1.0 请求
  exec {fd}<>"/dev/tcp/127.0.0.1/$port" 2>/dev/null || return 1
  printf 'GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:%s\r\nConnection: close\r\n\r\n' "$port" >&"$fd"
  if ! IFS= read -r -t 2 line <&"$fd"; then
    exec {fd}>&-
    return 1
  fi
  exec {fd}>&-
  [[ $line == *" 200 "* ]]
}

port_busy() {
  local port=$1
  (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null
}

open_browser() {
  local url=$1 opener
  for opener in xdg-open gio sensible-browser x-www-browser; do
    if command -v "$opener" >/dev/null 2>&1; then
      if [[ $opener == gio ]]; then
        gio open "$url" >/dev/null 2>&1 &
      else
        "$opener" "$url" >/dev/null 2>&1 &
      fi
      return 0
    fi
  done
  echo "  (未找到浏览器启动命令，请手动打开 $url)"
}

printf '\n'
printf '  ==================================================\n'
printf '   K线复盘 · MT4  ->  TradingView 风格图表\n'
printf '  ==================================================\n'

# ---------------------------------------------------------------- 已经在跑
if http_health "$PORT"; then
  printf '\n'
  printf '  服务已经在运行: http://127.0.0.1:%s/\n' "$PORT"
  printf '  直接使用即可，不需要重复启动。\n'
  if (( OPEN )); then
    open_browser "http://127.0.0.1:$PORT/"
  fi
  exit 0
fi

# 先探测端口，避免提示的 URL 和实际监听不一致（服务端本身也不再静默换端口）
if port_busy "$PORT"; then
  printf '\n'
  printf '  [x] 端口 %s 已被其他程序占用\n' "$PORT"
  printf '      换一个端口重试: ./scripts/start.sh --port 9000\n'
  exit 1
fi

# ---------------------------------------------------------------- 找二进制 / 编译
BIN=${KLINE_BIN:-"$ROOT_DIR/server/target/release/kline-replay"}
NEED_BUILD=0

if [[ -n ${KLINE_BIN:-} ]]; then
  if [[ ! -x $BIN ]]; then
    printf '\n'
    printf '  [x] KLINE_BIN 指向的文件不存在或不可执行: %s\n' "$BIN"
    exit 1
  fi
elif [[ ! -x $BIN ]]; then
  NEED_BUILD=1
elif command -v cargo >/dev/null 2>&1; then
  # 源码比二进制新时自动重编，避免 git pull 后跑到旧逻辑
  if [[ -n $(find "$ROOT_DIR/server/src" "$ROOT_DIR/server/Cargo.toml" "$ROOT_DIR/server/Cargo.lock" \
      -newer "$BIN" -print -quit 2>/dev/null) ]]; then
    NEED_BUILD=1
  fi
fi

if (( NEED_BUILD )); then
  CARGO_BIN=$(command -v cargo || true)
  if [[ -z $CARGO_BIN ]]; then
    printf '\n'
    printf '  [x] 找不到服务端二进制: %s\n' "$BIN"
    printf '      需要先安装 Rust: https://rustup.rs\n'
    printf '      安装后重新运行本脚本，会自动编译。\n'
    exit 1
  fi
  printf '\n'
  printf '  正在编译 Rust 服务端（首次约 1-3 分钟，之后秒开）...\n'
  if ! "$CARGO_BIN" build --release --locked --manifest-path "$ROOT_DIR/server/Cargo.toml"; then
    printf '\n'
    printf '  [x] Rust 服务端编译失败\n'
    printf '      请检查 cargo 是否可用、网络能否访问 crates.io，或先手动执行:\n'
    printf '      cargo build --release --locked --manifest-path server/Cargo.toml\n'
    exit 1
  fi
fi

if [[ ! -x $BIN ]]; then
  printf '\n'
  printf '  [x] 没有找到可执行的服务端: %s\n' "$BIN"
  exit 1
fi

MT4_DEFAULT='C:\Program Files (x86)\MetaTrader 4\history'
if [[ -n ${MT4_HISTORY:-} ]]; then
  HISTORY_LABEL=$MT4_HISTORY
elif [[ -d "$MT4_DEFAULT" ]]; then
  HISTORY_LABEL=$MT4_DEFAULT
elif [[ -d "$ROOT_DIR/data/history" ]]; then
  HISTORY_LABEL="$ROOT_DIR/data/history  (仓库自带样例)"
else
  HISTORY_LABEL=$MT4_DEFAULT
fi

printf '\n'
printf '  服务端 : %s\n' "$BIN"
printf '  数据   : %s\n' "$HISTORY_LABEL"
printf '  访问   : http://127.0.0.1:%s/\n' "$PORT"
printf '  停止   : Ctrl+C\n'
printf '\n'

# ---------------------------------------------------------------- 启动
run_args=(--port "$PORT")
if (( OPEN )); then
  run_args+=(--open)
fi

exec "$BIN" "${run_args[@]}"
