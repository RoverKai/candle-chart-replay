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
  PYTHON_BIN          指定 Python 解释器；不设则自动寻找 python3 / python
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

# 控制台按 UTF-8 输出，避免中文乱码
export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1

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

# app.py 在端口被占用时会自动向后换端口；这里提前拦住，避免提示的 URL 和实际不符
if port_busy "$PORT"; then
  printf '\n'
  printf '  [x] 端口 %s 已被其他程序占用\n' "$PORT"
  printf '      换一个端口重试: ./scripts/start.sh --port 9000\n'
  exit 1
fi

# ---------------------------------------------------------------- 找 Python
candidates=()
add_candidate() {
  local exe=$1 c
  [[ -n $exe && -x $exe ]] || return 0
  for c in ${candidates[@]+"${candidates[@]}"}; do
    [[ $c == "$exe" ]] && return 0
  done
  candidates+=("$exe")
}

if [[ -n ${PYTHON_BIN:-} ]]; then
  add_candidate "$PYTHON_BIN"
fi
for name in python3 python; do
  path=$(command -v "$name" 2>/dev/null || true)
  [[ -n $path ]] && add_candidate "$path"
done
for path in \
  /usr/bin/python3 \
  /usr/local/bin/python3 \
  "$HOME/.local/bin/python3" \
  "$HOME/anaconda3/bin/python3" \
  "$HOME/miniconda3/bin/python3" \
  /opt/conda/bin/python3; do
  add_candidate "$path"
done

PYTHON=""
PY_VERSION=""
rejected=()

for exe in ${candidates[@]+"${candidates[@]}"}; do
  # 跳过 WSL 里指向 Windows 应用商店占位程序的 python
  resolved=$(readlink -f -- "$exe" 2>/dev/null || printf '%s' "$exe")
  case "$resolved" in
    */WindowsApps/*)
      rejected+=("$exe  (Windows 应用商店占位程序)")
      continue
      ;;
  esac

  if ! version=$("$exe" -c 'import sys; print(sys.version.split()[0])' 2>/dev/null); then
    rejected+=("$exe  (无法运行)")
    continue
  fi
  if "$exe" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
    PYTHON=$exe
    PY_VERSION=$version
    break
  fi
  rejected+=("$exe  (Python $version，需要 3.9+)")
done

if [[ -z $PYTHON ]]; then
  printf '\n'
  printf '  [x] 没有找到可用的 Python 3.9+\n'
  if ((${#rejected[@]})); then
    printf '      已排除:\n'
    printf '        - %s\n' "${rejected[@]}"
  fi
  printf '\n'
  printf '  解决办法:\n'
  printf '    1) 安装 Python 3.9+（Debian/Ubuntu: sudo apt install python3）\n'
  printf '    2) 或指定解释器: PYTHON_BIN=/path/to/python3 ./scripts/start.sh\n'
  printf '\n'
  exit 1
fi

if [[ -n ${MT4_HISTORY:-} ]]; then
  HISTORY_LABEL=$MT4_HISTORY
elif [[ -d "$ROOT_DIR/data/history" ]]; then
  HISTORY_LABEL="$ROOT_DIR/data/history  (仓库自带样例)"
else
  HISTORY_LABEL='C:\Program Files (x86)\MetaTrader 4\history'
fi

printf '\n'
printf '  Python : %s   %s\n' "$PY_VERSION" "$PYTHON"
printf '  数据   : %s\n' "$HISTORY_LABEL"
printf '  访问   : http://127.0.0.1:%s/\n' "$PORT"
printf '  停止   : Ctrl+C\n'
printf '\n'

# ---------------------------------------------------------------- 启动
py_args=("$ROOT_DIR/server/app.py" --port "$PORT")
if (( OPEN )); then
  py_args+=(--open)
fi

exec "$PYTHON" "${py_args[@]}"
