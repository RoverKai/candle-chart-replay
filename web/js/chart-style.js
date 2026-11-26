/* 图表外观设置: 背景 / 网格 / K线 / 十字光标
   样式全局生效 (所有窗格共用), 存在 localStorage; 设置弹窗里的改动实时预览, 点「应用」才落盘。 */
(function () {
  'use strict';

  var STORAGE_KEY = 'kline-replay:chart-style';

  var DEFAULTS = {
    background: '#131722',
    textColor: '#b2b5be',
    fontSize: 11,
    axisColor: '#2a2e39',

    gridVisible: true,
    gridColor: '#1c2231',
    gridOpacity: 1,
    gridStyle: 0,

    upColor: '#26a69a',
    upOpacity: 1,
    downColor: '#ef5350',
    downOpacity: 1,

    borderVisible: false,
    borderFollow: true,
    borderColor: '#787b86',
    borderOpacity: 1,

    wickVisible: true,
    wickFollow: true,
    wickColor: '#787b86',
    wickOpacity: 1,

    volumeOpacity: 0.42,
    priceLineVisible: true,
    priceLineColor: '#5d6b82',

    crosshairVisible: true,
    crosshairColor: '#758696',
    crosshairOpacity: 1,
    crosshairStyle: 3,
    crosshairLabelBg: '#363c4e'
  };

  function clone(obj) {
    var out = {};
    Object.keys(obj).forEach(function (k) { out[k] = obj[k]; });
    return out;
  }

  function merge(base, over) {
    var out = clone(base);
    Object.keys(over || {}).forEach(function (k) { out[k] = over[k]; });
    return out;
  }

  var PRESETS = [
    { id: 'dark', label: '深色（默认）', style: clone(DEFAULTS) },
    {
      id: 'light', label: '浅色', style: merge(DEFAULTS, {
        background: '#ffffff', textColor: '#131722', axisColor: '#e0e3eb',
        gridColor: '#e8ecf2', gridOpacity: 1,
        upColor: '#089981', downColor: '#f23645',
        borderColor: '#787b86', wickColor: '#787b86',
        priceLineColor: '#787b86',
        crosshairColor: '#9598a1', crosshairLabelBg: '#131722'
      })
    },
    {
      id: 'midnight', label: '午夜蓝', style: merge(DEFAULTS, {
        background: '#0b1020', textColor: '#aab6cf', axisColor: '#223052',
        gridColor: '#16203a', gridOpacity: 1,
        upColor: '#2ec5b6', downColor: '#ff6b81',
        borderColor: '#66779e', wickColor: '#66779e',
        priceLineColor: '#55688f',
        crosshairColor: '#7f8db3', crosshairLabelBg: '#1a2440'
      })
    }
  ];

  /* ------------------------------------------------------------ 颜色 / 数值 */

  function hexToRgb(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (!isFinite(n)) return { r: 0, g: 0, b: 0 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgba(hex, opacity) {
    var a = Math.max(0, Math.min(1, Number(opacity)));
    if (!isFinite(a)) a = 1;
    a = Math.round(a * 1000) / 1000;
    if (a >= 1) return hex;
    var c = hexToRgb(hex);
    return 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', ' + a + ')';
  }

  function luminance(hex) {
    var c = hexToRgb(hex);
    return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  }

  function readableOn(hex) {
    return luminance(hex) > 0.58 ? '#131722' : '#ffffff';
  }

  /* ------------------------------------------------------------ 存取 / 清洗 */

  function num(v, fallback, min, max) {
    if (typeof v !== 'number' || !isFinite(v)) return fallback;
    return Math.max(min, Math.min(max, v));
  }

  function sanitize(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var d = DEFAULTS[k];
      if (typeof d === 'string') {
        var v = raw[k];
        out[k] = (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v.toLowerCase() : d;
      } else if (typeof d === 'boolean') {
        out[k] = typeof raw[k] === 'boolean' ? raw[k] : d;
      } else {
        var min = 0, max = 1;
        if (k === 'fontSize') { min = 10; max = 16; }
        else if (k === 'gridStyle' || k === 'crosshairStyle') { min = 0; max = 4; }
        out[k] = num(raw[k], d, min, max);
      }
    });
    out.fontSize = Math.round(out.fontSize);
    out.gridStyle = Math.round(out.gridStyle);
    out.crosshairStyle = Math.round(out.crosshairStyle);
    return out;
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return sanitize(raw ? JSON.parse(raw) : null);
    } catch (e) {
      return clone(DEFAULTS);
    }
  }

  function save(style) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(style));
      return true;
    } catch (e) {
      return false;
    }
  }

  var current = load();

  /* ------------------------------------------------------------ 解析成实际绘制值 */

  function resolved(style) {
    style = style || current;
    return {
      bg: style.background,
      text: style.textColor,
      textSoft: rgba(style.textColor, 0.88),
      textMuted: rgba(style.textColor, 0.58),
      grid: rgba(style.gridColor, style.gridOpacity),
      axis: style.axisColor,
      up: rgba(style.upColor, style.upOpacity),
      down: rgba(style.downColor, style.downOpacity),
      borderUp: rgba(style.borderFollow ? style.upColor : style.borderColor, style.borderOpacity),
      borderDown: rgba(style.borderFollow ? style.downColor : style.borderColor, style.borderOpacity),
      wickUp: rgba(style.wickFollow ? style.upColor : style.wickColor, style.wickOpacity),
      wickDown: rgba(style.wickFollow ? style.downColor : style.wickColor, style.wickOpacity),
      cross: rgba(style.crosshairColor, style.crosshairOpacity),
      volumeUp: rgba(style.upColor, style.volumeOpacity),
      volumeDown: rgba(style.downColor, style.volumeOpacity)
    };
  }

  function crosshairLine(style, r) {
    return {
      color: r.cross,
      width: 1,
      style: style.crosshairStyle,
      visible: style.crosshairVisible,
      labelVisible: style.crosshairVisible,
      labelBackgroundColor: style.crosshairLabelBg
    };
  }

  /** createChart 用: 包含时间轴等全部初始选项 (只在新窗格创建时调用) */
  function chartOptions(style) {
    style = style || current;
    var r = resolved(style);
    return {
      autoSize: true,
      layout: {
        background: { type: 'solid', color: style.background },
        textColor: style.textColor,
        fontSize: style.fontSize,
        attributionLogo: false,
        panes: {
          separatorColor: style.axisColor,
          separatorHoverColor: 'rgba(41, 98, 255, .35)',
          enableResize: true
        }
      },
      grid: {
        vertLines: { color: r.grid, visible: style.gridVisible, style: style.gridStyle },
        horzLines: { color: r.grid, visible: style.gridVisible, style: style.gridStyle }
      },
      crosshair: {
        mode: 0,
        vertLine: crosshairLine(style, r),
        horzLine: crosshairLine(style, r)
      },
      rightPriceScale: { borderColor: style.axisColor, minimumWidth: 66 },
      timeScale: {
        borderColor: style.axisColor, timeVisible: true, secondsVisible: false,
        rightOffset: 8, barSpacing: 7, shiftVisibleRangeOnNewBar: true
      },
      handleScroll: { vertTouchDrag: false }
    };
  }

  /** 样式变更时只更新外观相关字段, 不碰 barSpacing / 视口 */
  function appearanceOptions(style) {
    var r = resolved(style);
    return {
      layout: {
        background: { type: 'solid', color: style.background },
        textColor: style.textColor,
        fontSize: style.fontSize,
        panes: {
          separatorColor: style.axisColor,
          separatorHoverColor: 'rgba(41, 98, 255, .35)',
          enableResize: true
        }
      },
      grid: {
        vertLines: { color: r.grid, visible: style.gridVisible, style: style.gridStyle },
        horzLines: { color: r.grid, visible: style.gridVisible, style: style.gridStyle }
      },
      crosshair: {
        mode: 0,
        vertLine: crosshairLine(style, r),
        horzLine: crosshairLine(style, r)
      },
      rightPriceScale: { borderColor: style.axisColor },
      timeScale: { borderColor: style.axisColor }
    };
  }

  function candleOptions(style) {
    style = style || current;
    var r = resolved(style);
    return {
      upColor: r.up,
      downColor: r.down,
      borderVisible: style.borderVisible,
      borderUpColor: r.borderUp,
      borderDownColor: r.borderDown,
      wickVisible: style.wickVisible,
      wickUpColor: r.wickUp,
      wickDownColor: r.wickDown,
      priceLineColor: style.priceLineColor,
      priceLineVisible: style.priceLineVisible,
      lastValueVisible: true
    };
  }

  function volumeBarColor(style, bar) {
    style = style || current;
    return rgba(bar.close >= bar.open ? style.upColor : style.downColor, style.volumeOpacity);
  }

  /** 设置弹窗打开时, 回放推进产生的成交量柱也要用预览色, 不能被已提交样式刷回旧色 */
  function activeVolumeStyle() {
    return previewStyle || current;
  }

  function syncCss(style) {
    var grid = document.getElementById('chartGrid');
    if (!grid) return;
    var r = resolved(style);
    grid.style.setProperty('--chart-bg', style.background);
    grid.style.setProperty('--chart-text', style.textColor);
    grid.style.setProperty('--chart-text-soft', r.textSoft);
    grid.style.setProperty('--chart-text-muted', r.textMuted);
    grid.style.setProperty('--chart-up', style.upColor);
    grid.style.setProperty('--chart-down', style.downColor);
    grid.style.setProperty('--chart-shadow', luminance(style.background) > 0.58
      ? 'none' : '0 1px 3px rgba(0, 0, 0, .8)');
  }

  function applyToPane(pane, style) {
    if (!pane || !pane.chart) return;
    pane.chart.applyOptions(appearanceOptions(style));
    if (pane.candle) pane.candle.applyOptions(candleOptions(style));
    if (pane.els && pane.els.wrap) pane.els.wrap.style.background = style.background;
  }

  function recolorVolume(pane, style) {
    if (!pane || !pane.volume || !pane.bars || !pane.bars.length) return;
    var cursor = typeof pane.cursor === 'number' ? pane.cursor : pane.bars.length - 1;
    var n = Math.max(0, Math.min(pane.bars.length, cursor + 1));
    var data = new Array(n);
    for (var i = 0; i < n; i++) {
      var b = pane.bars[i];
      data[i] = { time: b.time, value: b.volume, color: volumeBarColor(style, b) };
    }
    try { pane.volume.setData(data); } catch (e) { /* 窗格正在销毁 */ }
  }

  function applyAll(panes, style) {
    style = style || current;
    (panes || []).forEach(function (p) { applyToPane(p, style); });
    syncCss(style);
  }

  /* ------------------------------------------------------------ 设置弹窗 */

  var TABS = [
    {
      id: 'appearance', label: '外观',
      sections: [
        {
          title: '背景',
          items: [
            { type: 'color', field: 'background', label: '背景颜色' },
            { type: 'color', field: 'textColor', label: '文字颜色' },
            { type: 'range', field: 'fontSize', label: '字体大小', min: 10, max: 16, step: 1 }
          ]
        },
        {
          title: '网格',
          items: [
            { type: 'check', field: 'gridVisible', label: '显示网格线', hint: '关闭后背景不再显示交叉线' },
            { type: 'colorOpacity', field: 'gridColor', opacityField: 'gridOpacity', label: '网格颜色' },
            {
              type: 'select', field: 'gridStyle', label: '网格线型',
              options: [{ v: 0, label: '实线' }, { v: 2, label: '虚线' }, { v: 1, label: '点线' }, { v: 3, label: '长虚线' }, { v: 4, label: '稀疏点线' }]
            }
          ]
        },
        {
          title: '边框',
          hint: '坐标轴、窗格分隔线共用的颜色。',
          items: [
            { type: 'color', field: 'axisColor', label: '坐标轴 / 分隔线' }
          ]
        }
      ]
    },
    {
      id: 'candles', label: 'K线',
      sections: [
        {
          title: '实体',
          items: [
            { type: 'colorOpacity', field: 'upColor', opacityField: 'upOpacity', label: '上涨' },
            { type: 'colorOpacity', field: 'downColor', opacityField: 'downOpacity', label: '下跌' }
          ]
        },
        {
          title: '边框',
          hint: '“跟随涨跌颜色”开启时取实体色；不透明度始终单独生效。',
          items: [
            { type: 'check', field: 'borderVisible', label: '显示边框' },
            { type: 'check', field: 'borderFollow', label: '跟随涨跌颜色' },
            {
              type: 'colorOpacity', field: 'borderColor', opacityField: 'borderOpacity', label: '边框颜色',
              enabledWhen: { field: 'borderFollow', value: false }
            }
          ]
        },
        {
          title: '影线',
          hint: '引线（上下影线）可以单独设置颜色与不透明度。',
          items: [
            { type: 'check', field: 'wickVisible', label: '显示影线' },
            { type: 'check', field: 'wickFollow', label: '跟随涨跌颜色' },
            {
              type: 'colorOpacity', field: 'wickColor', opacityField: 'wickOpacity', label: '影线颜色',
              enabledWhen: { field: 'wickFollow', value: false }
            }
          ]
        },
        {
          title: '成交量 / 最新价',
          hint: '成交量柱颜色跟随上涨 / 下跌实体色。',
          items: [
            { type: 'range', field: 'volumeOpacity', label: '成交量不透明度', min: 0, max: 1, step: 0.01 },
            { type: 'check', field: 'priceLineVisible', label: '显示最新价线' },
            {
              type: 'color', field: 'priceLineColor', label: '最新价线颜色',
              enabledWhen: { field: 'priceLineVisible', value: true }
            }
          ]
        }
      ]
    },
    {
      id: 'crosshair', label: '十字光标',
      sections: [
        {
          title: '十字光标',
          items: [
            { type: 'check', field: 'crosshairVisible', label: '显示十字光标' },
            { type: 'colorOpacity', field: 'crosshairColor', opacityField: 'crosshairOpacity', label: '线条颜色' },
            {
              type: 'select', field: 'crosshairStyle', label: '线型',
              options: [{ v: 0, label: '实线' }, { v: 2, label: '虚线' }, { v: 3, label: '长虚线' }, { v: 1, label: '点线' }, { v: 4, label: '稀疏点线' }]
            },
            { type: 'color', field: 'crosshairLabelBg', label: '标签背景色' }
          ]
        }
      ]
    }
  ];

  var ui = { ready: false };
  var isOpen = false;
  var draft = null;
  var activeTab = 'appearance';
  var lastFocus = null;
  var hostOpts = {};
  var previewRaf = null;
  var recolorTimer = null;
  var lastVolumeSig = volumeSignature(current);
  var previewStyle = null;
  var volumeTouched = false;

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function fmtRange(field, value) {
    if (field === 'fontSize') return Math.round(value) + ' px';
    if (/Opacity$/.test(field)) return Math.round(value * 100) + '%';
    return String(value);
  }

  function colorInput(field, value, label) {
    var input = document.createElement('input');
    input.type = 'color';
    input.className = 'cs-color';
    input.dataset.field = field;
    input.setAttribute('aria-label', label || field);
    input.value = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000';
    return input;
  }

  function buildField(item) {
    var box = el('div', 'cs-field');
    var head, input, i;

    if (item.type === 'check') {
      var label = el('label', 'cs-check');
      input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.field = item.field;
      input.checked = !!draft[item.field];
      label.appendChild(input);
      label.appendChild(el('span', '', item.label));
      box.appendChild(label);
      if (item.hint) box.appendChild(el('div', 'cs-hint', item.hint));
      return box;
    }

    if (item.type === 'color') {
      head = el('div', 'cs-field-head');
      head.appendChild(el('span', 'cs-label', item.label));
      input = colorInput(item.field, draft[item.field], item.label);
      if (item.enabledWhen) {
        input.dataset.enabledWhen = item.enabledWhen.field + ':' + String(item.enabledWhen.value);
      }
      head.appendChild(input);
      box.appendChild(head);
      return box;
    }

    if (item.type === 'colorOpacity') {
      head = el('div', 'cs-field-head');
      head.appendChild(el('span', 'cs-label', item.label));
      input = colorInput(item.field, draft[item.field], item.label);
      if (item.enabledWhen) {
        input.dataset.enabledWhen = item.enabledWhen.field + ':' + String(item.enabledWhen.value);
      }
      head.appendChild(input);
      box.appendChild(head);

      var line = el('div', 'cs-range');
      var range = document.createElement('input');
      range.type = 'range';
      range.min = '0';
      range.max = '1';
      range.step = '0.01';
      range.dataset.field = item.opacityField;
      range.setAttribute('aria-label', item.label + '不透明度');
      range.value = String(draft[item.opacityField]);
      var val = el('span', 'cs-val', fmtRange(item.opacityField, draft[item.opacityField]));
      line.appendChild(range);
      line.appendChild(val);
      box.appendChild(line);
      return box;
    }

    if (item.type === 'range') {
      head = el('div', 'cs-field-head');
      head.appendChild(el('span', 'cs-label', item.label));
      head.appendChild(el('span', 'cs-val', fmtRange(item.field, draft[item.field])));
      box.appendChild(head);
      var line2 = el('div', 'cs-range');
      var range2 = document.createElement('input');
      range2.type = 'range';
      range2.min = String(item.min);
      range2.max = String(item.max);
      range2.step = String(item.step);
      range2.dataset.field = item.field;
      range2.setAttribute('aria-label', item.label);
      range2.value = String(draft[item.field]);
      line2.appendChild(range2);
      box.appendChild(line2);
      return box;
    }

    if (item.type === 'select') {
      head = el('div', 'cs-field-head');
      head.appendChild(el('span', 'cs-label', item.label));
      var sel = document.createElement('select');
      sel.className = 'cs-select';
      sel.dataset.field = item.field;
      sel.setAttribute('aria-label', item.label);
      item.options.forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = String(o.v);
        opt.textContent = o.label;
        sel.appendChild(opt);
      });
      sel.value = String(draft[item.field]);
      head.appendChild(sel);
      box.appendChild(head);
      return box;
    }

    return box;
  }

  function renderBody() {
    if (!ui.ready) return;
    var tab = TABS.filter(function (t) { return t.id === activeTab; })[0] || TABS[0];
    ui.body.innerHTML = '';
    tab.sections.forEach(function (section) {
      var sec = el('div', 'cs-section');
      if (section.title) sec.appendChild(el('div', 'cs-section-title', section.title));
      if (section.hint) sec.appendChild(el('div', 'cs-hint', section.hint));
      section.items.forEach(function (item) { sec.appendChild(buildField(item)); });
      ui.body.appendChild(sec);
    });
    syncDisabled();
  }

  function renderNav() {
    if (!ui.ready) return;
    Array.prototype.forEach.call(ui.nav.querySelectorAll('button'), function (b) {
      var on = b.dataset.tab === activeTab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function syncDisabled() {
    if (!ui.ready) return;
    Array.prototype.forEach.call(ui.body.querySelectorAll('[data-enabled-when]'), function (input) {
      var spec = String(input.dataset.enabledWhen).split(':');
      var expect = spec[1] === 'true';
      var on = !!draft[spec[0]] === expect;
      input.disabled = !on;
      var row = input.closest('.cs-field');
      if (row) row.classList.toggle('is-disabled', !on);
    });
  }

  function sameStyle(a, b) {
    var keys = Object.keys(DEFAULTS);
    for (var i = 0; i < keys.length; i++) {
      if (a[keys[i]] !== b[keys[i]]) return false;
    }
    return true;
  }

  function updatePresetSelect() {
    if (!ui.ready) return;
    var id = 'custom';
    PRESETS.forEach(function (p) { if (sameStyle(p.style, draft)) id = p.id; });
    ui.preset.value = id;
  }

  function onBodyInput(e) {
    var input = e.target;
    var field = input.dataset && input.dataset.field;
    if (!field) return;

    var value;
    if (input.type === 'checkbox') value = input.checked;
    else if (input.type === 'range') value = parseFloat(input.value);
    else if (input.tagName === 'SELECT') value = parseFloat(input.value);
    else value = input.value;

    var next = clone(draft);
    next[field] = value;
    draft = sanitize(next);
    if (field === 'upColor' || field === 'downColor' || field === 'volumeOpacity') {
      volumeTouched = true;
    }

    if (input.type === 'range') {
      var row = input.closest('.cs-field');
      var val = row && row.querySelector('.cs-val');
      if (val) val.textContent = fmtRange(field, draft[field]);
    }

    syncDisabled();
    updatePresetSelect();
    schedulePreview();
  }

  function onPresetChange() {
    var id = ui.preset.value;
    var preset = PRESETS.filter(function (p) { return p.id === id; })[0];
    if (!preset) return;
    draft = clone(preset.style);
    if (volumeSignature(draft) !== volumeSignature(current)) volumeTouched = true;
    renderBody();
    updatePresetSelect();
    schedulePreview();
  }

  function resetDraft() {
    draft = clone(DEFAULTS);
    if (volumeSignature(draft) !== volumeSignature(current)) volumeTouched = true;
    renderBody();
    updatePresetSelect();
    schedulePreview();
    if (hostOpts.onHint) hostOpts.onHint('已恢复默认样式，点击「应用」后保存');
  }

  function schedulePreview() {
    previewStyle = draft;
    if (previewRaf) return;
    previewRaf = requestAnimationFrame(function () {
      previewRaf = null;
      fluxPreview();
    });
  }

  function fluxPreview() {
    var panes = hostOpts.getPanes ? hostOpts.getPanes() : [];
    panes.forEach(function (p) { applyToPane(p, draft); });
    syncCss(draft);
    renderPreview(draft);
    scheduleVolumeRecolor();
  }

  function volumeSignature(style) {
    return style.upColor + '|' + style.downColor + '|' + style.volumeOpacity;
  }

  function scheduleVolumeRecolor() {
    if (recolorTimer) clearTimeout(recolorTimer);
    var sig = volumeSignature(draft);
    if (sig === lastVolumeSig) return;
    recolorTimer = setTimeout(function () {
      recolorTimer = null;
      var panes = hostOpts.getPanes ? hostOpts.getPanes() : [];
      // 数据量特别大时不跟着拖动实时重算整列成交量, 留到点应用时一次性处理
      var heavy = panes.some(function (p) { return p.bars && p.bars.length > 150000; });
      if (heavy) return;
      panes.forEach(function (p) { recolorVolume(p, draft); });
      lastVolumeSig = sig;
    }, 140);
  }

  function flushVolumeRecolor(style, force) {
    if (recolorTimer) { clearTimeout(recolorTimer); recolorTimer = null; }
    var sig = volumeSignature(style);
    // 目标成交量色和已写入的一致时无需整列重建;
    // force 只用于「取消」且预览期间确实改过成交量色的情况 (回放可能用预览色推进过)。
    if (!force && sig === lastVolumeSig) return;
    var panes = hostOpts.getPanes ? hostOpts.getPanes() : [];
    panes.forEach(function (p) { recolorVolume(p, style); });
    lastVolumeSig = sig;
  }

  function openDialog(opts) {
    if (isOpen) return;
    if (!initDialog()) return;
    hostOpts = opts || {};
    draft = clone(current);
    previewStyle = draft;
    volumeTouched = false;
    activeTab = 'appearance';
    lastFocus = document.activeElement;
    renderNav();
    renderBody();
    updatePresetSelect();
    ui.root.hidden = false;
    ui.body.scrollTop = 0;
    isOpen = true;
    document.addEventListener('keydown', onDocKey, true);
    window.addEventListener('resize', onWindowResize);
    requestAnimationFrame(function () {
      renderPreview(draft);
      if (ui.dialog && ui.dialog.focus) ui.dialog.focus();
    });
  }

  function closeUi() {
    if (!isOpen) return;
    isOpen = false;
    previewStyle = null;
    volumeTouched = false;
    ui.root.hidden = true;
    document.removeEventListener('keydown', onDocKey, true);
    window.removeEventListener('resize', onWindowResize);
    if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = null; }
    if (lastFocus && lastFocus.focus) {
      try { lastFocus.focus(); } catch (e) { /* ignore */ }
    }
    lastFocus = null;
  }

  function applyDraft() {
    if (!isOpen) return;
    current = sanitize(draft);
    var saved = save(current);
    if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = null; }
    applyAll(hostOpts.getPanes ? hostOpts.getPanes() : [], current);
    flushVolumeRecolor(current, false);
    closeUi();
    if (hostOpts.onApply) hostOpts.onApply(clone(current), saved);
  }

  function cancelDialog() {
    if (!isOpen) return;
    if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = null; }
    draft = clone(current);
    applyAll(hostOpts.getPanes ? hostOpts.getPanes() : [], current);
    flushVolumeRecolor(current, volumeTouched);
    closeUi();
    if (hostOpts.onCancel) hostOpts.onCancel(clone(current));
  }

  function onDocKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelDialog();
      return;
    }
    if (e.key !== 'Tab' || !ui.dialog) return;
    // 简单焦点循环: 设置弹窗打开时不让 Tab 跑到背后的图表上
    var nodes = ui.dialog.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])');
    var list = Array.prototype.filter.call(nodes, function (n) {
      return !n.disabled && n.offsetParent !== null;
    });
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === ui.dialog)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onWindowResize() {
    if (isOpen) renderPreview(draft);
  }

  function initDialog() {
    if (ui.ready) return true;
    var root = $('chartSettings');
    if (!root) return false;
    ui.root = root;
    ui.dialog = $('csDialog');
    ui.nav = $('csNav');
    ui.body = $('csBody');
    ui.preview = $('csPreview');
    ui.preset = $('csPreset');

    TABS.forEach(function (tab) {
      var b = document.createElement('button');
      b.type = 'button';
      b.dataset.tab = tab.id;
      b.textContent = tab.label;
      b.setAttribute('role', 'tab');
      b.addEventListener('click', function () {
        activeTab = tab.id;
        renderNav();
        renderBody();
        ui.body.scrollTop = 0;
      });
      ui.nav.appendChild(b);
    });

    PRESETS.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label;
      ui.preset.appendChild(o);
    });
    var custom = document.createElement('option');
    custom.value = 'custom';
    custom.textContent = '自定义';
    custom.disabled = true;
    ui.preset.appendChild(custom);

    ui.preset.addEventListener('change', onPresetChange);
    ui.body.addEventListener('input', onBodyInput);
    $('csClose').addEventListener('click', cancelDialog);
    $('csCancel').addEventListener('click', cancelDialog);
    $('csApply').addEventListener('click', applyDraft);
    $('csReset').addEventListener('click', resetDraft);
    ui.root.addEventListener('mousedown', function (e) {
      if (e.target === ui.root) cancelDialog();
    });

    ui.ready = true;
    return true;
  }

  /* ------------------------------------------------------------ 预览画布 */

  function dashOf(style) {
    switch (style) {
      case 1: return [2, 2];
      case 2: return [5, 4];
      case 3: return [8, 6];
      case 4: return [1, 4];
      default: return [];
    }
  }

  function renderPreview(style) {
    var canvas = ui.preview;
    if (!canvas) return;
    var rect = canvas.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 30) return;

    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = Math.round(rect.width);
    var h = Math.round(rect.height);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var r = resolved(style);
    var axisW = Math.min(46, Math.max(30, w * 0.11));
    var axisH = 18;
    var plotW = w - axisW;
    var plotH = h - axisH;
    if (plotW <= 0 || plotH <= 0) return;

    ctx.fillStyle = style.background;
    ctx.fillRect(0, 0, w, h);

    // 网格
    if (style.gridVisible) {
      ctx.strokeStyle = r.grid;
      ctx.lineWidth = 1;
      ctx.setLineDash(dashOf(style.gridStyle));
      var stepX = Math.max(24, plotW / 6);
      var stepY = Math.max(18, plotH / 4);
      for (var gx = stepX; gx < plotW; gx += stepX) {
        ctx.beginPath(); ctx.moveTo(Math.round(gx) + 0.5, 0); ctx.lineTo(Math.round(gx) + 0.5, plotH); ctx.stroke();
      }
      for (var gy = stepY; gy < plotH; gy += stepY) {
        ctx.beginPath(); ctx.moveTo(0, Math.round(gy) + 0.5); ctx.lineTo(plotW, Math.round(gy) + 0.5); ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    var priceH = plotH - 22;
    function py(v) { return 6 + (1 - v) * (priceH - 12); }

    // 成交量柱
    var volBars = [0.5, 0.72, 0.38, 0.86, 0.46, 0.66, 0.55];
    var barW = Math.max(4, Math.min(10, plotW / 16));
    var volBase = plotH - 3;
    for (var vi = 0; vi < volBars.length; vi++) {
      var vx = plotW * (0.14 + vi * 0.12);
      var vh = 3 + volBars[vi] * 14;
      ctx.fillStyle = vi % 2 ? r.volumeDown : r.volumeUp;
      ctx.fillRect(Math.round(vx - barW / 2), Math.round(volBase - vh), Math.round(barW), Math.round(vh));
    }

    // K 线
    var bars = [
      { o: 0.50, h: 0.64, l: 0.46, c: 0.60 },
      { o: 0.60, h: 0.68, l: 0.50, c: 0.53 },
      { o: 0.53, h: 0.55, l: 0.28, c: 0.33 },
      { o: 0.33, h: 0.47, l: 0.27, c: 0.43 },
      { o: 0.43, h: 0.52, l: 0.37, c: 0.39 },
      { o: 0.39, h: 0.60, l: 0.36, c: 0.55 },
      { o: 0.55, h: 0.76, l: 0.51, c: 0.70 }
    ];
    var stepC = plotW / (bars.length + 1);
    for (var i = 0; i < bars.length; i++) {
      var b = bars[i];
      var up = b.c >= b.o;
      var cx = Math.round(stepC * (i + 1));
      var yO = py(b.o), yC = py(b.c), yH = py(b.h), yL = py(b.l);
      if (style.wickVisible) {
        ctx.strokeStyle = up ? r.wickUp : r.wickDown;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx + 0.5, yH);
        ctx.lineTo(cx + 0.5, yL);
        ctx.stroke();
      }
      var top = Math.min(yO, yC);
      var bh = Math.max(2, Math.abs(yC - yO));
      ctx.fillStyle = up ? r.up : r.down;
      ctx.fillRect(Math.round(cx - barW / 2), Math.round(top), Math.round(barW), Math.round(bh));
      if (style.borderVisible) {
        ctx.strokeStyle = up ? r.borderUp : r.borderDown;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(cx - barW / 2) + 0.5, Math.round(top) + 0.5, Math.round(barW) - 1, Math.round(bh) - 1);
      }
    }

    // 最新价线
    if (style.priceLineVisible) {
      var plY = Math.round(priceH * 0.78) + 0.5;
      ctx.strokeStyle = style.priceLineColor;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(0, plY);
      ctx.lineTo(plotW, plY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 坐标轴文字 + 边框
    ctx.fillStyle = r.textMuted;
    ctx.font = Math.max(9, Math.min(14, style.fontSize)) + 'px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var t = 0; t < 4; t++) {
      var yy = (plotH / 5) * (t + 1);
      ctx.fillText((2620 - t * 30).toFixed(2), w - 5, yy);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ['10:00', '12:00', '14:00'].forEach(function (label, k) {
      ctx.fillText(label, plotW * (0.25 + k * 0.25), plotH + axisH / 2);
    });
    ctx.strokeStyle = r.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotW + 0.5, 0); ctx.lineTo(plotW + 0.5, plotH);
    ctx.moveTo(0, plotH + 0.5); ctx.lineTo(plotW, plotH + 0.5);
    ctx.stroke();

    // 十字光标
    if (style.crosshairVisible) {
      var chX = Math.round(plotW * 0.62) + 0.5;
      var chY = Math.round(priceH * 0.44) + 0.5;
      ctx.strokeStyle = r.cross;
      ctx.lineWidth = 1;
      ctx.setLineDash(dashOf(style.crosshairStyle));
      ctx.beginPath();
      ctx.moveTo(chX, 0); ctx.lineTo(chX, plotH);
      ctx.moveTo(0, chY); ctx.lineTo(plotW, chY);
      ctx.stroke();
      ctx.setLineDash([]);

      var labelText = readableOn(style.crosshairLabelBg);
      ctx.fillStyle = style.crosshairLabelBg;
      ctx.fillRect(plotW + 1, chY - 8, axisW - 1, 16);
      ctx.fillStyle = labelText;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('2588.00', plotW + axisW / 2, chY);

      ctx.fillStyle = style.crosshairLabelBg;
      ctx.fillRect(chX - 21, plotH + 1, 42, axisH - 1);
      ctx.fillStyle = labelText;
      ctx.fillText('12:35', chX, plotH + axisH / 2);
    }
  }

  /* ------------------------------------------------------------ 对外 API */

  window.ChartStyle = {
    DEFAULTS: DEFAULTS,
    PRESETS: PRESETS,
    get: function () { return clone(current); },
    getResolved: function () { return resolved(current); },
    isOpen: function () { return isOpen; },
    openDialog: openDialog,
    chartOptions: function () { return chartOptions(current); },
    candleOptions: function () { return candleOptions(current); },
    volumeColor: function (bar) { return volumeBarColor(activeVolumeStyle(), bar); },
    applyToPane: function (pane) { applyToPane(pane, current); },
    applyAll: function (panes) { applyAll(panes, current); },
    sanitize: sanitize
  };
})();
