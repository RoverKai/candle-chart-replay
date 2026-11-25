/* 指标计算 —— 输入 bars: [{time, open, high, low, close, volume}]
   统一返回与输入等长的数组, 无效位置为 null, 元素形如 {time, value}。 */
(function (global) {
  'use strict';

  function sma(bars, n) {
    const out = new Array(bars.length).fill(null);
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
      sum += bars[i].close;
      if (i >= n) sum -= bars[i - n].close;
      if (i >= n - 1) out[i] = { time: bars[i].time, value: sum / n };
    }
    return out;
  }

  function ema(bars, n) {
    const out = new Array(bars.length).fill(null);
    const k = 2 / (n + 1);
    let prev = null;
    for (let i = 0; i < bars.length; i++) {
      const c = bars[i].close;
      if (i === n - 1) {
        let sum = 0;
        for (let j = 0; j < n; j++) sum += bars[j].close;
        prev = sum / n;
      } else if (i >= n) {
        prev = c * k + prev * (1 - k);
      }
      if (i >= n - 1) out[i] = { time: bars[i].time, value: prev };
    }
    return out;
  }

  function boll(bars, n, k) {
    k = k || 2;
    const mid = sma(bars, n);
    const upper = new Array(bars.length).fill(null);
    const lower = new Array(bars.length).fill(null);
    for (let i = n - 1; i < bars.length; i++) {
      let sum = 0;
      const m = mid[i].value;
      for (let j = i - n + 1; j <= i; j++) {
        const d = bars[j].close - m;
        sum += d * d;
      }
      const sd = Math.sqrt(sum / n);
      upper[i] = { time: bars[i].time, value: m + k * sd };
      lower[i] = { time: bars[i].time, value: m - k * sd };
    }
    return { mid: mid, upper: upper, lower: lower };
  }

  function rsi(bars, n) {
    n = n || 14;
    const out = new Array(bars.length).fill(null);
    if (bars.length <= n) return out;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= n; i++) {
      const d = bars[i].close - bars[i - 1].close;
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= n;
    loss /= n;
    out[n] = { time: bars[n].time, value: loss === 0 ? 100 : 100 - 100 / (1 + gain / loss) };
    for (let i = n + 1; i < bars.length; i++) {
      const d = bars[i].close - bars[i - 1].close;
      const g = d > 0 ? d : 0;
      const l = d < 0 ? -d : 0;
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      out[i] = { time: bars[i].time, value: loss === 0 ? 100 : 100 - 100 / (1 + gain / loss) };
    }
    return out;
  }

  function emaSeries(values, n) {
    const k = 2 / (n + 1);
    const out = new Array(values.length).fill(null);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null) continue;
      prev = prev === null ? v : v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function macd(bars, fast, slow, signal) {
    fast = fast || 12;
    slow = slow || 26;
    signal = signal || 9;
    const ef = emaSeries(bars.map(function (b) { return b.close; }), fast);
    const es = emaSeries(bars.map(function (b) { return b.close; }), slow);
    const dif = bars.map(function (b, i) {
      return (ef[i] !== null && es[i] !== null) ? ef[i] - es[i] : null;
    });
    const dea = emaSeries(dif, signal);
    const macdLine = new Array(bars.length).fill(null);
    const sigLine = new Array(bars.length).fill(null);
    const hist = new Array(bars.length).fill(null);
    for (let i = 0; i < bars.length; i++) {
      if (dif[i] === null) continue;
      macdLine[i] = { time: bars[i].time, value: dif[i] };
      if (dea[i] !== null) {
        sigLine[i] = { time: bars[i].time, value: dea[i] };
        const h = (dif[i] - dea[i]) * 2;
        hist[i] = { time: bars[i].time, value: h, color: h >= 0 ? 'rgba(38,166,154,.55)' : 'rgba(239,83,80,.55)' };
      }
    }
    return { macd: macdLine, signal: sigLine, hist: hist };
  }

  global.Indicators = { sma: sma, ema: ema, boll: boll, rsi: rsi, macd: macd };
})(window);
