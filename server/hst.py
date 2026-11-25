"""MetaTrader 4 .hst 历史数据解析器.

MT4 build 600+ 的历史文件 (version 401) 使用 148 字节文件头,
之后是 60 字节/条的记录:

    offset  type        field
    0       int32       time      (服务器时间, unix 秒)
    4       int32       padding
    8       double      open
    16      double      high
    24      double      low
    32      double      close
    40      int32       volume    (tick volume)
    44      byte x16    padding

旧版 (version 400) 的记录是 44 字节且没有对齐填充, 这里做兼容探测.
"""

from __future__ import annotations

import os
import re
import struct
import threading
import time as _time
from dataclasses import dataclass

HEADER_SIZE = 148
RECORD_SIZE = 60
LEGACY_RECORD_SIZE = 44

# MT4 支持的周期 (分钟)
KNOWN_PERIODS = (43200, 10080, 1440, 240, 60, 30, 15, 5, 1)

_FNAME_RE = re.compile(r"^(?P<sym>.+?)(?P<per>\d+)\.hst$", re.IGNORECASE)


@dataclass(frozen=True)
class HstMeta:
    path: str
    version: int
    symbol: str
    period: int
    digits: int
    bar_count: int
    first_time: int
    last_time: int
    size: int
    record_size: int


def _detect_record_size(size: int) -> int:
    payload = size - HEADER_SIZE
    if payload <= 0:
        return RECORD_SIZE
    if payload % RECORD_SIZE == 0:
        return RECORD_SIZE
    if payload % LEGACY_RECORD_SIZE == 0:
        return LEGACY_RECORD_SIZE
    return RECORD_SIZE


def parse_filename(name: str) -> tuple[str, int] | None:
    """`XAUUSD5.hst` -> ('XAUUSD', 5). 周期按已知集合从长到短匹配, 避免
    `NAS1001` 被切成 ('NAS', 1001)."""
    m = _FNAME_RE.match(name)
    if not m:
        return None
    body = m.group("sym") + m.group("per")
    for period in KNOWN_PERIODS:
        suffix = str(period)
        if body.endswith(suffix) and len(body) > len(suffix):
            return body[: -len(suffix)], period
    return None


def read_meta(path: str) -> HstMeta:
    size = os.path.getsize(path)
    with open(path, "rb") as fh:
        head = fh.read(HEADER_SIZE)
    version = struct.unpack_from("<i", head, 0)[0] if len(head) >= 4 else 0
    symbol = head[68:80].decode("ascii", "ignore").strip("\x00") if len(head) >= 80 else ""
    period = struct.unpack_from("<i", head, 80)[0] if len(head) >= 84 else 0
    digits = struct.unpack_from("<i", head, 84)[0] if len(head) >= 88 else 2
    rec_size = _detect_record_size(size)
    count = max(0, (size - HEADER_SIZE) // rec_size)

    first_time = last_time = 0
    if count:
        with open(path, "rb") as fh:
            fh.seek(HEADER_SIZE)
            first_time = struct.unpack("<i", fh.read(4))[0]
            fh.seek(HEADER_SIZE + (count - 1) * rec_size)
            last_time = struct.unpack("<i", fh.read(4))[0]

    if not symbol:
        parsed = parse_filename(os.path.basename(path))
        symbol = parsed[0] if parsed else ""
    if period not in KNOWN_PERIODS:
        parsed = parse_filename(os.path.basename(path))
        if parsed:
            period = parsed[1]

    return HstMeta(
        path=path,
        version=version,
        symbol=symbol,
        period=period,
        digits=digits if 0 <= digits <= 8 else 2,
        bar_count=count,
        first_time=first_time,
        last_time=last_time,
        size=size,
        record_size=rec_size,
    )


def _decode(data: bytes, rec_size: int) -> list[tuple[int, float, float, float, float, int]]:
    bars: list[tuple[int, float, float, float, float, int]] = []
    count = (len(data) - HEADER_SIZE) // rec_size
    if rec_size == RECORD_SIZE:
        unpack = struct.Struct("<i4xddddixxxxxxxxxxxxxxxx").unpack_from
        for i in range(count):
            t, o, h, l, c, v = unpack(data, HEADER_SIZE + i * RECORD_SIZE)
            if t > 0:
                bars.append((t, o, h, l, c, v))
    else:  # legacy 44 字节: time, o, h, l, c, int64 volume
        unpack = struct.Struct("<iddddq").unpack_from
        for i in range(count):
            t, o, h, l, c, v = unpack(data, HEADER_SIZE + i * LEGACY_RECORD_SIZE)
            if t > 0:
                bars.append((t, o, h, l, c, v))
    return bars


def read_bars(path: str) -> list[tuple[int, float, float, float, float, int]]:
    with open(path, "rb") as fh:
        data = fh.read()
    if len(data) <= HEADER_SIZE:
        return []
    rec_size = _detect_record_size(len(data))
    bars = _decode(data, rec_size)

    # 去重 + 保证时间严格递增 (MT4 偶尔会留下重复/回退的记录)
    if bars:
        clean = [bars[0]]
        for bar in bars[1:]:
            if bar[0] > clean[-1][0]:
                clean.append(bar)
        bars = clean

    # 有些品种的 hst 会把 high/low 写反, 用统计方式兜底纠正
    if len(bars) > 20:
        bad = 0
        for _, o, h, l, c, _ in bars[:200]:
            if h < max(o, c) or l > min(o, c):
                bad += 1
        if bad > 100:
            bars = [(t, o, l, h, c, v) for (t, o, h, l, c, v) in bars]
    return bars


# ---------------------------------------------------------------- 缓存

class HstStore:
    """按 mtime 缓存已解析的数据, 避免每次请求都重读磁盘."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._bars: dict[str, tuple[float, list]] = {}

    def bars(self, path: str):
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            return []
        with self._lock:
            cached = self._bars.get(path)
            if cached and cached[0] == mtime:
                return cached[1]
        data = read_bars(path)
        with self._lock:
            self._bars[path] = (mtime, data)
        return data

    def invalidate(self, path: str | None = None) -> None:
        with self._lock:
            if path is None:
                self._bars.clear()
            else:
                self._bars.pop(path, None)


store = HstStore()
