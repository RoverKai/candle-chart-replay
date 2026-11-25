"""本地 K 线复盘服务器.

  GET /api/catalog                     账户 / 品种 / 周期一览
  GET /api/bars?server=&symbol=&period= K 线数据 (JSON)
  GET /api/refresh                     清空解析缓存
  其余路径                              web/ 下的静态文件

启动:  python server/app.py [--port 8766] [--open]
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hst  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
BUNDLED_HISTORY = ROOT / "data" / "history"
DEFAULT_HISTORY = r"C:\Program Files (x86)\MetaTrader 4\history"


def resolve_history_dir() -> Path:
    """数据目录优先级: MT4_HISTORY 环境变量 > 本机 MT4 > 仓库自带样例数据"""
    env = os.environ.get("MT4_HISTORY")
    if env:
        return Path(env)
    mt4 = Path(DEFAULT_HISTORY)
    if mt4.is_dir():
        return mt4
    if BUNDLED_HISTORY.is_dir():
        return BUNDLED_HISTORY
    return mt4


HISTORY_DIR = resolve_history_dir()

PERIOD_LABEL = {
    1: "M1", 5: "M5", 15: "M15", 30: "M30", 60: "H1",
    240: "H4", 1440: "D1", 10080: "W1", 43200: "MN",
}


def _label_for_dir(name: str) -> str:
    """TradeMaxGlobal-Live14 -> Live14 ; Demo-2 -> Demo 2"""
    for prefix in ("TradeMaxGlobal-", "TradeMax-", "MetaQuotes-"):
        if name.startswith(prefix):
            name = name[len(prefix):]
    return name.replace("-", " ")


def build_catalog() -> dict:
    servers = []
    if not HISTORY_DIR.is_dir():
        return {"historyRoot": str(HISTORY_DIR), "found": False, "servers": []}

    for entry in sorted(HISTORY_DIR.iterdir(), key=lambda p: p.name.lower()):
        if not entry.is_dir():
            continue
        files = sorted(entry.glob("*.hst"))
        if not files:
            continue
        symbols: dict[str, list[dict]] = {}
        for path in files:
            parsed = hst.parse_filename(path.name)
            if not parsed:
                continue
            symbol, period = parsed
            try:
                meta = hst.read_meta(str(path))
            except OSError:
                continue
            symbols.setdefault(symbol, []).append({
                "period": period,
                "label": PERIOD_LABEL.get(period, f"M{period}"),
                "bars": meta.bar_count,
                "first": meta.first_time,
                "last": meta.last_time,
                "digits": meta.digits,
                "file": path.name,
                "size": meta.size,
                "mtime": int(os.path.getmtime(path)),
            })
        if not symbols:
            continue
        sym_list = []
        for symbol, periods in sorted(symbols.items()):
            periods.sort(key=lambda p: p["period"])
            sym_list.append({"symbol": symbol, "periods": periods})
        servers.append({
            "id": entry.name,
            "label": _label_for_dir(entry.name),
            "symbols": sym_list,
        })

    # 有 XAUUSD 的账户排前面; 同等情况优先实盘
    servers.sort(key=lambda s: (
        0 if any(x["symbol"].startswith("XAUUSD") for x in s["symbols"]) else 1,
        0 if "live" in s["id"].lower() else 1,
        s["id"],
    ))
    return {"historyRoot": str(HISTORY_DIR), "found": True, "servers": servers}


def find_hst(server: str, symbol: str, period: int) -> Path | None:
    base = HISTORY_DIR / server
    if not base.is_dir():
        return None
    candidate = base / f"{symbol}{period}.hst"
    if candidate.is_file():
        return candidate
    for path in base.glob("*.hst"):
        parsed = hst.parse_filename(path.name)
        if parsed and parsed[0].lower() == symbol.lower() and parsed[1] == period:
            return path
    return None


class QuietServer(ThreadingHTTPServer):
    """浏览器/健康检查常常突然断开连接, 不该在控制台刷 traceback."""

    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError)):
            return
        super().handle_error(request, client_address)


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    # ---------------------------------------------------------------- util
    def _send_payload(self, body: bytes, content_type: str, status: int = 200) -> None:
        accepts_gzip = "gzip" in (self.headers.get("Accept-Encoding") or "")
        if accepts_gzip and len(body) > 1400:
            body = gzip.compress(body, 6)
            encoding = "gzip"
        else:
            encoding = None
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send_payload(body, "application/json; charset=utf-8", status)

    def _error(self, message: str, status: int = 400) -> None:
        self._json({"error": message}, status)

    def log_message(self, fmt, *args):  # 安静一点, 只输出 API 命中
        if "/api/" in (self.path or ""):
            sys.stderr.write("  %s %s\n" % (self.command, self.path))

    # ---------------------------------------------------------------- routes
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/catalog":
            return self._json(build_catalog())
        if path == "/api/bars":
            return self._bars(parse_qs(parsed.query))
        if path == "/api/refresh":
            hst.store.invalidate()
            return self._json({"ok": True})
        if path == "/api/health":
            return self._json({"ok": True, "historyRoot": str(HISTORY_DIR)})
        if path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def _bars(self, query: dict):
        server = (query.get("server") or [""])[0]
        symbol = (query.get("symbol") or [""])[0]
        try:
            period = int((query.get("period") or ["0"])[0])
        except ValueError:
            return self._error("period 必须是整数")
        if not server or not symbol or not period:
            return self._error("缺少参数: server / symbol / period")

        path = find_hst(server, symbol, period)
        if path is None:
            return self._error(f"找不到数据文件: {server}/{symbol}{period}.hst", 404)

        try:
            meta = hst.read_meta(str(path))
            bars = hst.store.bars(str(path))
        except OSError as exc:
            return self._error(f"读取失败: {exc}", 500)

        digits = meta.digits
        rounded = [
            [t, round(o, digits), round(h, digits), round(l, digits), round(c, digits), int(v)]
            for (t, o, h, l, c, v) in bars
        ]
        self._json({
            "server": server,
            "symbol": symbol,
            "period": period,
            "label": PERIOD_LABEL.get(period, f"M{period}"),
            "digits": digits,
            "file": path.name,
            "count": len(rounded),
            "bars": rounded,
        })


def main() -> int:
    ap = argparse.ArgumentParser(description="本地 K 线复盘服务器")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8766)))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    args = ap.parse_args()

    if not WEB_DIR.is_dir():
        print(f"[x] 找不到前端目录: {WEB_DIR}")
        return 1
    if not HISTORY_DIR.is_dir():
        print(f"[!] 找不到 MT4 历史目录: {HISTORY_DIR}")
        print("    可用环境变量 MT4_HISTORY 指定 .hst 所在目录")

    port = args.port
    httpd = None
    for attempt in range(20):
        try:
            httpd = QuietServer((args.host, port), Handler)
            break
        except OSError:
            port += 1
    if httpd is None:
        print("[x] 没有可用端口")
        return 1

    url = f"http://{args.host}:{port}/"
    print("=" * 56)
    print("  本地 K 线复盘  (MT4 -> TradingView 风格图表)")
    print("=" * 56)
    print(f"  数据目录 : {HISTORY_DIR}" + ("  (仓库自带样例)" if HISTORY_DIR == BUNDLED_HISTORY else ""))
    print(f"  访问地址 : {url}")
    print("  停止服务 : Ctrl+C")
    print("=" * 56)

    if args.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
