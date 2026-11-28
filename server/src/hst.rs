//! MetaTrader 4 `.hst` 解析器。
//!
//! 结构与原 Python 版本保持一致：
//!
//! - 148 字节文件头（version / symbol / period / digits）
//! - 60 字节/条（build 600+）：`i32 time, 4x pad, 4x f64 OHLC, i32 volume, 16x pad`
//! - 44 字节/条（旧版）：`i32 time, 4x f64 OHLC, i64 volume`
//!
//! 清洗规则也与旧版一致：过滤 `time <= 0`、去重并保证时间严格递增、
//! 前 200 根里 high/low 大量反写时整体交换。

use serde::ser::{Serialize, SerializeSeq, SerializeTuple, Serializer};
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::config::KNOWN_PERIODS;

pub const HEADER_SIZE: u64 = 148;
pub const RECORD_SIZE: u64 = 60;
pub const LEGACY_RECORD_SIZE: u64 = 44;

#[derive(Debug, Clone, PartialEq)]
pub struct HstMeta {
    pub path: PathBuf,
    pub version: i32,
    pub symbol: String,
    pub period: i32,
    pub digits: i32,
    pub bar_count: u64,
    pub first_time: i64,
    pub last_time: i64,
    pub size: u64,
    pub record_size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bar {
    pub time: i32,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: i64,
}

/// `/api/bars` 里的单根 K 线序列化成 `[time, open, high, low, close, volume]`。
pub struct RoundedBar {
    bar: Bar,
    digits: i32,
}

impl Serialize for RoundedBar {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut tuple = serializer.serialize_tuple(6)?;
        tuple.serialize_element(&self.bar.time)?;
        tuple.serialize_element(&round_price(self.bar.open, self.digits))?;
        tuple.serialize_element(&round_price(self.bar.high, self.digits))?;
        tuple.serialize_element(&round_price(self.bar.low, self.digits))?;
        tuple.serialize_element(&round_price(self.bar.close, self.digits))?;
        tuple.serialize_element(&self.bar.volume)?;
        tuple.end()
    }
}

pub struct RoundedBars<'a> {
    bars: &'a [Bar],
    digits: i32,
}

impl<'a> RoundedBars<'a> {
    pub fn new(bars: &'a [Bar], digits: i32) -> Self {
        Self { bars, digits }
    }
}

impl Serialize for RoundedBars<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut seq = serializer.serialize_seq(Some(self.bars.len()))?;
        for bar in self.bars {
            seq.serialize_element(&RoundedBar {
                bar: *bar,
                digits: self.digits,
            })?;
        }
        seq.end()
    }
}

/// 按显示位数取整，语义对齐 Python `round(value, digits)`。
///
/// 绝大多数 MT4 价格本身就只有 `digits` 位小数，此时 `round` 是空操作；
/// 先用定点缩放做快速判断，只有确实需要舍入的极少数值才走 `format!`，
/// 避免 11 万根 K 线 × 4 个价格全部格式化带来的冷路径开销。
pub fn round_price(value: f64, digits: i32) -> f64 {
    if !value.is_finite() {
        return value;
    }
    let digits = digits.clamp(0, 8);
    if digits == 0 {
        return value.round_ties_even();
    }
    let factor = 10f64.powi(digits);
    let scaled = value * factor;
    if !scaled.is_finite() {
        return value;
    }
    let nearest = scaled.round_ties_even();
    let tolerance = scaled.abs() * 1e-12 + 1e-9;
    if (scaled - nearest).abs() <= tolerance {
        return value;
    }
    // 需要真正舍入：按十进制格式（ties-to-even）再解析回 f64，
    // 与 Python round + json.dumps 的最短表示保持一致。
    let precision = digits as usize;
    let text = format!("{value:.precision$}");
    text.parse::<f64>().unwrap_or(nearest / factor)
}

/// `XAUUSD5.hst` -> (`XAUUSD`, 5)。先拆出完整 body，再按已知周期从长到短匹配，
/// 避免 `NAS1001` 被切成 (`NAS`, 1001)。
pub fn parse_filename(name: &str) -> Option<(String, i32)> {
    if name.len() < 5 || !name.to_ascii_lowercase().ends_with(".hst") {
        return None;
    }
    let stem = &name[..name.len() - 4];
    if stem.len() < 2 || !stem.as_bytes().last().is_some_and(u8::is_ascii_digit) {
        return None;
    }
    for period in KNOWN_PERIODS {
        let suffix = period.to_string();
        if stem.len() > suffix.len() && stem.ends_with(&suffix) {
            return Some((stem[..stem.len() - suffix.len()].to_string(), period));
        }
    }
    None
}

