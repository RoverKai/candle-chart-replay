/* 主应用: 多窗格图表 / 指标 / 回放 / 画线 / 模拟交易
   多窗格各自选择周期, 但共享同一条时间轴 (cutoff): 主窗格走一根, 其余窗格跟着推进到同一时刻。 */
(function () {
  'use strict';

  var LWC = window.LightweightCharts;
  var $ = function (id) { return document.getElementById(id); };

  var PERIOD_LABELS = {
    1: 'M1', 5: 'M5', 15: 'M15', 30: 'M30', 60: 'H1',
    240: 'H4', 1440: 'D1', 10080: 'W1', 43200: 'MN'
  };
  var PERIOD_ORDER = [1, 5, 15, 30, 60, 240, 1440, 10080, 43200];
  var SPLITTER_SIZE = 8;        // 与 CSS --splitter-size 保持一致
  var MIN_PANE_SIZE = 120;

  var MA_DEF = [
    { key: 'ma5', color: '#f6c85f', calc: function (b) { return Indicators.sma(b, 5); }, width: 1 },
    { key: 'ma10', color: '#e07a5f', calc: function (b) { return Indicators.sma(b, 10); }, width: 1 },
    { key: 'ma20', color: '#4d9de0', calc: function (b) { return Indicators.sma(b, 20); }, width: 1.4 },
    { key: 'ma60', color: '#b07cc6', calc: function (b) { return Indicators.sma(b, 60); }, width: 1 },
    { key: 'ema20', color: '#5ec4b6', calc: function (b) { return Indicators.ema(b, 20); }, width: 1 },
    { key: 'boll', color: '#8891a8', calc: function (b) { return Indicators.boll(b, 20, 2); }, width: 1 }
  ];

  var TOOL_DEF = [
    { id: 'cursor', title: '光标 / 拖动 (V)',
      svg: '<path d="M3 2l10 6.5-4.6 1L6.8 14z" fill="currentColor" stroke="none"/>' },
    { id: 'trend', title: '趋势线 (T)',
      svg: '<path d="M3 13L13 3" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="3" cy="13" r="1.6" fill="currentColor"/><circle cx="13" cy="3" r="1.6" fill="currentColor"/>' },
    { id: 'ray', title: '射线 (R)',
      svg: '<path d="M3 13L14 2.5" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="3" cy="13" r="1.6" fill="currentColor"/><path d="M11.2 2.2l3.2-.6-.6 3.2z" fill="currentColor"/>' },
    { id: 'hline', title: '水平线 (H)',
      svg: '<path d="M1 8h14" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="8" cy="8" r="1.8" fill="currentColor"/>' },
    { id: 'vline', title: '垂直线 (L)',
      svg: '<path d="M8 1v14" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="8" cy="8" r="1.8" fill="currentColor"/>' },
    { id: 'rect', title: '矩形 (B)',
      svg: '<rect x="2.5" y="4" width="11" height="8.5" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/>' },
    { id: 'fib', title: '斐波那契 (F)',
      svg: '<path d="M2 4h12M2 6.5h12M2 8.75h12M2 11h12M2 13.5h12" stroke="currentColor" stroke-width="1.2" fill="none" opacity=".85"/>' },
    { id: 'text', title: '文字 (X)',
      svg: '<path d="M3 3.5h10M8 3.5V13" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/>' },
    { id: 'measure', title: '测量 (M)',
      svg: '<rect x="2" y="6.5" width="12" height="4" rx=".6" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M5 6.5v2M8 6.5v3M11 6.5v2" stroke="currentColor" stroke-width="1.2"/>' }
  ];

  var ORDER_LABELS = {
    buy_limit: '买入限价', sell_limit: '卖出限价',
    buy_stop: '买入止损', sell_stop: '卖出止损'
  };

  /* ============================================================ 状态 */

  var state = {
    catalog: null,
    serverId: null,
    symbol: null,
    digits: 2,
    panes: [],
    activeIndex: 0,
    layout: 1,
    splitDir: 'col',      // 双窗格: col=上下, row=左右
    splitRatio: 0.5,      // 第一窗格占比
    playing: false,
    timer: null,
    speed: 4,
    subMode: 'none',
    volVisible: true,     // 主图成交量柱
    showHistory: true,    // 图表上是否绘制已平仓的历史仓位
    startTime: 0          // 回放起点 (时间戳, 跨窗格共用)
  };

  var styleCtx = null;      // { pane, id, dirty }: 正在编辑的画线样式
  var drawDefaults = {};    // 用户保存的每种工具的新画线默认样式
  var DRAW_DEFAULTS_KEY = 'kline-replay:draw-defaults';
  var DRAW_TYPE_LABELS = {
    trend: '趋势线', ray: '射线', hline: '水平线', vline: '垂直线',
    rect: '矩形', fib: '斐波那契', text: '文字', measure: '测量'
  };
  var FIB_NEW_COLORS = ['#f23645', '#ff9800', '#4caf50', '#089981', '#2962ff', '#ab47bc', '#787b86'];
  var FIB_ADD_SUGGEST = [-0.5, 0.5, 0.618, -0.618, 1.618, 2.618, 0.786, 0.382, 0.236];

  function p0() { return state.panes[0]; }
  function activePane() { return state.panes[state.activeIndex] || state.panes[0]; }

  // 兼容老的调试/测试钩子
  Object.defineProperties(state, {
    bars: { get: function () { var p = p0(); return p ? p.bars : []; } },
    cursor: { get: function () { var p = p0(); return p ? p.cursor : 0; } },
    sessionStart: { get: function () { var p = p0(); return p ? p.sessionStart : 0; } }
  });

  /* ============================================================ 工具 */

  var hintTimer = null;
  function hint(msg) {
    var el = $('hint');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  function fmtInt(n) { return (n || 0).toLocaleString('en-US'); }

  function fmtTime(t) {
    var d = new Date(t * 1000);
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
      ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  }

  function perLabel(p) { return PERIOD_LABELS[p] || ('M' + p); }

  function srvLabel(id) {
    var s = srvById(id);
    return s ? s.label : (id || '');
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function money(v) { return (v >= 0 ? '+' : '') + v.toFixed(2); }

  function lastIndexAtOrBefore(bars, t) {
    var lo = 0, hi = bars.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (bars[mid].time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  /* ============================================================ 窗格 */

  function chartOptions() {
    var opts = ChartStyle.chartOptions();
    opts.localization = {
      locale: 'zh-CN',
      timeFormatter: function (t) {
        var d = new Date(t * 1000);
        var p = function (n) { return n < 10 ? '0' + n : '' + n; };
        return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
      }
    };
    return opts;
  }

  function createPane(index) {
    var idAttr = function (id) { return index === 0 ? ' id="' + id + '"' : ''; };
    var section = document.createElement('section');
    section.className = 'pane';
    section.dataset.index = String(index);
    section.innerHTML =
      '<div class="pane-head">' +
        '<div class="periods"' + idAttr('periodBar') + '></div>' +
        '<span class="pane-tag"></span>' +
        '<div class="replay-badge"' + idAttr('replayBadge') + ' hidden>回放中</div>' +
      '</div>' +
      '<div class="chart-wrap"' + idAttr('chartWrap') + '>' +
        '<div class="chart-host"' + idAttr('chartHost') + '></div>' +
        '<canvas class="draw-layer"' + idAttr('drawLayer') + '></canvas>' +
        '<div class="legend"' + idAttr('legend') + '></div>' +
        '<div class="hint"' + idAttr('hint') + '></div>' +
      '</div>';

    var pane = {
      index: index, period: null, bars: [], digits: 2, cursor: 0, sessionStart: 0,
      ind: {}, overlays: {}, subSeries: {},
      els: {
        section: section,
        periods: section.querySelector('.periods'),
        tag: section.querySelector('.pane-tag'),
        badge: section.querySelector('.replay-badge'),
        wrap: section.querySelector('.chart-wrap'),
        host: section.querySelector('.chart-host'),
        canvas: section.querySelector('.draw-layer'),
        legend: section.querySelector('.legend')
      }
    };

    $('chartGrid').appendChild(section);

    var chart = LWC.createChart(pane.els.host, chartOptions());
    var candle = chart.addSeries(LWC.CandlestickSeries, ChartStyle.candleOptions());
    candle.priceScale('right').applyOptions({
      scaleMargins: { top: 0.06, bottom: state.volVisible ? 0.24 : 0.06 }
    });

    var volume = chart.addSeries(LWC.HistogramSeries, {
      priceScaleId: 'vol', priceFormat: { type: 'volume' },
      priceLineVisible: false, lastValueVisible: false, visible: state.volVisible
    }, 0);
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    pane.chart = chart;
    pane.candle = candle;
    pane.volume = volume;
    ChartStyle.applyToPane(pane);

    pane.drawLayer = new DrawingLayer({
      host: pane.els.wrap,
      canvas: pane.els.canvas,
      chart: chart,
      series: candle,
      getBars: function () { return pane.bars; },
      getCursor: function () { return pane.cursor; },
      onChange: function () {
        persistDrawings(pane);
        if (styleCtx && styleCtx.pane === pane && !pane.drawLayer.getDrawing(styleCtx.id)) {
          closeStylePanel();
        }
      },
      onHint: hint,
      onEdit: function (id) { openStylePanel(pane, id); },
      // 画完一条线 / 按 Esc 时画线层会自动回到光标模式, 工具栏高亮和提示要跟着退回。
      // 非活动窗格在切走时已被重置为 cursor, 这里只同步当前窗格, 不去动全局工具栏。
      onToolChange: function (tool) {
        if (pane.index !== state.activeIndex) return;
        currentTool = tool;
        syncToolButtons();
        if (TOOL_TIPS[tool]) hint(TOOL_TIPS[tool]);
      }
    });
    pane.drawLayer.setDefaults(drawDefaults);

    pane.book = new TradeBook({
      showHistory: state.showHistory,
      getBars: function () { return pane.bars; },
      getCursor: function () { return pane.cursor; },
      getPlotWidth: function () { try { return chart.timeScale().width(); } catch (e) { return 0; } },
      getPriceAt: function (y) { return candle.coordinateToPrice(y); },
      onUpdate: function () {
        if (pane.index === state.activeIndex) renderTradePanel();
        saveTrades(pane);
        if (pane.drawLayer) pane.drawLayer.requestRedraw();
      },
      onHint: hint
    });

    pane.drawLayer.setExtraPainter(function (ctx, layer) { pane.book.paint(ctx, layer); });
    pane.drawLayer.setInterceptor(pane.book);
    pane.drawLayer.startAutoSync();

    chart.subscribeCrosshairMove(function (param) {
      if (!param || !param.time || !param.seriesData) { paneUpdateLegendLast(pane); return; }
      var d = param.seriesData.get(candle);
      if (!d) { paneUpdateLegendLast(pane); return; }
      var idx = -1;
      var lo = 0, hi = Math.min(pane.cursor, pane.bars.length - 1);
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (pane.bars[mid].time === param.time) { idx = mid; break; }
        if (pane.bars[mid].time < param.time) lo = mid + 1; else hi = mid - 1;
      }
      var prev = idx > 0 ? pane.bars[idx - 1] : null;
      var vol = param.seriesData.get(volume);
      renderLegend(pane, {
        open: d.open, high: d.high, low: d.low, close: d.close,
        volume: vol && vol.value ? vol.value : 0
      }, prev);
    });

    pane.els.wrap.addEventListener('mousedown', function () { setActive(pane.index); }, true);
    pane.els.wrap.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      setActive(pane.index);
      var r = pane.els.wrap.getBoundingClientRect();
      showChartMenu(pane, e.clientX, e.clientY, e.clientX - r.left, e.clientY - r.top);
    });

    pane.resizeObserver = new ResizeObserver(function () {
      if (pane.drawLayer) pane.drawLayer.resize();
    });
    pane.resizeObserver.observe(pane.els.wrap);

    return pane;
  }

  function destroyPane(pane) {
    if (styleCtx && styleCtx.pane === pane) closeStylePanel();
    cancelTradeSave(pane);
    if (pane.resizeObserver) {
      pane.resizeObserver.disconnect();
      pane.resizeObserver = null;
    }
    if (pane.drawLayer) pane.drawLayer.dispose();
    try { pane.chart.remove(); } catch (e) { /* ignore */ }
    if (pane.els.section.parentNode) pane.els.section.parentNode.removeChild(pane.els.section);
  }

  function setActive(index) {
    if (state.activeIndex === index) return;
    closeStylePanel();
    state.activeIndex = index;
    state.panes.forEach(function (p) {
      p.els.section.classList.toggle('active', p.index === index);
      if (p.index !== index && p.drawLayer) p.drawLayer.setTool('cursor');
    });
    renderTradePanel();
    currentTool = 'cursor';
    syncToolButtons();
  }

  /* ============================================================ 数据装载 */

  function paneLoad(pane, period) {
    pane.period = period;
    var url = '/api/bars?server=' + encodeURIComponent(state.serverId) +
      '&symbol=' + encodeURIComponent(state.symbol) + '&period=' + period;

    return fetch(url).then(function (r) { return r.json(); }).then(function (res) {
      if (res.error) throw new Error(res.error);
      var bars = res.bars.map(function (b) {
        return { time: b[0], open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5] };
      });
      pane.bars = bars;
      pane.digits = res.digits;
      pane.cursor = bars.length - 1;
      pane.sessionStart = Math.max(0, bars.length - 1 - 500);
      if (pane.index === 0) state.digits = res.digits;

      pane.candle.applyOptions({
        priceFormat: { type: 'price', precision: res.digits, minMove: Math.pow(10, -res.digits) }
      });
      pane.drawLayer.setDigits(res.digits);

      computeIndicators(pane);
      paneBuildSeries(pane);
      paneApplyAll(pane, true);
      paneFocus(pane);

      pane.els.tag.textContent = state.symbol + ' · ' + srvLabel(state.serverId);
      buildPeriodBar(pane, res.period);
      loadDrawings(pane);

      if (pane.index === 0 && bars.length) {
        var last = new Date(bars[bars.length - 1].time * 1000);
        $('jumpDate').value = last.getUTCFullYear() + '-' +
          ('0' + (last.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + last.getUTCDate()).slice(-2);
      }

      pane.book.setContext({ symbol: state.symbol, digits: res.digits, bars: bars });
      loadTrades(pane);

      paneUpdateBadge(pane);
      paneUpdateLegendLast(pane);
      return pane;
    });
  }

  function buildPeriodBar(pane, activePeriod) {
    var host = pane.els.periods;
    var avail = availablePeriods();
    host.innerHTML = '';
    PERIOD_ORDER.forEach(function (period) {
      var b = document.createElement('button');
      b.textContent = perLabel(period);
      b.dataset.period = String(period);
      if (period === activePeriod) b.classList.add('active');
      if (avail.indexOf(period) < 0) {
        b.disabled = true;
        b.title = '该周期没有本地数据';
      }
      b.addEventListener('click', function () {
        if (period === pane.period) { setActive(pane.index); return; }
        setActive(pane.index);
        var keepT = cutoffTime();
        var multi = state.panes.length > 1;
        var arr = host.querySelectorAll('button');
        for (var i = 0; i < arr.length; i++) arr[i].classList.toggle('active', arr[i].dataset.period === String(period));
        paneLoad(pane, period).then(function () {
          if (!multi && pane === p0()) {
            // 单窗格: 回到该周期自己的记忆点 (没有就停在最新)
            if (!restorePosition()) setCutoff(cutoffTime());
          } else if (keepT) {
            // 多窗格: 时间轴共享, 换周期只改变显示粒度, 时刻不动
            setCutoff(keepT);
          }
          updateStatus();
        }).catch(function (e) { hint('载入失败: ' + e.message); });
      });
      host.appendChild(b);
    });
  }

  function computeIndicators(pane) {
    var b = pane.bars;
    pane.ind = {
      ma5: Indicators.sma(b, 5),
      ma10: Indicators.sma(b, 10),
      ma20: Indicators.sma(b, 20),
      ma60: Indicators.sma(b, 60),
      ema20: Indicators.ema(b, 20),
      boll: Indicators.boll(b, 20, 2),
      macd: Indicators.macd(b, 12, 26, 9),
      rsi: Indicators.rsi(b, 14)
    };
  }

  function applyVolumeVisibility(pane) {
    if (!pane || !pane.volume) return;
    pane.volume.applyOptions({ visible: state.volVisible });
    // 关闭成交量后把底部腾出来给 K 线, 打开时恢复 24% 的副图空间
    pane.candle.priceScale('right').applyOptions({
      scaleMargins: { top: 0.06, bottom: state.volVisible ? 0.24 : 0.06 }
    });
    if (pane.drawLayer) pane.drawLayer.requestRedraw();
  }

  function paneBuildSeries(pane) {
    var chart = pane.chart;
    applyVolumeVisibility(pane);
    Object.keys(pane.overlays).forEach(function (k) { try { chart.removeSeries(pane.overlays[k]); } catch (e) { } });
    Object.keys(pane.subSeries).forEach(function (k) { try { chart.removeSeries(pane.subSeries[k]); } catch (e) { } });
    pane.overlays = {};
    pane.subSeries = {};

    MA_DEF.forEach(function (d) {
      var enabled = d.key === 'boll' ? $('ind-boll').checked : $('ind-' + d.key).checked;
      if (!enabled) return;
      if (d.key === 'boll') {
        ['upper', 'mid', 'lower'].forEach(function (part, i) {
          pane.overlays['boll_' + part] = chart.addSeries(LWC.LineSeries, {
            color: d.color, lineWidth: 1, lineStyle: i === 1 ? 0 : 2,
            priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false
          }, 0);
        });
      } else {
        pane.overlays[d.key] = chart.addSeries(LWC.LineSeries, {
          color: d.color, lineWidth: d.width,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false
        }, 0);
      }
    });

    if (state.subMode === 'macd') {
      pane.subSeries.hist = chart.addSeries(LWC.HistogramSeries, {
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        priceLineVisible: false, lastValueVisible: false
      }, 1);
      pane.subSeries.macd = chart.addSeries(LWC.LineSeries, {
        color: '#4d9de0', lineWidth: 1.2, priceLineVisible: false, lastValueVisible: false
      }, 1);
      pane.subSeries.signal = chart.addSeries(LWC.LineSeries, {
        color: '#f6c85f', lineWidth: 1.2, priceLineVisible: false, lastValueVisible: false
      }, 1);
    } else if (state.subMode === 'rsi') {
      pane.subSeries.rsi = chart.addSeries(LWC.LineSeries, {
        color: '#b07cc6', lineWidth: 1.4, priceLineVisible: false, lastValueVisible: false
      }, 1);
    }

    try {
      var panes = chart.panes();
      if (panes.length > 1) { panes[0].setStretchFactor(3.2); panes[1].setStretchFactor(1); }
    } catch (e) { /* ignore */ }
  }

  function pick(arr, n) {
    var out = [];
    for (var i = 0; i < n && i < arr.length; i++) if (arr[i]) out.push(arr[i]);
    return out;
  }

  function paneApplyAll(pane, full) {
    var n = pane.cursor + 1;
    var ind = pane.ind;

    if (full) {
      var slice = pane.bars.slice(0, n);
      pane.candle.setData(slice);
      // 即使成交量隐藏也要同步数据: 否则切周期后 series 还留着旧周期的时间轴, 重新打开会跳视图
      var vc = ChartStyle.volumeColors();
      pane.volume.setData(slice.map(function (b) {
        return { time: b.time, value: b.volume, color: b.close >= b.open ? vc.up : vc.down };
      }));
      ['ma5', 'ma10', 'ma20', 'ma60', 'ema20'].forEach(function (k) {
        if (pane.overlays[k]) pane.overlays[k].setData(pick(ind[k], n));
      });
      if (pane.overlays.boll_upper) {
        pane.overlays.boll_upper.setData(pick(ind.boll.upper, n));
        pane.overlays.boll_mid.setData(pick(ind.boll.mid, n));
        pane.overlays.boll_lower.setData(pick(ind.boll.lower, n));
      }
      if (pane.subSeries.hist) {
        pane.subSeries.hist.setData(pick(ind.macd.hist, n));
        pane.subSeries.macd.setData(pick(ind.macd.macd, n));
        pane.subSeries.signal.setData(pick(ind.macd.signal, n));
      }
      if (pane.subSeries.rsi) pane.subSeries.rsi.setData(pick(ind.rsi, n));
    } else {
      var bar = pane.bars[n - 1];
      if (!bar) return;
      pane.candle.update(bar);
      var barVolColor = ChartStyle.volumeColors();
      pane.volume.update({
        time: bar.time, value: bar.volume,
        color: bar.close >= bar.open ? barVolColor.up : barVolColor.down
      });
      ['ma5', 'ma10', 'ma20', 'ma60', 'ema20'].forEach(function (k) {
        if (pane.overlays[k] && ind[k][n - 1]) pane.overlays[k].update(ind[k][n - 1]);
      });
      if (pane.overlays.boll_upper) {
        if (ind.boll.upper[n - 1]) pane.overlays.boll_upper.update(ind.boll.upper[n - 1]);
        if (ind.boll.mid[n - 1]) pane.overlays.boll_mid.update(ind.boll.mid[n - 1]);
        if (ind.boll.lower[n - 1]) pane.overlays.boll_lower.update(ind.boll.lower[n - 1]);
      }
      if (pane.subSeries.hist) {
        if (ind.macd.hist[n - 1]) pane.subSeries.hist.update(ind.macd.hist[n - 1]);
        if (ind.macd.macd[n - 1]) pane.subSeries.macd.update(ind.macd.macd[n - 1]);
        if (ind.macd.signal[n - 1]) pane.subSeries.signal.update(ind.macd.signal[n - 1]);
      }
      if (pane.subSeries.rsi && ind.rsi[n - 1]) pane.subSeries.rsi.update(ind.rsi[n - 1]);
    }
    if (pane.drawLayer) pane.drawLayer.requestRedraw();
  }

  function paneFocus(pane) {
    var n = pane.cursor + 1;
    var span = Math.min(240, Math.max(60, n));
    try {
      pane.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - span), to: n + 6 });
    } catch (e) { /* ignore */ }
  }

  function paneMoveTo(pane, idx, opts) {
    opts = opts || {};
    var total = pane.bars.length;
    if (!total) return;
    idx = Math.max(0, Math.min(total - 1, idx));
    if (idx === pane.cursor && !opts.force) return;

    var prev = pane.cursor;
    var delta = Math.abs(idx - prev);
    if (prev >= 0 && idx > prev && idx - prev <= 12) {
      for (var i = prev + 1; i <= idx; i++) {
        pane.cursor = i;
        paneApplyAll(pane, false);
      }
    } else {
      // 小幅移动保留视口; 大跨度 (换周期/跳转/回放定位) 必须以光标为锚重新取景,
      // 否则会沿用旧数据长度下的索引区间, 视图跑到空白区
      var r = prev >= 0 && delta <= 12 ? pane.chart.timeScale().getVisibleLogicalRange() : null;
      pane.cursor = idx;
      paneApplyAll(pane, true);
      if (r) { try { pane.chart.timeScale().setVisibleLogicalRange(r); } catch (e) { } }
      else paneFocus(pane);
    }
    pane.cursor = idx;
    if (pane.book) pane.book.onCursorMove(prev, idx);   // 每个窗格自己的持仓/挂单都要结算
    paneUpdateBadge(pane);
    paneUpdateLegendLast(pane);
  }

  function paneSetByTime(pane, t) {
    if (!pane.bars.length || !t) return;
    // 高周期 K 线必须等驱动窗格走完它覆盖的全部低周期 K 线后才能出现:
    // M1 走到 12:04 时 5min(12:00) 才收完, 之前只能显示上一根 11:55。
    var d = driverPane();
    var lag = d && pane.period > d.period ? (pane.period - d.period) * 60 : 0;
    var idx = lastIndexAtOrBefore(pane.bars, t - lag);

    if (idx < 0) {
      // 驱动窗格还没走完该高周期窗格的第一根 K 线 -> 该窗格暂时无可见 K 线
      if (pane.cursor !== -1) {
        var prev = pane.cursor;
        pane.cursor = -1;
        paneApplyAll(pane, true);
        paneFocus(pane);
        if (pane.book) pane.book.onCursorMove(prev, -1);
        paneUpdateBadge(pane);
        paneUpdateLegendLast(pane);
      }
      return;
    }
    paneMoveTo(pane, idx);
  }

  /** 播放粒度由「周期最小」的窗格决定: M5 + M1 时每次推进 1 根 M1 */
  function driverPane() {
    var best = null;
    for (var i = 0; i < state.panes.length; i++) {
      var p = state.panes[i];
      if (!p.bars.length) continue;
      if (!best || p.period < best.period) best = p;
    }
    return best || state.panes[0] || null;
  }

  function cutoffTime() {
    var d = driverPane();
    if (!d || !d.bars.length) return 0;
    var b = d.bars[d.cursor];
    return b ? b.time : 0;
  }

  function atCutoffEnd() {
    var d = driverPane();
    return !d || !d.bars.length || d.cursor >= d.bars.length - 1;
  }

  function defaultStartTime() {
    var d = driverPane();
    if (!d || !d.bars.length) return 0;
    return d.bars[Math.max(0, d.bars.length - 1 - 500)].time;
  }

  /** 把游标时间广播给所有窗格 */
  function setCutoff(t) {
    if (!t) return;
    // 对齐到驱动窗格真实存在的一根 K 线, 避免跨周期时游标"落在两根之间"反复漂移
    var d = driverPane();
    if (d && d.bars.length) {
      var i = lastIndexAtOrBefore(d.bars, t);
      if (i >= 0) t = d.bars[i].time;
    }
    state.panes.forEach(function (p) { paneSetByTime(p, t); });
    renderTradePanel();
    updateStatus();
    savePosition();
    if (atCutoffEnd()) stopPlay();
  }

  function syncPanes() {
    var t = cutoffTime();
    if (t) setCutoff(t);
  }

  /* ============================================================ 图例 / 角标 */

  function renderLegend(pane, b, prev) {
    if (!pane.els.legend) return;
    var d = pane.digits;
    var chg = prev ? b.close - prev.close : 0;
    var pct = prev && prev.close ? (chg / prev.close) * 100 : 0;
    var up = chg >= 0;
    var cls = up ? 'up' : 'down';
    pane.els.legend.innerHTML =
      '<div><span class="sym">' + esc(state.symbol) + '</span><span class="tf">' + perLabel(pane.period) +
      ' · ' + esc(srvLabel(state.serverId)) + '</span></div>' +
      '<div class="ohlc">' +
      '<span class="kv">开 <b>' + b.open.toFixed(d) + '</b></span>' +
      '<span class="kv">高 <b>' + b.high.toFixed(d) + '</b></span>' +
      '<span class="kv">低 <b>' + b.low.toFixed(d) + '</b></span>' +
      '<span class="kv">收 <b class="' + cls + '">' + b.close.toFixed(d) + '</b></span>' +
      '<span class="kv ' + cls + '">' + (up ? '+' : '') + chg.toFixed(d) + ' (' + (up ? '+' : '') + pct.toFixed(2) + '%)</span>' +
      '</div>';
  }

  function paneUpdateLegendLast(pane) {
    var b = pane.bars[pane.cursor];
    var prev = pane.cursor > 0 ? pane.bars[pane.cursor - 1] : null;
    if (!b) {
      if (pane.els.legend) pane.els.legend.innerHTML = '';
      return;
    }
    renderLegend(pane, b, prev);
  }

  function paneUpdateBadge(pane) {
    if (!pane.els.badge) return;
    pane.els.badge.hidden = atCutoffEnd() ||
      !(pane.bars.length && pane.cursor >= 0 && pane.cursor < pane.bars.length - 1);
  }

  /* ============================================================ 回放 */

  function step(delta) {
    stopPlay();
    var d = driverPane();
    if (!d || !d.bars.length) return;
    var target = Math.max(0, Math.min(d.bars.length - 1, d.cursor + delta));
    if (target === d.cursor) { updateStatus(); return; }
    setCutoff(d.bars[target].time);
  }

  function setCursor(idx, opts) {
    opts = opts || {};
    var d = driverPane();
    if (!d || !d.bars.length) return;
    idx = Math.max(0, Math.min(d.bars.length - 1, idx));
    var t = d.bars[idx].time;
    if (t === cutoffTime() && !opts.force) { updateStatus(); return; }
    setCutoff(t);
  }

  function gotoStart() {
    stopPlay();
    setCutoff(state.startTime || defaultStartTime());
  }

  function gotoEnd() {
    stopPlay();
    var d = driverPane();
    if (!d || !d.bars.length) return;
    setCursor(d.bars.length - 1);
  }

  function togglePlay() { if (state.playing) stopPlay(); else startPlay(); }

  function startPlay() {
    if (state.playing) return;
    if (atCutoffEnd()) { hint('已经是最新一根，先回退再播放'); return; }
    state.playing = true;
    $('btnPlay').textContent = '❚❚';
    $('btnPlay').classList.add('playing');
    scheduleTick();
  }

  function stopPlay() {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (!state.playing) return;
    state.playing = false;
    $('btnPlay').textContent = '▶';
    $('btnPlay').classList.remove('playing');
  }

  function scheduleTick() {
    if (!state.playing) return;
    state.timer = window.setTimeout(function () {
      if (!state.playing) return;
      var d = driverPane();
      if (!d || !d.bars.length || d.cursor >= d.bars.length - 1) { stopPlay(); return; }
      setCutoff(d.bars[d.cursor + 1].time);
      scheduleTick();
    }, Math.round(1000 / state.speed));
  }

  function updateStatus() {
    var d = driverPane();
    if (!d || !d.bars.length) return;
    var total = d.bars.length;
    var cur = d.bars[d.cursor];
    $('barPos').textContent = fmtInt(d.cursor + 1) + ' / ' + fmtInt(total) + ' 根';
    $('barTime').textContent = cur ? fmtTime(cur.time) : '—';
    var slider = $('cursorSlider');
    slider.max = Math.max(0, total - 1);
    slider.value = d.cursor;
    var pct = total > 1 ? (d.cursor / (total - 1)) * 100 : 100;
    slider.style.setProperty('--fill', pct.toFixed(2) + '%');
    $('btnPlay').disabled = !total || d.cursor >= total - 1;
  }

  /* ============================================================ 布局 */

  function applySplit() {
    var grid = $('chartGrid');
    var rz = $('paneResizer');
    var dual = state.layout === 2;
    grid.dataset.split = state.splitDir;
    grid.style.setProperty('--split-ratio', state.splitRatio.toFixed(5));
    $('splitSwitch').hidden = !dual;
    rz.hidden = !dual;
    var btns = $('splitSwitch').querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].dataset.split === state.splitDir);
    }
    rz.setAttribute('aria-orientation', state.splitDir === 'row' ? 'vertical' : 'horizontal');
    rz.setAttribute('aria-label', state.splitDir === 'row' ? '左右窗格分隔线' : '上下窗格分隔线');
    rz.setAttribute('aria-valuenow', String(Math.round(state.splitRatio * 100)));
  }

  function setSplitDir(dir) {
    if (dir !== 'row' && dir !== 'col') return;
    state.splitDir = dir;
    applySplit();
    requestAnimationFrame(resizePanes);
  }

  function setSplitRatio(ratio) {
    state.splitRatio = Math.max(0, Math.min(1, ratio));
    $('chartGrid').style.setProperty('--split-ratio', state.splitRatio.toFixed(5));
    $('paneResizer').setAttribute('aria-valuenow', String(Math.round(state.splitRatio * 100)));
  }

  function resizePanes() {
    state.panes.forEach(function (p) { if (p.drawLayer) p.drawLayer.resize(); });
  }

  /** 双窗格可用区域 (不含 padding 和中间分隔线) */
  function gridContentSize(dir) {
    var grid = $('chartGrid');
    var cs = window.getComputedStyle(grid);
    var total = dir === 'row' ? grid.clientWidth : grid.clientHeight;
    total -= dir === 'row'
      ? parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
      : parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    return Math.max(0, total - SPLITTER_SIZE);
  }

  function clampSplitSize(size, total) {
    var min = Math.min(MIN_PANE_SIZE, total / 2);
    return Math.max(min, Math.min(total - min, size));
  }

  function initSplitResizer() {
    var rz = $('paneResizer');
    var drag = null;

    function finishDrag(e) {
      if (!drag) return;
      drag = null;
      rz.classList.remove('dragging');
      document.body.classList.remove('resizing', 'resizing-row', 'resizing-col');
      try { rz.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }

    rz.addEventListener('pointerdown', function (e) {
      if (state.layout !== 2 || !state.panes[0]) return;
      var dir = state.splitDir;
      var rect = state.panes[0].els.section.getBoundingClientRect();
      var total = gridContentSize(dir);
      if (total < 2) return;

      drag = {
        dir: dir,
        start: dir === 'row' ? e.clientX : e.clientY,
        size: dir === 'row' ? rect.width : rect.height,
        total: total
      };
      rz.focus({ preventScroll: true });
      rz.setPointerCapture(e.pointerId);
      rz.classList.add('dragging');
      document.body.classList.add('resizing', dir === 'row' ? 'resizing-row' : 'resizing-col');
      e.preventDefault();
    });

    rz.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var pos = drag.dir === 'row' ? e.clientX : e.clientY;
      var size = clampSplitSize(drag.size + pos - drag.start, drag.total);
      setSplitRatio(size / drag.total);
    });

    rz.addEventListener('pointerup', finishDrag);
    rz.addEventListener('pointercancel', finishDrag);

    rz.addEventListener('dblclick', function () {
      setSplitRatio(0.5);
      requestAnimationFrame(resizePanes);
    });

    rz.addEventListener('keydown', function (e) {
      if (state.layout !== 2) return;
      var dir = state.splitDir;
      var delta = 0;
      if (dir === 'row') {
        if (e.key === 'ArrowLeft') delta = -1;
        else if (e.key === 'ArrowRight') delta = 1;
      } else {
        if (e.key === 'ArrowUp') delta = -1;
        else if (e.key === 'ArrowDown') delta = 1;
      }
      if (!delta) return;

      e.preventDefault();
      var total = gridContentSize(dir);
      if (total < 2) return;
      var step = Math.max(8, total * 0.02);
      var size = clampSplitSize(state.splitRatio * total + delta * step, total);
      setSplitRatio(size / total);
      requestAnimationFrame(resizePanes);
    });
  }

  function setLayout(n) {
    if (state.layout === n && state.panes.length === n) return;
    var keepT = cutoffTime();          // 先记住当前时间, 新窗格加载后再对齐
    state.layout = n;
    $('chartGrid').dataset.layout = String(n);
    applySplit();
    var btns = $('layoutSwitch').querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', parseInt(btns[i].dataset.layout, 10) === n);
    }

    while (state.panes.length > n) destroyPane(state.panes.pop());
    if (state.activeIndex >= state.panes.length) state.activeIndex = 0;

    var added = [];
    while (state.panes.length < n) {
      var pane = createPane(state.panes.length);
      state.panes.push(pane);
      added.push(pane);
    }

    var chain = Promise.resolve();
    added.forEach(function (pane) {
      chain = chain.then(function () { return paneLoad(pane, pickNewPeriod()); });
    });

    chain.then(function () {
      if (keepT) setCutoff(keepT);
      renderTradePanel();
      setActivePanels();
      updateStatus();
    }).catch(function (e) { hint('窗格加载失败: ' + e.message); });
  }

  function setActivePanels() {
    state.panes.forEach(function (p) {
      p.els.section.classList.toggle('active', p.index === state.activeIndex);
    });
  }

  function pickNewPeriod() {
    var used = state.panes.map(function (p) { return p.period; }).filter(Boolean);
    var avail = availablePeriods();
    var prefs = [1, 5, 15, 60, 240, 1440];
    for (var i = 0; i < prefs.length; i++) {
      if (avail.indexOf(prefs[i]) >= 0 && used.indexOf(prefs[i]) < 0) return prefs[i];
    }
    return avail[0] || 5;
  }

  function availablePeriods() {
    var s = srvById(state.serverId);
    if (!s) return [5];
    var sym = symbolIn(s, state.symbol);
    if (!sym) return [5];
    return sym.periods.map(function (p) { return p.period; });
  }

  /* ============================================================ 目录 */

  function srvById(id) {
    if (!state.catalog) return null;
    for (var i = 0; i < state.catalog.servers.length; i++) {
      if (state.catalog.servers[i].id === id) return state.catalog.servers[i];
    }
    return null;
  }

  function symbolIn(server, sym) {
    if (!server) return null;
    for (var i = 0; i < server.symbols.length; i++) {
      if (server.symbols[i].symbol === sym) return server.symbols[i];
    }
    return null;
  }

  function pickDefaultSymbol(server) {
    return symbolIn(server, 'XAUUSD') || server.symbols[0];
  }

  function pickDefaultPeriod(sym) {
    var prefs = [5, 15, 60, 1, 240, 1440];
    for (var i = 0; i < prefs.length; i++) {
      if (sym.periods.some(function (p) { return p.period === prefs[i]; })) return prefs[i];
    }
    return sym.periods[0].period;
  }

  function fillSymbols(server) {
    var sel = $('symbolSelect');
    sel.innerHTML = '';
    server.symbols.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.symbol;
      o.textContent = s.symbol;
      sel.appendChild(o);
    });
  }

  function loadCatalog() {
    fetch('/api/catalog').then(function (r) { return r.json(); }).then(function (cat) {
      state.catalog = cat;
      if (!cat.servers || !cat.servers.length) { hint('没有找到 .hst 数据'); return; }

      var serverSel = $('serverSelect');
      serverSel.innerHTML = '';
      cat.servers.forEach(function (s) {
        var o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.label;
        serverSel.appendChild(o);
      });

      var saved = readSession();
      var server = srvById(saved.server) || cat.servers[0];
      serverSel.value = server.id;
      fillSymbols(server);

      var sym = symbolIn(server, saved.symbol) || pickDefaultSymbol(server);
      $('symbolSelect').value = sym.symbol;

      state.serverId = server.id;
      state.symbol = sym.symbol;

      var period = sym.periods.some(function (p) { return p.period === saved.period; })
        ? saved.period : pickDefaultPeriod(sym);

      var pane = createPane(0);
      state.panes.push(pane);
      paneLoad(pane, period).then(function () {
        restorePosition();
        updateStatus();
        setActivePanels();
        saveSession();
      }).catch(function (e) { hint('载入失败: ' + e.message); });
    }).catch(function (e) { hint('载入目录失败: ' + e.message); });
  }

  function reloadAll() {
    if (!state.panes.length) return;
    var chain = Promise.resolve();
    state.panes.forEach(function (p) {
      chain = chain.then(function () { return paneLoad(p, p.period); });
    });
    chain.then(function () {
      restorePosition();     // 主窗格回到该品种周期自己的记忆点
      syncPanes();
      updateStatus();
      renderTradePanel();
      saveSession();
    }).catch(function (e) { hint('重载失败: ' + e.message); });
  }

  /* ============================================================ 持久化 */

  function drawKey(pane) {
    return 'kline-replay:draw:' + state.serverId + ':' + state.symbol + ':' + pane.period;
  }
  function tradeKey(pane) {
    return 'kline-replay:trades:' + state.serverId + ':' + state.symbol + ':' + pane.period;
  }
  function posKey() {
    var p = p0();
    return 'kline-replay:pos:' + state.serverId + ':' + state.symbol + ':' + (p ? p.period : '');
  }

  var persistTimer = null;
  function persistDrawings(pane) {
    if (!pane.drawLayer) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      try { localStorage.setItem(drawKey(pane), JSON.stringify(pane.drawLayer.getDrawings())); } catch (e) { }
    }, 250);
  }

  function loadDrawings(pane) {
    if (styleCtx && styleCtx.pane === pane) closeStylePanel();
    var raw = null;
    try { raw = localStorage.getItem(drawKey(pane)); } catch (e) { }
    var list = [];
    if (raw) { try { list = JSON.parse(raw) || []; } catch (e) { list = []; } }
    pane.drawLayer.setDrawings(list);
  }

  /* ============================================================ 画线样式 */

  function readDrawDefaults() {
    try {
      var v = JSON.parse(localStorage.getItem(DRAW_DEFAULTS_KEY) || '{}');
      return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    } catch (e) {
      return {};
    }
  }

  function styleEl(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function pctOf(v, fallback) {
    var n = Number(v);
    if (!isFinite(n)) n = fallback;
    return Math.max(0, Math.min(100, Math.round(n * 100)));
  }

  function fmtLevel(v) {
    var n = Number(v);
    if (!isFinite(n)) return '0';
    return String(Math.round(n * 10000) / 10000);
  }

  function styleColorRow(label, field, value) {
    var row = styleEl('div', 'style-row');
    row.appendChild(styleEl('span', '', label));
    var input = document.createElement('input');
    input.type = 'color';
    input.dataset.field = field;
    input.value = /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#2962ff';
    row.appendChild(input);
    return row;
  }

  function styleRangeRow(label, field, value, fallback, min) {
    var row = styleEl('div', 'style-row');
    row.appendChild(styleEl('span', '', label));
    var wrap = styleEl('div', 'style-range');
    var range = document.createElement('input');
    range.type = 'range';
    range.min = String(min);
    range.max = '100';
    range.step = '1';
    range.dataset.field = field;
    var pct = (value === null || value === undefined) ? pctOf(fallback, fallback) : pctOf(value, fallback);
    range.value = String(pct);
    var val = styleEl('span', 'style-val', pct + '%');
    wrap.appendChild(range);
    wrap.appendChild(val);
    row.appendChild(wrap);
    return row;
  }

  function currentStyleLevels() {
    if (!styleCtx) return [];
    return styleCtx.pane.drawLayer.getFibLevels(styleCtx.id) || [];
  }

  function closeStylePanel() {
    styleCtx = null;
    var el = $('stylePanel');
    if (el) el.hidden = true;
  }

  /** Ctrl+Z / 撤销按钮把画线回滚后, 面板必须重新读取当前样式;
      同时重置 dirty, 让下一次修改重新建立撤销点, 避免后续修改合并回滚。 */
  function syncStylePanelAfterUndo() {
    if (!styleCtx) return;
    if (!styleCtx.pane.drawLayer.getDrawing(styleCtx.id)) { closeStylePanel(); return; }
    styleCtx.dirty = false;
    styleCtx.pane.drawLayer.select(styleCtx.id);
    renderStylePanel();
  }

  function openStylePanel(pane, id) {
    if (!pane || !pane.drawLayer) return;
    var d = pane.drawLayer.getDrawing(id);
    if (!d || d.type === 'measure') return;
    styleCtx = { pane: pane, id: id, dirty: false };
    pane.drawLayer.select(id);
    $('indicatorPanel').hidden = true;
    $('drawPanel').hidden = true;
    $('stylePanel').hidden = false;
    renderStylePanel();
  }

  function renderStylePanel() {
    if (!styleCtx) return;
    var layer = styleCtx.pane.drawLayer;
    var d = layer.getDrawing(styleCtx.id);
    if (!d) { closeStylePanel(); return; }

    var label = DRAW_TYPE_LABELS[d.type] || '画线';
    $('styleTitle').textContent = label + '样式';
    var body = $('styleBody');
    body.innerHTML = '';

    if (d.type === 'rect') {
      body.appendChild(styleColorRow('边框颜色', 'color', d.color));
      body.appendChild(styleColorRow('填充颜色', 'fillColor', d.fillColor || d.color));
      body.appendChild(styleRangeRow('透明度', 'opacity', d.opacity, 1, 0));
      body.appendChild(styleRangeRow('填充透明度', 'fillOpacity', d.fillOpacity, 0.1, 0));
    } else if (d.type === 'fib') {
      body.appendChild(styleRangeRow('透明度', 'opacity', d.opacity, 1, 0));
      body.appendChild(styleEl('div', 'style-hint', '比例可填任意数值，例如 0.5、-0.5、1.618'));

      var head = styleEl('div', 'fib-head');
      head.appendChild(styleEl('span', 'fib-h-vis', ''));
      head.appendChild(styleEl('span', 'fib-h-ratio', '比例'));
      head.appendChild(styleEl('span', 'fib-h-color', '颜色'));
      head.appendChild(styleEl('span', 'fib-h-del', ''));
      body.appendChild(head);

      var levels = currentStyleLevels();
      var list = styleEl('div', 'fib-levels');
      levels.forEach(function (lv, i) {
        var row = styleEl('div', 'fib-row');

        var vis = document.createElement('input');
        vis.type = 'checkbox';
        vis.dataset.field = 'levelVisible';
        vis.dataset.index = String(i);
        vis.checked = lv.visible !== false;
        vis.title = '显示 / 隐藏这条水平位';

        var ratio = document.createElement('input');
        ratio.type = 'number';
        ratio.step = 'any';
        ratio.dataset.field = 'levelRatio';
        ratio.dataset.index = String(i);
        ratio.value = fmtLevel(lv.ratio);
        ratio.title = '斐波那契比例';

        var color = document.createElement('input');
        color.type = 'color';
        color.dataset.field = 'levelColor';
        color.dataset.index = String(i);
        color.value = /^#[0-9a-f]{6}$/i.test(lv.color || '') ? lv.color : '#9598a1';
        color.title = '这条水平位的颜色';

        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'fib-del';
        del.dataset.act = 'fib-del';
        del.dataset.index = String(i);
        del.textContent = '×';
        del.title = '删除水平位';

        row.appendChild(vis);
        row.appendChild(ratio);
        row.appendChild(color);
        row.appendChild(del);
        list.appendChild(row);
      });
      body.appendChild(list);

      var add = document.createElement('button');
      add.type = 'button';
      add.className = 'style-btn';
      add.dataset.act = 'fib-add';
      add.textContent = '+ 添加水平位';
      body.appendChild(add);
    } else {
      body.appendChild(styleColorRow(d.type === 'text' ? '文字颜色' : '线条颜色', 'color', d.color));
      body.appendChild(styleRangeRow('透明度', 'opacity', d.opacity, 1, 0));
    }

    var foot = styleEl('div', 'style-foot');
    var save = document.createElement('button');
    save.type = 'button';
    save.className = 'style-btn';
    save.dataset.act = 'save-default';
    save.textContent = '存为“' + label + '”新画线默认';
    foot.appendChild(save);
    body.appendChild(foot);
  }

  function commitStylePatch(patch) {
    if (!styleCtx || !patch) return;
    var layer = styleCtx.pane.drawLayer;
    if (!styleCtx.dirty) {
      if (!layer.beginStyleEdit(styleCtx.id)) return;
      styleCtx.dirty = true;
    }
    layer.updateStyle(styleCtx.id, patch);
  }

  function onStyleInput(e) {
    if (!styleCtx) return;
    var t = e.target;
    var field = t && t.dataset ? t.dataset.field : null;
    if (!field) return;

    if (field === 'opacity' || field === 'fillOpacity') {
      var n = parseInt(t.value, 10);
      if (!isFinite(n)) return;
      var val = t.parentNode ? t.parentNode.querySelector('.style-val') : null;
      if (val) val.textContent = n + '%';
      var p = {};
      p[field] = n / 100;
      commitStylePatch(p);
      return;
    }

    if (field === 'color' || field === 'fillColor') {
      var c = {};
      c[field] = t.value;
      // 旧矩形没有独立填充色时, 修改边框色会同时改变画布填充; 色块和后续保存必须跟上
      if (field === 'color') {
        var cur = styleCtx.pane.drawLayer.getDrawing(styleCtx.id);
        if (cur && cur.type === 'rect' && !cur.fillColor) {
          c.fillColor = t.value;
          var fillInput = document.querySelector('#styleBody input[data-field="fillColor"]');
          if (fillInput) fillInput.value = t.value;
        }
      }
      commitStylePatch(c);
      return;
    }

    if (field === 'levelColor' || field === 'levelRatio' || field === 'levelVisible') {
      var levels = currentStyleLevels();
      var i = parseInt(t.dataset.index, 10);
      if (!levels[i]) return;
      if (field === 'levelColor') {
        levels[i].color = t.value;
      } else if (field === 'levelRatio') {
        var r = parseFloat(t.value);
        if (!isFinite(r)) {
          // 非法比例不提交; 失焦时回填当前生效值, 避免下次重绘时突然跳变
          if (e.type === 'change') t.value = fmtLevel(levels[i].ratio);
          return;
        }
        levels[i].ratio = r;
      } else {
        levels[i].visible = !!t.checked;
      }
      commitStylePatch({ levels: levels });
    }
  }

  function onStyleBlur(e) {
    var t = e.target;
    if (!t || !t.dataset || t.dataset.field !== 'levelRatio') return;
    if (isFinite(parseFloat(t.value))) return;
    var levels = currentStyleLevels();
    var i = parseInt(t.dataset.index, 10);
    if (levels[i]) t.value = fmtLevel(levels[i].ratio);
  }

  function addFibLevel() {
    if (!styleCtx) return;
    var levels = currentStyleLevels();
    var used = {};
    levels.forEach(function (lv) { used[fmtLevel(lv.ratio)] = true; });
    var ratio = null;
    for (var i = 0; i < FIB_ADD_SUGGEST.length; i++) {
      if (!used[fmtLevel(FIB_ADD_SUGGEST[i])]) { ratio = FIB_ADD_SUGGEST[i]; break; }
    }
    if (ratio === null) ratio = 0.5;
    levels.push({
      ratio: ratio,
      color: FIB_NEW_COLORS[levels.length % FIB_NEW_COLORS.length],
      visible: true
    });
    commitStylePatch({ levels: levels });
    renderStylePanel();
    var inputs = $('styleBody').querySelectorAll('.fib-row input[type="number"]');
    var last = inputs[inputs.length - 1];
    if (last) { last.focus(); last.select(); }
  }

  function deleteFibLevel(index) {
    if (!styleCtx) return;
    var levels = currentStyleLevels();
    if (!levels[index]) return;
    levels.splice(index, 1);
    commitStylePatch({ levels: levels });
    renderStylePanel();
  }

  function saveStyleAsDefault() {
    if (!styleCtx) return;
    var layer = styleCtx.pane.drawLayer;
    var d = layer.getDrawing(styleCtx.id);
    if (!d) return;
    var style = {};
    ['color', 'fillColor', 'opacity', 'fillOpacity', 'width'].forEach(function (k) {
      if (d[k] !== undefined) style[k] = d[k];
    });
    if (d.type === 'rect' && !style.fillColor) style.fillColor = d.color;
    // visible 也属于样式: 勾掉的水平位会保存在默认值里, 新建 fib 保持同样的显示状态
    if (d.type === 'fib') style.levels = layer.getFibLevels(d.id);
    drawDefaults[d.type] = style;
    var saved = true;
    try { localStorage.setItem(DRAW_DEFAULTS_KEY, JSON.stringify(drawDefaults)); }
    catch (e) { saved = false; }
    state.panes.forEach(function (p) { if (p.drawLayer) p.drawLayer.setDefaults(drawDefaults); });
    if (saved) {
      hint('已保存为“' + (DRAW_TYPE_LABELS[d.type] || '画线') + '”的新画线默认样式');
    } else {
      hint('无法写入本地存储，默认样式仅本次会话有效');
    }
  }

  function onStyleClick(e) {
    if (!styleCtx) return;
    var btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    // 添加/删除会重绘面板, 被点击的按钮随即脱离 DOM;
    // 若事件继续冒泡, document 的“点外部关闭”检查会误判并关掉面板。
    e.preventDefault();
    e.stopPropagation();
    var act = btn.dataset.act;
    if (act === 'fib-add') addFibLevel();
    else if (act === 'fib-del') deleteFibLevel(parseInt(btn.dataset.index, 10));
    else if (act === 'save-default') saveStyleAsDefault();
  }

  var tradeSaveTimers = {};
  var tradeSigMap = {};

  function tradeSig(pane) {
    var b = pane.book;
    if (!b) return '';
    var posSig = b.positions.map(function (p) { return p.id + ':' + p.sl + ':' + p.tp; }).join(',');
    return (b.activePosId || '-') + '|' + posSig + '|' + b.trades.length + '|' +
      (b.trades.length ? b.trades[b.trades.length - 1].id : '') + '|' +
      b.orders.map(function (o) { return o.id; }).join(',');
  }

  function cancelTradeSave(pane) {
    if (!tradeSaveTimers[pane.index]) return;
    clearTimeout(tradeSaveTimers[pane.index]);
    delete tradeSaveTimers[pane.index];
  }

  function writeTrades(pane) {
    if (!pane.book) return;
    tradeSigMap[pane.index] = tradeSig(pane);
    try { localStorage.setItem(tradeKey(pane), JSON.stringify(pane.book.serialize())); } catch (e) { }
  }

  /** immediate=true 用于清空记录等不可丢的操作, 跳过防抖直接落盘 */
  function saveTrades(pane, immediate) {
    if (!pane.book) return;
    if (!pane.tradesReady && !immediate) return;
    cancelTradeSave(pane);
    if (immediate) { writeTrades(pane); return; }
    tradeSaveTimers[pane.index] = setTimeout(function () {
      delete tradeSaveTimers[pane.index];
      if (!pane.book || !pane.tradesReady) return;
      if (tradeSig(pane) === tradeSigMap[pane.index]) return;
      writeTrades(pane);
    }, 150);
  }

  function loadTrades(pane) {
    cancelTradeSave(pane);
    var raw = null;
    try { raw = localStorage.getItem(tradeKey(pane)); } catch (e) { }
    var data = null;
    if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
    pane.book.restore(data);
    pane.tradesReady = true;
    tradeSigMap[pane.index] = tradeSig(pane);
  }

  /** 默认显示历史仓位; 用户关掉后跨刷新记住 */
  function readHistoryVisible() {
    try { return localStorage.getItem('kline-replay:history-visible') !== '0'; } catch (e) { return true; }
  }

  var posSaveTimer = null;
  function savePosition() {
    var d = driverPane();
    if (!d || !d.bars.length) return;
    if (posSaveTimer) clearTimeout(posSaveTimer);
    posSaveTimer = setTimeout(function () {
      try {
        localStorage.setItem(posKey(), JSON.stringify({
          cursor: cutoffTime(),
          start: state.startTime || defaultStartTime(),
          savedAt: Math.floor(Date.now() / 1000)
        }));
      } catch (e) { }
    }, 400);
  }

  function nearestIndex(pane, t) {
    var bars = pane.bars;
    var lo = 0, hi = bars.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (bars[mid].time >= t) { ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return ans < 0 ? bars.length - 1 : ans;
  }

  function restorePosition() {
    var raw = null;
    try { raw = localStorage.getItem(posKey()); } catch (e) { return false; }
    if (!raw) return false;
    var data = null;
    try { data = JSON.parse(raw); } catch (e) { return false; }
    if (!data || !data.cursor) return false;

    var d = driverPane();
    if (!d || !d.bars.length) return false;
    var idx = lastIndexAtOrBefore(d.bars, data.cursor);
    if (idx < 0) idx = nearestIndex(d, data.cursor);
    if (idx < 0 || idx >= d.bars.length) return false;
    if (idx >= d.bars.length - 1) return false;      // 上次就在最新一根

    state.startTime = data.start || defaultStartTime();
    setCutoff(d.bars[idx].time);
    hint('已回到上次的播放位置 · ' + fmtTime(d.bars[idx].time));
    return true;
  }

  function saveSession() {
    try {
      localStorage.setItem('kline-replay:session', JSON.stringify({
        server: state.serverId, symbol: state.symbol, period: p0() ? p0().period : null
      }));
    } catch (e) { }
  }

  function readSession() {
    try {
      var raw = localStorage.getItem('kline-replay:session');
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }

  /* ============================================================ 工具栏 */

  var currentTool = 'cursor';

  // 工具提示文案: 工具栏点击与画线层自动回退共用, 避免两处文案不一致
  var TOOL_TIPS = {
    trend: '点击起点 → 点击终点', ray: '点击起点 → 点击方向',
    hline: '点击放置水平线', vline: '点击放置垂直线',
    rect: '点击两个对角', fib: '点击起点 → 点击终点',
    text: '点击位置后输入文字', measure: '按住拖动测量',
    cursor: '拖动画线或点击空白处取消选择'
  };

  function buildToolbar() {
    var bar = $('toolbar');
    bar.innerHTML = '';
    TOOL_DEF.forEach(function (t) {
      if (t.id === 'measure') {
        var sep = document.createElement('div');
        sep.className = 'tool-sep';
        bar.appendChild(sep);
      }
      var b = document.createElement('button');
      b.className = 'tool-btn' + (t.id === 'cursor' ? ' active' : '');
      b.dataset.tool = t.id;
      b.title = t.title;
      b.innerHTML = '<svg viewBox="0 0 16 16" fill="none">' + t.svg + '</svg>';
      b.addEventListener('click', function () { selectTool(t.id); });
      bar.appendChild(b);
    });

    var sep2 = document.createElement('div');
    sep2.className = 'tool-sep';
    bar.appendChild(sep2);

    var del = document.createElement('button');
    del.className = 'tool-btn';
    del.dataset.tool = 'eraser';
    del.title = '删除选中 (Del)';
    del.innerHTML = '<svg viewBox="0 0 16 16" fill="none"><path d="M3 12.5h10" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 9.5l4-4 3.5 3.5-4 4H5.2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    del.addEventListener('click', function () {
      var p = activePane();
      if (!p || !p.drawLayer.deleteSelected()) hint('先点选一条画线');
    });
    bar.appendChild(del);
  }

  function selectTool(id) {
    currentTool = id;
    syncToolButtons();
    var p = activePane();
    // 由工具栏主动设置: setTool 不触发 onToolChange, 高亮已在上面同步, 不会被反向覆盖
    if (p) p.drawLayer.setTool(id === 'eraser' ? 'cursor' : id);
    if (TOOL_TIPS[id]) hint(TOOL_TIPS[id]);
  }

  function syncToolButtons() {
    var tools = $('toolbar').querySelectorAll('.tool-btn');
    for (var i = 0; i < tools.length; i++) {
      tools[i].classList.toggle('active', tools[i].dataset.tool === currentTool);
    }
  }

  function openChartSettings() {
    closeStylePanel();
    hideMenu();
    $('indicatorPanel').hidden = true;
    $('drawPanel').hidden = true;
    ChartStyle.openDialog({
      getPanes: function () { return state.panes; },
      onApply: function (style, saved) {
        hint(saved === false ? '样式已生效，但浏览器禁止了本地保存' : '图表样式已保存');
      },
      onHint: hint
    });
  }

  /* ============================================================ 交易面板 */

  function syncHistoryButton() {
    var btn = $('btnToggleHistory');
    if (!btn) return;
    btn.classList.toggle('on', state.showHistory);
    btn.setAttribute('aria-pressed', state.showHistory ? 'true' : 'false');
    btn.title = state.showHistory ? '点击隐藏图表上的历史仓位' : '点击显示图表上的历史仓位';
  }

  function setShowHistory(on) {
    state.showHistory = !!on;
    try { localStorage.setItem('kline-replay:history-visible', state.showHistory ? '1' : '0'); } catch (e) { }
    state.panes.forEach(function (p) {
      if (p.book) p.book.setShowHistory(state.showHistory);
    });
    syncHistoryButton();
    hint(state.showHistory ? '已显示历史仓位' : '已隐藏历史仓位');
  }

  function renderTradePanel() {
    var pane = activePane();
    if (!pane || !pane.book) return;
    var book = pane.book;
    var dg = pane.digits;
    var positions = book.positions;
    var active = book.activePosition();

    var bar = pane.bars[pane.cursor];
    $('btnBuy').disabled = !bar;
    $('btnSell').disabled = !bar;
    $('tpEntryPrice').textContent = bar ? bar.close.toFixed(dg) : '';
    $('ocoInput').checked = !!book.oco;

    var posBox = $('posBlock');
    if (positions.length) {
      var total = book.floating();
      var longCount = 0, shortCount = 0;
      positions.forEach(function (p) { if (p.dir === 1) longCount++; else shortCount++; });
      posBox.innerHTML =
        '<div class="pos-head">' +
          '<span class="pos-title">持仓 <em>' + positions.length + ' 单</em>' +
            (positions.length > 1 ? '<span class="pos-mix">多 ' + longCount + ' / 空 ' + shortCount + '</span>' : '') +
          '</span>' +
          '<span class="pos-pnl ' + (total >= 0 ? 'up' : 'down') + '">' + money(total) + '</span>' +
        '</div>' +
        positions.map(function (p, i) {
          var up = p.dir === 1;
          var fl = book.floatingOf(p);
          var isActive = active && active.id === p.id;
          return '<div class="pos-item' + (isActive ? ' active' : '') + '" data-id="' + p.id + '" title="点击选中这一单">' +
            '<div class="pos-line">' +
              '<span class="pos-tag ' + (up ? 'long' : 'short') + '">#' + (p.no || i + 1) + ' ' + (up ? '多' : '空') + ' ' + p.lots + ' 手</span>' +
              '<span class="pos-fl ' + (fl >= 0 ? 'up' : 'down') + '">' + money(fl) + '</span>' +
              '<button class="pos-close" data-id="' + p.id + '" title="平掉这一单">×</button>' +
            '</div>' +
            '<div class="pos-row"><span class="k">开仓</span><span class="v">' + p.entryPrice.toFixed(dg) +
              ' · ' + fmtTime(p.entryTime).slice(5) + '</span></div>' +
            ((p.sl != null || p.tp != null)
              ? '<div class="pos-row"><span class="k">止损 / 止盈</span><span class="v">' +
                  '<span class="sl">' + (p.sl != null ? p.sl.toFixed(dg) : '—') + '</span>' +
                  ' / ' +
                  '<span class="tp">' + (p.tp != null ? p.tp.toFixed(dg) : '—') + '</span>' +
                '</span></div>'
              : '') +
            '</div>';
        }).join('') +
        '<div class="pos-actions">' +
          '<button class="btn-close-pos" id="btnClosePos">平仓' +
            (active ? ' #' + (active.no || (positions.indexOf(active) + 1)) : '') + ' <kbd>E</kbd></button>' +
          (positions.length > 1 ? '<button class="btn-close-all" id="btnCloseAll">全部平仓</button>' : '') +
        '</div>';

      Array.prototype.forEach.call(posBox.querySelectorAll('.pos-item'), function (item) {
        item.addEventListener('click', function (e) {
          if (e.target.closest('.pos-close')) return;
          if (!book.setActivePosition(item.dataset.id)) return;
          if (pane.drawLayer) pane.drawLayer.requestRedraw();
        });
      });
      Array.prototype.forEach.call(posBox.querySelectorAll('.pos-close'), function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          doCloseOne(btn.dataset.id);
        });
      });
      $('btnClosePos').addEventListener('click', doClose);
      var allBtn = $('btnCloseAll');
      if (allBtn) allBtn.addEventListener('click', doCloseAll);
    } else {
      posBox.innerHTML = '<div class="tp-label">持仓</div><div class="tp-empty">当前无持仓</div>';
    }

    var ordersBox = $('ordersBlock');
    if (book.orders.length) {
      ordersBox.innerHTML =
        '<div class="tp-label">挂单 <em>' + book.orders.length + ' 张</em></div>' +
        '<div class="tp-list" id="ordersList">' +
        book.orders.map(function (o) {
          var isBuy = (o.type === 'buy_limit' || o.type === 'buy_stop');
          return '<div class="order-item">' +
            '<span class="' + (isBuy ? 'type-buy' : 'type-sell') + '">' + ORDER_LABELS[o.type] + '</span>' +
            '<span class="px">' + o.price.toFixed(dg) + ' · ' + o.lots + '手' + (o.oco ? ' · OCO' : '') + '</span>' +
            '<button class="cancel" data-id="' + o.id + '" title="取消">×</button>' +
            '</div>';
        }).join('') +
        '</div>';
      Array.prototype.forEach.call(ordersBox.querySelectorAll('.cancel'), function (btn) {
        btn.addEventListener('click', function () {
          book.cancelOrder(btn.dataset.id);
          if (pane.drawLayer) pane.drawLayer.requestRedraw();
        });
      });
    } else {
      ordersBox.innerHTML = '';
    }

    var s = book.stats();
    var statsBox = $('statsBlock');
    if (s.count) {
      var pf = s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2);
      statsBox.innerHTML =
        '<div class="tp-label">统计 <em>' + s.count + ' 笔</em></div>' +
        '<div class="stat-grid">' +
          statItem('总盈亏', money(s.total), s.total >= 0 ? 'up' : 'down') +
          statItem('胜率', s.winRate.toFixed(1) + '%', '') +
          statItem('盈亏比', pf, '') +
          statItem('均笔', money(s.avg), s.avg >= 0 ? 'up' : 'down') +
          statItem('最大回撤', '-' + s.maxDD.toFixed(2), s.maxDD > 0 ? 'down' : '') +
          statItem('最好/最差', money(s.best) + ' / ' + money(s.worst), '') +
        '</div>';
    } else {
      statsBox.innerHTML = '<div class="tp-label">统计</div><div class="tp-empty">还没有平仓记录</div>';
    }

    $('tradeCount').textContent = s.count ? s.count + ' 笔' : '';
    var list = $('tradeList');
    if (!book.trades.length) {
      list.innerHTML = '';
    } else {
      list.innerHTML = book.trades.slice().reverse().map(function (t) {
        var isLong = t.dir === 1;
        return '<div class="trade-item" data-id="' + t.id + '">' +
          '<span class="dir ' + (isLong ? 'long' : 'short') + '">' + (isLong ? '多' : '空') + ' ' + t.lots + '</span>' +
          '<span class="px">' + t.entryPrice.toFixed(dg) + ' → ' + t.exitPrice.toFixed(dg) + '</span>' +
          '<span class="pnl ' + (t.pnl >= 0 ? 'up' : 'down') + '">' + money(t.pnl) + '</span>' +
          '</div>';
      }).join('');
    }
  }

  function statItem(k, v, cls) {
    return '<div class="stat-item"><span class="k">' + k + '</span><span class="v ' + cls + '">' + v + '</span></div>';
  }

  function doTrade(dir) {
    var pane = activePane();
    if (!pane || !pane.book) return;
    if (!pane.bars.length || !pane.bars[pane.cursor]) { hint('还没有数据'); return; }

    var lots = parseFloat($('lotsInput').value);
    var contract = parseFloat($('contractInput').value);
    var sl = parseFloat($('slInput').value);
    var tp = parseFloat($('tpTargetInput').value);

    pane.book.setLots(isFinite(lots) && lots > 0 ? lots : 0.1);
    pane.book.setContract(isFinite(contract) && contract > 0 ? contract : 100);

    pane.book.open(dir, {
      lots: pane.book.lots,
      contract: pane.book.contract,
      sl: isFinite(sl) ? sl : null,
      tp: isFinite(tp) ? tp : null
    });

    $('slInput').value = '';
    $('tpTargetInput').value = '';
    if (pane.drawLayer) pane.drawLayer.requestRedraw();
  }

  function doClose() {
    var pane = activePane();
    if (!pane || !pane.book) return;
    var pos = pane.book.activePosition();
    if (!pos) { hint('当前没有持仓'); return; }
    var t = pane.book.close('手动平仓');
    if (t) {
      hint('平仓 #' + (pos.no || '') + ' @ ' + t.exitPrice.toFixed(pane.digits) + '  盈亏 ' + money(t.pnl) +
        (pane.book.positions.length ? '（还剩 ' + pane.book.positions.length + ' 单）' : ''));
      if (pane.drawLayer) pane.drawLayer.requestRedraw();
    }
  }

  function doCloseOne(id) {
    var pane = activePane();
    if (!pane || !pane.book) return;
    var pos = pane.book.positions.filter(function (p) { return p.id === id; })[0];
    if (!pos) return;
    var t = pane.book.closePosition(id, '手动平仓');
    if (t) {
      hint('平仓 #' + (pos.no || '') + ' @ ' + t.exitPrice.toFixed(pane.digits) + '  盈亏 ' + money(t.pnl) +
        (pane.book.positions.length ? '（还剩 ' + pane.book.positions.length + ' 单）' : ''));
      if (pane.drawLayer) pane.drawLayer.requestRedraw();
    }
  }

  function doCloseAll() {
    var pane = activePane();
    if (!pane || !pane.book) return;
    if (!pane.book.positions.length) { hint('当前没有持仓'); return; }
    var closed = pane.book.closeAll('全部平仓');
    if (!closed.length) return;
    var sum = 0;
    closed.forEach(function (t) { sum += t.pnl; });
    hint('已平掉 ' + closed.length + ' 单，合计 ' + money(sum));
    if (pane.drawLayer) pane.drawLayer.requestRedraw();
  }

  /* ============================================================ 右键菜单 */

  function hideMenu() {
    var m = $('ctxMenu');
    if (m) m.hidden = true;
  }

  function ctxAdd(menu, cls, label, meta, enabled, onClick) {
    var el = document.createElement('div');
    el.className = 'ctx-item ' + cls + (enabled ? '' : ' disabled');
    var dot = document.createElement('span'); dot.className = 'dot';
    var lab = document.createElement('span'); lab.className = 'label'; lab.textContent = label;
    el.appendChild(dot);
    el.appendChild(lab);
    if (meta) {
      var m = document.createElement('span'); m.className = 'meta'; m.textContent = meta;
      el.appendChild(m);
    }
    if (enabled) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        hideMenu();
        onClick();
      });
    }
    menu.appendChild(el);
  }

  function ctxSep(menu) {
    var s = document.createElement('div');
    s.className = 'ctx-sep';
    menu.appendChild(s);
  }

  function showChartMenu(pane, clientX, clientY, localX, localY) {
    if (!pane || !pane.bars.length) return;
    var price = pane.candle.coordinateToPrice(localY);
    if (price === null || price === undefined) return;

    var book = pane.book;
    var curBar = pane.bars[pane.cursor];
    if (!curBar) return;
    var close = curBar.close;
    var dg = pane.digits;
    var active = book.activePosition();
    var menu = $('ctxMenu');
    menu.innerHTML = '';

    var head = document.createElement('div');
    head.className = 'ctx-head';
    head.textContent = perLabel(pane.period) + ' · 价格 ' + price.toFixed(dg);
    menu.appendChild(head);

    var drawHit = pane.drawLayer && pane.drawLayer.hitAt ? pane.drawLayer.hitAt(localX, localY) : null;
    if (drawHit) {
      var hitDrawing = pane.drawLayer.getDrawing(drawHit.id);
      // measure 是拖拽期间的临时对象, 不应出现样式入口 (hitAt 本身也会跳过它)
      if (hitDrawing && hitDrawing.type !== 'measure') {
        ctxAdd(menu, 'flat', '画线样式…',
          DRAW_TYPE_LABELS[hitDrawing.type] || '', true,
          function () { openStylePanel(pane, drawHit.id); });
        ctxSep(menu);
      }
    }

    ctxAdd(menu, 'buy', '市价买入', book.lots + ' 手 @ ' + close.toFixed(dg), true, function () { doTrade(1); });
    ctxAdd(menu, 'sell', '市价卖出', book.lots + ' 手 @ ' + close.toFixed(dg), true, function () { doTrade(-1); });

    ctxSep(menu);

    ['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop'].forEach(function (type) {
      var ok = book.orderSideOk(type, price);
      var dirCls = (type === 'buy_limit' || type === 'buy_stop') ? 'buy' : 'sell';
      ctxAdd(menu, dirCls, ORDER_LABELS[type], '@ ' + price.toFixed(dg), ok, function () {
        book.placeOrder(type, price, { lots: book.lots, contract: book.contract, oco: book.oco });
        if (pane.drawLayer) pane.drawLayer.requestRedraw();
      });
    });

    ctxSep(menu);

    if (active) {
      ctxAdd(menu, 'danger', '平仓', '#' + (active.no || '') + ' · ' + active.lots + ' 手', true, doClose);
      if (book.positions.length > 1) {
        ctxAdd(menu, 'danger', '全部平仓', book.positions.length + ' 单', true, doCloseAll);
      }
    }

    var near = null;
    book.orders.forEach(function (o) {
      var y = pane.candle.priceToCoordinate(o.price);
      if (y !== null && y !== undefined && Math.abs(y - localY) <= 8 && !near) near = o;
    });
    if (near) {
      ctxAdd(menu, 'flat', '取消挂单', ORDER_LABELS[near.type] + ' ' + near.price.toFixed(dg), true, function () {
        book.cancelOrder(near.id);
        if (pane.drawLayer) pane.drawLayer.requestRedraw();
      });
    } else if (book.orders.length) {
      ctxAdd(menu, 'flat', '取消全部挂单', book.orders.length + ' 张', true, function () {
        book.cancelAllOrders();
        if (pane.drawLayer) pane.drawLayer.requestRedraw();
      });
    }

    ctxSep(menu);
    ctxAdd(menu, 'flat', '图表设置…', '外观 / K线 / 十字光标', true, openChartSettings);

    menu.hidden = false;
    menu.style.left = '0px';
    menu.style.top = '0px';
    var w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(6, Math.min(clientX, window.innerWidth - w - 8)) + 'px';
    menu.style.top = Math.max(6, Math.min(clientY, window.innerHeight - h - 8)) + 'px';
  }

  /* ============================================================ 事件绑定 */

  function bindUI() {
    $('serverSelect').addEventListener('change', function (e) {
      var server = srvById(e.target.value);
      state.serverId = server.id;
      fillSymbols(server);
      var sym = pickDefaultSymbol(server);
      $('symbolSelect').value = sym.symbol;
      state.symbol = sym.symbol;
      reloadAll();
    });

    $('symbolSelect').addEventListener('change', function (e) {
      var server = srvById(state.serverId);
      var sym = symbolIn(server, e.target.value);
      if (!sym) return;
      state.symbol = sym.symbol;
      state.panes.forEach(function (p) {
        if (!sym.periods.some(function (x) { return x.period === p.period; })) {
          p.period = pickDefaultPeriod(sym);
        }
      });
      reloadAll();
    });

    $('layoutSwitch').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      setLayout(parseInt(b.dataset.layout, 10));
    });

    $('splitSwitch').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      setSplitDir(b.dataset.split);
    });
    initSplitResizer();

    $('btnPrev').addEventListener('click', function () { step(-1); });
    $('btnNext').addEventListener('click', function () { step(1); });
    $('btnPlay').addEventListener('click', togglePlay);
    $('btnRewind').addEventListener('click', gotoStart);
    $('btnEnd').addEventListener('click', gotoEnd);
    $('btnShowAll').addEventListener('click', function () {
      gotoEnd();
      var d = driverPane();
      if (d) { try { d.chart.timeScale().fitContent(); } catch (e) { } }
    });
    $('cursorSlider').addEventListener('input', function (e) {
      stopPlay();
      setCursor(parseInt(e.target.value, 10));
    });
    $('speedSelect').addEventListener('change', function (e) {
      state.speed = parseInt(e.target.value, 10);
      if (state.playing) { clearTimeout(state.timer); scheduleTick(); }
    });
    $('btnJump').addEventListener('click', jumpToDate);
    $('jumpDate').addEventListener('keydown', function (e) { if (e.key === 'Enter') jumpToDate(); });

    $('btnIndicators').addEventListener('click', function (e) { e.stopPropagation(); togglePop('indicatorPanel'); });
    $('btnDrawMenu').addEventListener('click', function (e) { e.stopPropagation(); togglePop('drawPanel'); });
    $('btnChartSettings').addEventListener('click', function (e) {
      e.stopPropagation();
      openChartSettings();
    });
    document.addEventListener('click', function (e) {
      if (ChartStyle.isOpen()) return;
      if (!e.target.closest('.popover') && !e.target.closest('.ghost')) {
        $('indicatorPanel').hidden = true;
        $('drawPanel').hidden = true;
        closeStylePanel();
        hideMenu();
      }
    });

    ['ma5', 'ma10', 'ma20', 'ma60', 'ema20', 'boll'].forEach(function (k) {
      $('ind-' + k).addEventListener('change', rebuildIndicatorSeries);
    });
    $('ind-vol').addEventListener('change', function () {
      state.volVisible = this.checked;
      state.panes.forEach(applyVolumeVisibility);
    });
    document.querySelectorAll('input[name="sub"]').forEach(function (el) {
      el.addEventListener('change', function () {
        state.subMode = el.value;
        rebuildIndicatorSeries();
      });
    });

    $('btnUndo').addEventListener('click', function () {
      var p = activePane();
      if (!p || !p.drawLayer.undo()) hint('没有可撤销的操作');
      else syncStylePanelAfterUndo();
    });
    $('btnDeleteSel').addEventListener('click', function () {
      var p = activePane();
      if (!p || !p.drawLayer.deleteSelected()) hint('先点选一条画线');
    });
    $('btnStyleSel').addEventListener('click', function () {
      var p = activePane();
      if (!p) return;
      var id = p.drawLayer.selected;
      if (!id) { hint('先点选一条画线'); return; }
      var d = p.drawLayer.getDrawing(id);
      if (!d) { hint('先点选一条画线'); return; }
      if (d.type === 'measure') { hint('测量不支持样式设置'); return; }
      openStylePanel(p, id);
    });
    $('btnStyleClose').addEventListener('click', closeStylePanel);
    $('styleBody').addEventListener('input', onStyleInput);
    $('styleBody').addEventListener('change', onStyleInput);
    $('styleBody').addEventListener('focusout', onStyleBlur);
    $('styleBody').addEventListener('click', onStyleClick);
    $('btnClearAll').addEventListener('click', function () {
      var p = activePane();
      if (!p || !p.drawLayer.drawings.length) return;
      if (confirm('清空当前窗格（' + perLabel(p.period) + '）的全部画线？')) p.drawLayer.clear();
    });
    $('btnExportDraw').addEventListener('click', exportDrawings);
    $('btnImportDraw').addEventListener('click', function () { $('importFile').click(); });
    $('importFile').addEventListener('change', importDrawings);

    $('btnTradePanel').addEventListener('click', function () {
      var panel = $('tradePanel');
      panel.hidden = !panel.hidden;
      this.classList.toggle('on', !panel.hidden);
      setTimeout(resizeLayers, 40);
    });
    $('btnTradeClose').addEventListener('click', function () {
      $('tradePanel').hidden = true;
      $('btnTradePanel').classList.remove('on');
      setTimeout(resizeLayers, 40);
    });

    $('btnBuy').addEventListener('click', function () { doTrade(1); });
    $('btnSell').addEventListener('click', function () { doTrade(-1); });

    $('lotsInput').addEventListener('change', function () {
      var p = activePane();
      if (p && p.book) { p.book.setLots(parseFloat(this.value)); this.value = p.book.lots; }
    });
    $('contractInput').addEventListener('change', function () {
      var p = activePane();
      if (p && p.book) { p.book.setContract(parseFloat(this.value)); this.value = p.book.contract; }
    });
    $('ocoInput').addEventListener('change', function () {
      var on = this.checked;
      // OCO 是全局设置: 所有窗格的下一次挂单都用同一个值
      state.panes.forEach(function (pp) { if (pp.book) pp.book.setOco(on); });
      hint(on ? '挂单 OCO 已开启：任一挂单成交会撤销其余' : '挂单 OCO 已关闭：挂单独立触发');
    });

    $('btnToggleHistory').addEventListener('click', function () {
      setShowHistory(!state.showHistory);
    });
    $('btnExportTrades').addEventListener('click', exportTrades);
    $('btnClearTrades').addEventListener('click', function () {
      var p = activePane();
      if (!p || !p.book) return;
      if (!p.book.trades.length && !p.book.positions.length) return;
      if (confirm('清空当前窗格的所有交易记录和持仓？')) {
        p.book.clear();
        saveTrades(p, true);          // 清空立即落盘, 避免刷新/切周期后旧记录复活
        if (p.drawLayer) p.drawLayer.requestRedraw();
      }
    });

    $('tradeList').addEventListener('click', function (e) {
      var item = e.target.closest('.trade-item');
      var p = activePane();
      if (!item || !p || !p.book) return;
      var t = p.book.trades.filter(function (x) { return x.id === item.dataset.id; })[0];
      if (!t) return;
      var idx = p.book.idxOfTime(t.entryTime);
      if (idx >= 0 && p === p0()) { stopPlay(); setCursor(idx); }
    });

    document.addEventListener('keydown', onKey);
  }

  function resizeLayers() {
    state.panes.forEach(function (p) { if (p.drawLayer) p.drawLayer.resize(); });
  }

  function rebuildIndicatorSeries() {
    state.panes.forEach(function (p) {
      var r = null;
      try { r = p.chart.timeScale().getVisibleLogicalRange(); } catch (e) { }
      paneBuildSeries(p);
      paneApplyAll(p, true);
      if (r) { try { p.chart.timeScale().setVisibleLogicalRange(r); } catch (e) { } }
    });
  }

  function togglePop(id) {
    var el = $(id);
    var other = id === 'indicatorPanel' ? $('drawPanel') : $('indicatorPanel');
    other.hidden = true;
    closeStylePanel();
    el.hidden = !el.hidden;
  }

  function onKey(e) {
    if (ChartStyle.isOpen()) return;
    var undoKey = (e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'z';
    // 面板打开时, Ctrl+Z 始终作用于面板所属窗格, 不依赖 activePane
    if (undoKey && styleCtx) {
      var sp = styleCtx.pane;
      if (sp && sp.drawLayer.handleKey(e)) {
        syncStylePanelAfterUndo();
        e.preventDefault();
      }
      return;
    }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    var p = activePane();
    if (p && p.drawLayer.handleKey(e)) {
      if (undoKey) syncStylePanelAfterUndo();
      e.preventDefault();
      return;
    }

    switch (e.key) {
      case 'ArrowLeft': step(-1); e.preventDefault(); break;
      case 'ArrowRight': step(1); e.preventDefault(); break;
      case ' ': togglePlay(); e.preventDefault(); break;
      case 'Home': gotoStart(); e.preventDefault(); break;
      case 'End': gotoEnd(); e.preventDefault(); break;
      case 'v': case 'V': selectTool('cursor'); break;
      case 't': case 'T': selectTool('trend'); break;
      case 'r': case 'R': selectTool('ray'); break;
      case 'h': case 'H': selectTool('hline'); break;
      case 'l': case 'L': selectTool('vline'); break;
      case 'b': case 'B': selectTool('rect'); break;
      case 'f': case 'F': selectTool('fib'); break;
      case 'x': case 'X': selectTool('text'); break;
      case 'm': case 'M': selectTool('measure'); break;
      case 'q': case 'Q': doTrade(1); break;
      case 'w': case 'W': doTrade(-1); break;
      case 'e': case 'E': doClose(); break;
      default: break;
    }
  }

  function jumpToDate() {
    var v = $('jumpDate').value;
    if (!v) return;
    var d = driverPane();
    if (!d || !d.bars.length) return;
    var ts = Math.floor(new Date(v + 'T00:00:00Z').getTime() / 1000);
    var idx = nearestIndex(d, ts);
    if (idx < 0) { hint('该日期之后没有数据'); return; }
    stopPlay();
    state.startTime = d.bars[idx].time;
    setCutoff(state.startTime);
  }

  function exportDrawings() {
    var p = activePane();
    if (!p) return;
    var data = JSON.stringify(p.drawLayer.getDrawings(), null, 2);
    var blob = new Blob([data], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.serverId + '_' + state.symbol + '_' + p.period + '_drawings.json';
    a.click();
    URL.revokeObjectURL(a.href);
    hint('已导出画线文件');
  }

  function importDrawings(e) {
    var file = e.target.files && e.target.files[0];
    var p = activePane();
    if (!file || !p) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var list = JSON.parse(reader.result);
        if (!Array.isArray(list)) throw new Error('格式不正确');
        p.drawLayer.setDrawings(list);
        closeStylePanel();
        persistDrawings(p);
        hint('已导入 ' + list.length + ' 条画线');
      } catch (err) {
        hint('导入失败: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function exportTrades() {
    var p = activePane();
    if (!p || !p.book || !p.book.trades.length) { hint('还没有平仓记录'); return; }
    var head = '开仓时间,方向,开仓价,手数,平仓时间,平仓价,平仓原因,盈亏';
    var lines = p.book.trades.map(function (t) {
      return [
        fmtTime(t.entryTime), t.dir === 1 ? '多' : '空', t.entryPrice.toFixed(p.digits),
        t.lots, fmtTime(t.exitTime), t.exitPrice.toFixed(p.digits), t.reason, t.pnl.toFixed(2)
      ].join(',');
    });
    var csv = '\ufeff' + head + '\r\n' + lines.join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.serverId + '_' + state.symbol + '_' + p.period + '_trades.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    hint('已导出 ' + p.book.trades.length + ' 笔交易');
  }

  /* ============================================================ 启动 */

  function boot() {
    state.showHistory = readHistoryVisible();
    drawDefaults = readDrawDefaults();
    buildToolbar();
    bindUI();
    syncHistoryButton();
    applySplit();
    ChartStyle.applyAll(state.panes);   // 先把已保存主题的 CSS 变量铺上, 图表创建时再套用

    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideMenu(); });
    document.addEventListener('mousedown', function (e) {
      var m = $('ctxMenu');
      if (m && !m.hidden && !e.target.closest('.ctx-menu')) hideMenu();
    }, true);

    window.KR = {
      get chart() { var p = p0(); return p ? p.chart : null; },
      get candle() { var p = p0(); return p ? p.candle : null; },
      get volume() { var p = p0(); return p ? p.volume : null; },
      get drawLayer() { var p = activePane(); return p ? p.drawLayer : null; },
      get book() { var p = activePane(); return p ? p.book : null; },
      get chartStyle() { return ChartStyle.get(); },
      state: state,
      api: {
        setCursor: setCursor,
        open: doTrade,
        close: doClose,
        closeOne: doCloseOne,
        closeAll: doCloseAll,
        setLayout: setLayout,
        openSettings: openChartSettings,
        placeOrder: function (type, price) {
          var p = activePane();
          return p ? p.book.placeOrder(type, price, { lots: p.book.lots, contract: p.book.contract, oco: p.book.oco }) : null;
        },
        cancelAllOrders: function () { var p = activePane(); if (p) p.book.cancelAllOrders(); },
        pane: function (i) { return state.panes[i]; }
      }
    };

    loadCatalog();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