pub fn detect_record_size(size: u64) -> u64 {
    let payload = size.saturating_sub(HEADER_SIZE);
    if payload == 0 {
        return RECORD_SIZE;
    }
    if payload.is_multiple_of(RECORD_SIZE) {
        RECORD_SIZE
    } else if payload.is_multiple_of(LEGACY_RECORD_SIZE) {
        LEGACY_RECORD_SIZE
    } else {
        RECORD_SIZE
    }
}

fn decode_symbol(bytes: &[u8]) -> String {
    let text: String = bytes
        .iter()
        .copied()
        .filter(|byte| *byte < 0x80)
        .map(char::from)
        .collect();
    text.trim_matches('\0').to_string()
}

pub fn read_meta(path: &Path) -> io::Result<HstMeta> {
    let metadata = fs::metadata(path)?;
    let size = metadata.len();

    let mut file = File::open(path)?;
    let mut head = Vec::with_capacity(HEADER_SIZE as usize);
    file.by_ref().take(HEADER_SIZE).read_to_end(&mut head)?;

    let version = if head.len() >= 4 {
        i32::from_le_bytes(head[0..4].try_into().unwrap())
    } else {
        0
    };
    let mut symbol = if head.len() >= 80 {
        decode_symbol(&head[68..80])
    } else {
        String::new()
    };
    let mut period = if head.len() >= 84 {
        i32::from_le_bytes(head[80..84].try_into().unwrap())
    } else {
        0
    };
    let mut digits = if head.len() >= 88 {
        i32::from_le_bytes(head[84..88].try_into().unwrap())
    } else {
        2
    };
    if !(0..=8).contains(&digits) {
        digits = 2;
    }

    let record_size = detect_record_size(size);
    let bar_count = size.saturating_sub(HEADER_SIZE) / record_size;

    // 与旧 Python 实现保持一致：目录页展示的 first/last 取原始首/末记录，bar_count 也是
    // 原始记录数；time<=0 过滤与去重只发生在 read_bars（K 线接口）。
    let (first_time, last_time) = if bar_count > 0 {
        let mut buffer = [0u8; 4];
        file.seek(SeekFrom::Start(HEADER_SIZE))?;
        file.read_exact(&mut buffer)?;
        let first = i32::from_le_bytes(buffer) as i64;

        file.seek(SeekFrom::Start(HEADER_SIZE + (bar_count - 1) * record_size))?;
        file.read_exact(&mut buffer)?;
        let last = i32::from_le_bytes(buffer) as i64;
        (first, last)
    } else {
        (0, 0)
    };

    let parsed = parse_filename(
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default(),
    );
    if symbol.is_empty() {
        if let Some((name, _)) = &parsed {
            symbol = name.clone();
        }
    }
    if !KNOWN_PERIODS.contains(&period) {
        if let Some((_, parsed_period)) = &parsed {
            period = *parsed_period;
        }
    }

    Ok(HstMeta {
        path: path.to_path_buf(),
        version,
        symbol,
        period,
        digits,
        bar_count,
        first_time,
        last_time,
        size,
        record_size,
    })
}

fn decode_60(data: &[u8], base: usize) -> Bar {
    let field = |offset: usize| -> f64 {
        f64::from_le_bytes(data[base + offset..base + offset + 8].try_into().unwrap())
    };
    Bar {
        time: i32::from_le_bytes(data[base..base + 4].try_into().unwrap()),
        open: field(8),
        high: field(16),
        low: field(24),
        close: field(32),
        volume: i32::from_le_bytes(data[base + 40..base + 44].try_into().unwrap()) as i64,
    }
}

fn decode_44(data: &[u8], base: usize) -> Bar {
    let field = |offset: usize| -> f64 {
        f64::from_le_bytes(data[base + offset..base + offset + 8].try_into().unwrap())
    };
    Bar {
        time: i32::from_le_bytes(data[base..base + 4].try_into().unwrap()),
        open: field(4),
        high: field(12),
        low: field(20),
        close: field(28),
        volume: i64::from_le_bytes(data[base + 36..base + 44].try_into().unwrap()),
    }
}

pub fn read_bars(path: &Path) -> io::Result<Vec<Bar>> {
    let data = fs::read(path)?;
    if data.len() <= HEADER_SIZE as usize {
        return Ok(Vec::new());
    }

    let record_size = detect_record_size(data.len() as u64) as usize;
    let count = (data.len() - HEADER_SIZE as usize) / record_size;
    let mut bars = Vec::with_capacity(count);
    for index in 0..count {
        let base = HEADER_SIZE as usize + index * record_size;
        let bar = if record_size == RECORD_SIZE as usize {
            decode_60(&data, base)
        } else {
            decode_44(&data, base)
        };
        if bar.time > 0
            && bar.open.is_finite()
            && bar.high.is_finite()
            && bar.low.is_finite()
            && bar.close.is_finite()
        {
            bars.push(bar);
        }
    }

    // 去重 + 保证时间严格递增 (MT4 偶尔会留下重复/回退的记录)
    if bars.len() > 1 {
        let mut clean = Vec::with_capacity(bars.len());
        for bar in bars {
            if clean.last().is_none_or(|last: &Bar| bar.time > last.time) {
                clean.push(bar);
            }
        }
        bars = clean;
    }

    // 有些品种的 hst 会把 high/low 写反, 用统计方式兜底纠正
    if bars.len() > 20 {
        let bad = bars
            .iter()
            .take(200)
            .filter(|bar| bar.high < bar.open.max(bar.close) || bar.low > bar.open.min(bar.close))
            .count();
        if bad > 100 {
            for bar in &mut bars {
                std::mem::swap(&mut bar.high, &mut bar.low);
            }
        }
    }

    Ok(bars)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[allow(clippy::too_many_arguments)]
    fn write_hst(
        dir: &Path,
        name: &str,
        version: i32,
        symbol: &str,
        period: i32,
        digits: i32,
        bars: &[(i32, f64, f64, f64, f64, i64)],
        legacy: bool,
    ) -> PathBuf {
        let path = dir.join(name);
        let mut bytes = vec![0u8; HEADER_SIZE as usize];
        bytes[0..4].copy_from_slice(&version.to_le_bytes());
        let symbol_bytes = symbol.as_bytes();
        let symbol_len = symbol_bytes.len().min(12);
        bytes[68..68 + symbol_len].copy_from_slice(&symbol_bytes[..symbol_len]);
        bytes[80..84].copy_from_slice(&period.to_le_bytes());
        bytes[84..88].copy_from_slice(&digits.to_le_bytes());
        for (time, open, high, low, close, volume) in bars {
            if legacy {
                let mut record = vec![0u8; LEGACY_RECORD_SIZE as usize];
                record[0..4].copy_from_slice(&time.to_le_bytes());
                record[4..12].copy_from_slice(&open.to_le_bytes());
                record[12..20].copy_from_slice(&high.to_le_bytes());
                record[20..28].copy_from_slice(&low.to_le_bytes());
                record[28..36].copy_from_slice(&close.to_le_bytes());
                record[36..44].copy_from_slice(&volume.to_le_bytes());
                bytes.extend_from_slice(&record);
            } else {
                let mut record = [0u8; RECORD_SIZE as usize];
                record[0..4].copy_from_slice(&time.to_le_bytes());
                record[8..16].copy_from_slice(&open.to_le_bytes());
                record[16..24].copy_from_slice(&high.to_le_bytes());
                record[24..32].copy_from_slice(&low.to_le_bytes());
                record[32..40].copy_from_slice(&close.to_le_bytes());
                record[40..44].copy_from_slice(&(*volume as i32).to_le_bytes());
                bytes.extend_from_slice(&record);
            }
        }
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn parses_ambiguous_filenames() {
        assert_eq!(parse_filename("XAUUSD5.hst"), Some(("XAUUSD".into(), 5)));
        assert_eq!(parse_filename("NAS1001.hst"), Some(("NAS100".into(), 1)));
        assert_eq!(
            parse_filename("JD.NAS1440.hst"),
            Some(("JD.NAS".into(), 1440))
        );
        assert_eq!(
            parse_filename("XAUUSD10080.HST"),
            Some(("XAUUSD".into(), 10080))
        );
        assert_eq!(parse_filename("XAUUSD.hst"), None);
        assert_eq!(parse_filename("5.hst"), None);
        assert_eq!(parse_filename("XAUUSD7.hst"), None);
        assert_eq!(parse_filename("noext"), None);
    }

    #[test]
    fn detects_record_sizes_like_python() {
        assert_eq!(detect_record_size(148), 60);
        assert_eq!(detect_record_size(148 + 60), 60);
        assert_eq!(detect_record_size(148 + 44), 44);
        // 1320 同时能被 60/44 整除，Python 优先 60
        assert_eq!(detect_record_size(148 + 1320), 60);
        assert_eq!(detect_record_size(148 + 1), 60);
    }

    #[test]
    fn reads_meta_and_falls_back_to_filename() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_hst(
            dir.path(),
            "XAUUSD5.hst",
            401,
            "",
            0,
            2,
            &[(100, 1.0, 2.0, 0.5, 1.5, 10), (160, 1.5, 2.5, 1.0, 2.0, 20)],
            false,
        );
        let meta = read_meta(&path).unwrap();
        assert_eq!(meta.version, 401);
        assert_eq!(meta.symbol, "XAUUSD");
        assert_eq!(meta.period, 5);
        assert_eq!(meta.digits, 2);
        assert_eq!(meta.bar_count, 2);
        assert_eq!(meta.first_time, 100);
        assert_eq!(meta.last_time, 160);
        assert_eq!(meta.record_size, 60);
    }

    #[test]
    fn meta_keeps_raw_bounds_and_count_like_python() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_hst(
            dir.path(),
            "XAUUSD5.hst",
            401,
            "XAUUSD",
            5,
            2,
            &[
                (0, 1.0, 2.0, 0.5, 1.5, 1),
                (100, 1.0, 2.0, 0.5, 1.5, 2),
                (90, 1.0, 2.0, 0.5, 1.5, 3),
                (160, 1.5, 2.5, 1.0, 2.0, 4),
            ],
            false,
        );
        // 旧 Python 的 read_meta 取原始首/末记录与原始条数，不做 time<=0/去重清洗；
        // 本测试锁定这一兼容行为，清洗只发生在 read_bars。
        let meta = read_meta(&path).unwrap();
        assert_eq!(meta.bar_count, 4);
        assert_eq!(meta.first_time, 0);
        assert_eq!(meta.last_time, 160);

        let bars = read_bars(&path).unwrap();
        assert_eq!(bars.len(), 2);
        assert_eq!(bars[0].time, 100);
        assert_eq!(bars[1].time, 160);
    }

    #[test]
    fn reads_and_cleans_bars() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_hst(
            dir.path(),
            "XAUUSD5.hst",
            401,
            "XAUUSD",
            5,
            2,
            &[
                (0, 1.0, 2.0, 0.5, 1.5, 1),
                (100, 1.0, 2.0, 0.5, 1.5, 2),
                (100, 9.0, 2.0, 0.5, 1.5, 3),
                (90, 1.0, 2.0, 0.5, 1.5, 4),
                (160, 1.5, 2.5, 1.0, 2.0, 5),
            ],
            false,
        );
        let bars = read_bars(&path).unwrap();
        assert_eq!(bars.len(), 2);
        assert_eq!(bars[0].time, 100);
        assert_eq!(bars[1].time, 160);
    }

    #[test]
    fn reads_legacy_records() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_hst(
            dir.path(),
            "EURUSD240.hst",
            400,
            "EURUSD",
            240,
            5,
            &[(100, 1.1, 1.2, 1.0, 1.15, 1234567890123)],
            true,
        );
        let bars = read_bars(&path).unwrap();
        assert_eq!(bars.len(), 1);
        assert_eq!(bars[0].volume, 1234567890123);
        assert_eq!(read_meta(&path).unwrap().record_size, 44);
    }

    #[test]
    fn swaps_reversed_high_low_only_above_threshold() {
        let dir = tempfile::tempdir().unwrap();
        let mut reversed = Vec::new();
        for index in 0..200 {
            let time = 1000 + index;
            reversed.push((time, 10.0, 9.0, 11.0, 10.5, 1));
        }
        let path = write_hst(
            dir.path(),
            "XAUUSD5.hst",
            401,
            "XAUUSD",
            5,
            2,
            &reversed,
            false,
        );
        let bars = read_bars(&path).unwrap();
        assert!(bars[0].high > bars[0].low);
        assert_eq!(bars[0].high, 11.0);
        assert_eq!(bars[0].low, 9.0);
    }

    #[test]
    fn rounding_matches_python_semantics() {
        assert_eq!(round_price(2.675, 2), 2.67);
        assert_eq!(round_price(1.005, 2), 1.0);
        assert_eq!(round_price(-1.005, 2), -1.0);
        assert_eq!(round_price(2.5, 0), 2.0);
        assert_eq!(round_price(4022.52, 2), 4022.52);
        assert_eq!(round_price(1.4311, 5), 1.4311);
        assert!(round_price(f64::NAN, 2).is_nan());
    }
}
