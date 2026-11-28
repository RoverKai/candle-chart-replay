/* 画图层 —— 叠加在 lightweight-charts 上的 canvas, 用 {time, price} 锚点存储,
   因此随缩放/平移/回放自动跟随, 且可跨会话持久化。
   回放时锚点可以落在游标之后的未来 K 线上 (最多到完整数据最后一根),
   未来 K 线的 OHLC 仍然不参与吸附/预览, 避免提前暴露未来价格。 */
(function (global) {
  'use strict';

  var FIB_DEFAULT_LEVELS = [
    { ratio: 0,     color: '#787b86' },
    { ratio: 0.236, color: '#f23645' },
    { ratio: 0.382, color: '#ff9800' },
    { ratio: 0.5,   color: '#4caf50' },
    { ratio: 0.618, color: '#089981' },
    { ratio: 0.786, color: '#2962ff' },
    { ratio: 1,     color: '#787b86' }
  ];
  var HIT = 7;            // 命中测试像素半径
  var HANDLE = 3.5;       // 端点手柄半宽

  var DEFAULTS = {
    trend:   { color: '#2962ff', width: 1.6, opacity: 1 },
    ray:     { color: '#2962ff', width: 1.6, opacity: 1 },
    hline:   { color: '#f4a261', width: 1.4, opacity: 1 },
    vline:   { color: '#f4a261', width: 1.4, opacity: 1 },
    rect:    { color: '#26a69a', fillColor: '#26a69a', fillOpacity: 0.1, width: 1.4, opacity: 1 },
    fib:     { color: '#9598a1', width: 1.2, opacity: 1, levels: FIB_DEFAULT_LEVELS },
    text:    { color: '#e8eaf0', width: 1, opacity: 1 },
    measure: { color: '#4caf50', width: 1.4, opacity: 1 }
  };

  var SINGLE_POINT = { hline: 1, vline: 1, text: 1 };
  var STYLE_FIELDS = { color: 1, fillColor: 1, opacity: 1, fillOpacity: 1, width: 1 };

  function clamp01(v) {
    v = Number(v);
    if (!isFinite(v)) return 1;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /** 旧数据没存颜色时, 先按比例匹配默认调色板, 再按行号兜底 */
  function defaultLevelColor(ratio, index) {
    for (var i = 0; i < FIB_DEFAULT_LEVELS.length; i++) {
      if (Math.abs(FIB_DEFAULT_LEVELS[i].ratio - ratio) < 1e-9) return FIB_DEFAULT_LEVELS[i].color;
    }
    return FIB_DEFAULT_LEVELS[index] ? FIB_DEFAULT_LEVELS[index].color : '#9598a1';
  }

  /** 拷贝并规整斐波那契水平位, 兼容老数据里的纯数字数组 */
  function normalizeLevels(list) {
    return (list || []).map(function (lv, index) {
      var ratio = typeof lv === 'number' ? lv : (lv && lv.ratio);
      ratio = Number(ratio);
      var value = isFinite(ratio) ? ratio : 0;
      return {
        ratio: value,
        color: (lv && lv.color) || defaultLevelColor(value, index),
        visible: !lv || lv.visible !== false
      };
    });
  }

  /** 画线自己的水平位; 老数据没有 levels 字段时退回内置默认值。
      纯数字数组等旧格式在这里归一化一次并写回画线对象。 */
  function fibLevelsOf(d) {
    if (!d || !Array.isArray(d.levels)) return FIB_DEFAULT_LEVELS;
    for (var i = 0; i < d.levels.length; i++) {
      var lv = d.levels[i];
      if (!lv || typeof lv !== 'object' || lv.ratio === undefined || lv.ratio === null) {
        d.levels = normalizeLevels(d.levels);
        break;
      }
    }
    return d.levels;
  }

  function fmtRatio(v) {
    v = Number(v);
    if (!isFinite(v)) return '0';
    return v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  }

  function uid() {
    return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function dist2seg(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var len = dx * dx + dy * dy;
    var t = 0;
    if (len > 0) t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len));
    var cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  function DrawingLayer(opts) {
    this.host = opts.host;
    this.canvas = opts.canvas;
    this.chart = opts.chart;
    this.series = opts.series;
    this.getBars = opts.getBars;
    this.getCursor = opts.getCursor || null;
    this.onChange = opts.onChange || function () {};
    this.onHint = opts.onHint || function () {};
    this.onEdit = opts.onEdit || null;
    this.onToolChange = opts.onToolChange || function () {};
    this.defaults = null;       // setDefaults() 注入的每种工具的新画线默认样式

    this.ctx = this.canvas.getContext('2d');
    this.drawings = [];
    this.tool = 'cursor';
    this.selected = null;
    this.pending = null;        // 正在放置的第一个点
    this.hover = null;          // 鼠标位置 {x,y}
    this.hoverTarget = null;
    this.drag = null;           // {id, mode:'point'|'body', index, start, orig}
    this.ephemeral = null;      // 测量工具临时结果
    this.mods = { shift: false, ctrl: false };  // Shift 横向锁价 / Ctrl 吸附 OHLC
    this.undoStack = [];
    this.w = 0;
    this.h = 0;
    this._raf = 0;
    this._disposed = false;
    this._syncStopped = false;
    this._bind();
    this.resize();
  }

  /* ------------------------------------------------------------ 基础 */

  DrawingLayer.prototype.resize = function () {
    if (this._disposed) return;
    var dpr = window.devicePixelRatio || 1;
    var w = this.canvas.clientWidth || this.host.clientWidth;
    var h = this.canvas.clientHeight || this.host.clientHeight;
    if (!w || !h) return;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw();
  };

  DrawingLayer.prototype.requestRedraw = function () {
    var self = this;
    if (this._disposed || this._raf) return;
    this._raf = requestAnimationFrame(function () {
      self._raf = 0;
      self.redraw();
    });
  };

  DrawingLayer.prototype.xOf = function (time) {
    var ts = this.chart.timeScale();
    var x = ts.timeToCoordinate(time);
    if (x !== null && x !== undefined && !isNaN(x)) return x;

    // 回放时游标之后的 K 线还没渲染, timeToCoordinate 会返回 null。
    // 用完整数据里的下标 -> 逻辑坐标外推, 让"未来"的锚点也保持在图上。
    var bars = this.getBars ? this.getBars() : null;
    if (!bars || !bars.length) return null;

    var idx = -1;
    var lo = 0, hi = bars.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (bars[mid].time === time) { idx = mid; break; }
      if (bars[mid].time < time) lo = mid + 1; else hi = mid - 1;
    }
    if (idx < 0) return null;

    var cx = ts.logicalToCoordinate(idx);
    if (cx !== null && cx !== undefined && !isNaN(cx)) return cx;

    // 兜底: 按 barSpacing 从光标处线性外推
    var cur = this.getCursor ? this.getCursor() : bars.length - 1;
    var curBar = bars[Math.min(cur, bars.length - 1)];
    if (!curBar) return null;
    var cxCur = ts.timeToCoordinate(curBar.time);
    if (cxCur === null || cxCur === undefined) return null;
    var sp = 6;
    try { sp = ts.options().barSpacing || 6; } catch (e) { /* ignore */ }
    return cxCur + (idx - cur) * sp;
  };

  /** 绘图区宽度 (不含右侧价格轴) */
  DrawingLayer.prototype.plotWidth = function () {
    try {
      var w = this.chart.timeScale().width();
      if (w > 0) return w;
    } catch (e) { /* ignore */ }
    return this.w;
  };

  DrawingLayer.prototype.yOf = function (price) {
    var y = this.series.priceToCoordinate(price);
    return (y === null || y === undefined || isNaN(y)) ? null : y;
  };

  DrawingLayer.prototype.xyOf = function (pt) {
    var x = this.xOf(pt.time);
    var y = this.yOf(pt.price);
    if (x === null || y === null) return null;
    return { x: x, y: y };
  };

  /** 已播放范围的最后一根 K 线下标。只用于 Ctrl 吸附: 未来 K 线的 OHLC
      不参与查找, 避免提前暴露未来价格。
      getCursor 由 app 注入 pane.cursor: 初始 0, 回放/显示全部时始终是数值下标;
      只有数据未装载时可能为空, 此时还没有回放边界, 退回全量是安全的。
      注: 不能用 Math.min(hi, null), 那会把范围误钳到首根。 */
  DrawingLayer.prototype._playedLimit = function (bars) {
    var hi = bars.length - 1;
    if (!this.getCursor) return hi;
    var cur = this.getCursor();
    if (typeof cur !== 'number' || !isFinite(cur)) return hi;
    if (cur < 0) return -1;
    return Math.min(hi, Math.floor(cur));
  };

  /** 画线落点可用的最后一根 K 线下标: 完整数据的末尾。
      回放时游标之后的 K 线虽然还没渲染, 但数据已经在 pane.bars 里,
      因此起点/终点/拖动端点都可以落在未来 K 线上; 超出数据末尾时贴住最后一根。 */
  DrawingLayer.prototype._placeLimit = function (bars) {
    return bars.length - 1;
  };

  DrawingLayer.prototype.pointOf = function (x, y) {
    var bars = this.getBars() || [];
    if (!bars.length) return null;
    var limit = this._placeLimit(bars);
    if (limit < 0) return null;
    var logical = this.chart.timeScale().coordinateToLogical(x);
    if (logical === null || logical === undefined) return null;
    var idx = Math.round(logical);
    if (idx < 0) idx = 0;
    if (idx > limit) idx = limit;
    var price = this.series.coordinateToPrice(y);
    if (price === null || price === undefined) return null;
    return { time: bars[idx].time, price: price };
  };

  /** 按时间取已播放范围内的 K 线 (Ctrl 吸附专用)。
      回放游标之后的 bar 不参与吸附, 避免把未来 K 线的 OHLC 泄漏到预览/锚点;
      落点本身允许落在未来 K 线上, 见 pointOf/_placeLimit。 */
  DrawingLayer.prototype._barForTime = function (time) {
    var bars = this.getBars ? this.getBars() : null;
    if (!bars || !bars.length) return null;
    var hi = this._playedLimit(bars);
    if (hi < 0) return null;
    var lo = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (bars[mid].time === time) return bars[mid];
      if (bars[mid].time < time) lo = mid + 1; else hi = mid - 1;
    }
    return null;
  };

  /** 鼠标纵坐标离这根 K 线的 open/high/low/close 哪个最近 */
  DrawingLayer.prototype._nearestOHLC = function (bar, y) {
    var levels = [
      { kind: 'O', price: bar.open },
      { kind: 'H', price: bar.high },
      { kind: 'L', price: bar.low },
      { kind: 'C', price: bar.close }
    ];
    var best = null, bestD = Infinity;
    for (var i = 0; i < levels.length; i++) {
      var py = this.yOf(levels[i].price);
      if (py === null) continue;
      var d = Math.abs(y - py);
      if (d < bestD) { bestD = d; best = levels[i]; }
    }
    if (!best) return null;
    return { kind: best.kind, price: best.price };
  };

  /** 把像素落点解析成锚点:
      - allowCtrl 且按住 Ctrl: 吸附到鼠标所在 K 线最近的 O/H/L/C
      - 按住 Shift: 价格锁在 lockPrice 上, 只让时间跟着鼠标走 (横向移动)
      两个键同时按住时 Shift 优先。返回 {pt, snap?, lock?}; 没有有效数据时返回 null。 */
  DrawingLayer.prototype._resolvePoint = function (x, y, lockPrice, allowCtrl) {
    var pt = this.pointOf(x, y);
    if (!pt) return null;
    var mods = this.mods || {};
    // 两个键同时按住时以横向锁定为准, 避免吸附把价格悄悄拉走
    if (mods.shift && lockPrice !== null && lockPrice !== undefined) {
      return { pt: { time: pt.time, price: lockPrice }, lock: true };
    }
    if (allowCtrl && mods.ctrl) {
      var bar = this._barForTime(pt.time);
      if (bar) {
        var snap = this._nearestOHLC(bar, y);
        if (snap) return { pt: { time: pt.time, price: snap.price }, snap: snap };
      }
    }
    return { pt: pt };
  };

  DrawingLayer.prototype.paneHeight = function () {
    try {
      var panes = this.chart.panes();
      if (panes && panes.length && panes[0].getHeight) return panes[0].getHeight();
    } catch (e) { /* ignore */ }
    return this.h;
  };

  /* ------------------------------------------------------------ 数据 */

  DrawingLayer.prototype.setDrawings = function (list) {
    this.drawings = (list || []).filter(function (d) { return d && d.type && d.pts && d.pts.length; })
      .map(function (d) {
        if (d.type === 'fib' && Array.isArray(d.levels)) d.levels = normalizeLevels(d.levels);
        return d;
      });
    this.selected = null;
    this.pending = null;
    this.redraw();
  };

  DrawingLayer.prototype.getDrawings = function () {
    return this.drawings.filter(function (d) { return d.type !== 'measure'; });
  };

  /**
   * 外部(工具栏 / 窗格切换)设置工具: 调用方自己负责同步 UI, 不触发 onToolChange。
   * 画线层内部回退到光标模式的场景走 _resetToCursor(), 它会通知外部。
   */
  DrawingLayer.prototype.setTool = function (tool) {
    this._applyTool(tool, false);
  };

  /** 画完一条线、按 Esc 等场景: 回到光标模式, 并通知工具栏同步 */
  DrawingLayer.prototype._resetToCursor = function () {
    this._applyTool('cursor', true);
  };

  DrawingLayer.prototype._applyTool = function (tool, notify) {
    var changed = this.tool !== tool;
    this.tool = tool;
    this.pending = null;
    this.ephemeral = null;
    if (tool !== 'cursor') this.selected = null;
    this.host.style.cursor = tool === 'cursor' ? '' : 'crosshair';
    this.redraw();
    if (changed && notify) this.onToolChange(tool);
  };

  DrawingLayer.prototype._snapshot = function () {
    this.undoStack.push(JSON.stringify(this.getDrawings()));
    if (this.undoStack.length > 60) this.undoStack.shift();
  };

  DrawingLayer.prototype.undo = function () {
    if (!this.undoStack.length) return false;
    var state = JSON.parse(this.undoStack.pop());
    this.drawings = state;
    this.selected = null;
    this.pending = null;
    this.redraw();
    this.onChange();
    return true;
  };

  DrawingLayer.prototype.clear = function () {
    if (!this.drawings.length) return;
    this._snapshot();
    this.drawings = [];
    this.selected = null;
    this.pending = null;
    this.redraw();
    this.onChange();
  };

  DrawingLayer.prototype.deleteSelected = function () {
    if (!this.selected) return false;
    var id = this.selected;
    this._snapshot();
    this.drawings = this.drawings.filter(function (d) { return d.id !== id; });
    this.selected = null;
    this.redraw();
    this.onChange();
    return true;
  };

  DrawingLayer.prototype._add = function (type, pts, extra) {
    this._snapshot();
    var d = Object.assign({ id: uid(), type: type, pts: pts }, this._styleFor(type));
    if (d.levels) d.levels = normalizeLevels(d.levels);
    if (extra) Object.assign(d, extra);
    if (d.type === 'rect' && !d.fillColor) d.fillColor = d.color;
    this.drawings.push(d);
    this.selected = d.id;
    this.onChange();
    this.redraw();
    return d;
  };

  /** 每种工具的新画线样式: 内置默认值 + 用户保存的覆盖项 */
  DrawingLayer.prototype._styleFor = function (type) {
    var base = DEFAULTS[type] || { color: '#2962ff', width: 1.4, opacity: 1 };
    var custom = (this.defaults && this.defaults[type]) || null;
    var out = Object.assign({}, base, custom || {});
    if (out.levels) out.levels = normalizeLevels(out.levels);
    if (type === 'rect' && !out.fillColor) out.fillColor = out.color;
    return out;
  };

  /** all: { trend: {...}, rect: {...}, fib: { ..., levels: [...] } }; 只影响之后新建的画线 */
  DrawingLayer.prototype.setDefaults = function (all) {
    var next = {};
    for (var type in DEFAULTS) {
      var custom = all && all[type];
      next[type] = Object.assign({}, DEFAULTS[type], (custom && typeof custom === 'object') ? custom : {});
      if (type === 'fib') {
        next[type].levels = normalizeLevels(
          Array.isArray(next[type].levels) ? next[type].levels : FIB_DEFAULT_LEVELS
        );
      }
      if (type === 'rect' && !next[type].fillColor) next[type].fillColor = next[type].color;
    }
    this.defaults = next;
    // 正在放置的斐波那契预览也应立刻换用新默认水平位
    this.redraw();
  };

  DrawingLayer.prototype.getDrawing = function (id) {
    return this._find(id);
  };

  DrawingLayer.prototype.select = function (id) {
    if (!this._find(id)) return false;
    this.selected = id;
    this.redraw();
    return true;
  };

  DrawingLayer.prototype.getFibLevels = function (id) {
    var d = this._find(id);
    return d ? normalizeLevels(fibLevelsOf(d)) : null;
  };

  /** 用户开始编辑样式前记一次撤销点, 之后连续的 input 事件不再堆栈 */
  DrawingLayer.prototype.beginStyleEdit = function (id) {
    if (!this._find(id)) return false;
    this._snapshot();
    return true;
  };

  DrawingLayer.prototype.updateStyle = function (id, patch) {
    var d = this._find(id);
    if (!d || !patch) return false;
    for (var key in STYLE_FIELDS) {
      if (patch[key] !== undefined) d[key] = patch[key];
    }
    if (patch.opacity !== undefined) d.opacity = clamp01(patch.opacity);
    if (patch.fillOpacity !== undefined) d.fillOpacity = clamp01(patch.fillOpacity);
    if (patch.levels !== undefined) d.levels = normalizeLevels(patch.levels);
    this.redraw();
    this.onChange();
    return true;
  };

  DrawingLayer.prototype.hitAt = function (x, y) {
    return this._hitTest(x, y);
  };

  /* ------------------------------------------------------------ 事件 */

  DrawingLayer.prototype._bind = function () {
    var self = this;
    var host = this.host;

    // 注意: lightweight-charts 内部监听的是 mousedown, 因此这里必须用 mousedown
    // (capture 阶段 + stopPropagation) 才能真正拦住它的平移/缩放。
    this._onDown = function (e) {
      if (e.button !== 0) return;
      var r = host.getBoundingClientRect();
      var x = e.clientX - r.left;
      var y = e.clientY - r.top;
      self.mods.shift = !!e.shiftKey;
      // Ctrl 或 macOS 的 ⌘(Meta) 都视为吸附修饰键
      self.mods.ctrl = !!(e.ctrlKey || e.metaKey);

      if (self.tool === 'cursor') {
        // 交易层的控件 (如止损按钮/止损线) 优先
        if (self.interceptor && self.interceptor.hitTest(x, y)) {
          e.preventDefault();
          e.stopPropagation();
          self._interceptorDrag = true;
          self.interceptor.dragStart(x, y);
          self.redraw();
          return;
        }
        var hit = self._hitTest(x, y);
        if (!hit) {
          if (self.selected) { self.selected = null; self.redraw(); }
          return;                       // 不拦截, 交给图表平移
        }
        e.preventDefault();
        e.stopPropagation();
        self.selected = hit.id;
        self._snapshot();
        var d = self._find(hit.id);
        var twoPoint = d && d.pts.length >= 2;
        self.drag = {
          id: hit.id,
          mode: hit.mode,
          index: hit.index,
          start: { x: x, y: y },
          orig: JSON.parse(JSON.stringify(d.pts)),
          // 两点工具端点 → Ctrl 吸附; 线体 / 单点工具(文字、水平线、垂直线) → Ctrl 仍是复制
          clone: !!(e.ctrlKey || e.metaKey) && (hit.mode === 'body' || !twoPoint),
          canSnap: hit.mode === 'point' && twoPoint,
          moved: false
        };
        self.redraw();
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      if (self.tool === 'measure') {
        var measureStart = self._resolvePoint(x, y, null, true);
        self._measureStart = measureStart ? measureStart.pt : null;
        self.ephemeral = null;
        self.drag = { measure: true, start: { x: x, y: y }, moved: false };
        return;
      }

      var res = self._resolvePoint(x, y, self.pending ? self.pending.price : null, true);
      if (!res) return;
      var pt = res.pt;

      if (SINGLE_POINT[self.tool]) {
        if (self.tool === 'text') {
          self._inlineEdit(x, y, pt);
          self.pending = null;
          self._resetToCursor();
          return;
        }
        self._add(self.tool, [pt]);
        self.pending = null;
        self._resetToCursor();
        return;
      }

      if (!self.pending) {
        self.pending = pt;
        self.redraw();
      } else {
        self._add(self.tool, [self.pending, pt]);
        self.pending = null;
        self._resetToCursor();
      }
    };

    this._onMove = function (e) {
      var r = host.getBoundingClientRect();
      var x = e.clientX - r.left;
      var y = e.clientY - r.top;
      self.mods.shift = !!e.shiftKey;
      self.mods.ctrl = !!(e.ctrlKey || e.metaKey);

      if (!self.drag && !self.pending && !self._interceptorDrag) {
        if (x < 0 || y < 0 || x > self.w || y > self.h) {
          if (self.hover) { self.hover = null; self.hoverTarget = null; self.requestRedraw(); }
          return;
        }
      }
      self.hover = { x: x, y: y };

      if (self._interceptorDrag) {
        self.interceptor.dragMove(x, y);
        self.requestRedraw();
        return;
      }

      if (self.drag) {
        self.drag.moved = true;
        self._updateDrag(x, y);
        return;
      }

      if (self.tool === 'cursor' && self.interceptor) {
        var ih = self.interceptor.hitTestEx
          ? self.interceptor.hitTestEx(x, y)
          : (self.interceptor.hitTest(x, y) ? { kind: 'line' } : null);
        if (ih) {
          host.style.cursor = /-remove$/.test(ih.kind) ? 'pointer' : 'ns-resize';
          return;
        }
      }

      var hovering = self.tool === 'cursor' ? self._hitTest(x, y) : null;
      var changed = false;
      if ((hovering && hovering.id) !== (self.hoverTarget && self.hoverTarget.id)) {
        self.hoverTarget = hovering;
        changed = true;
      }
      var cloneKey = e.ctrlKey || e.metaKey;
      var hoverDraw = hovering ? self._find(hovering.id) : null;
      var copyHover = cloneKey && hovering &&
        (hovering.mode === 'body' || (hoverDraw && hoverDraw.pts.length < 2));
      host.style.cursor = self.tool !== 'cursor'
        ? 'crosshair'
        : (hovering
          ? (copyHover ? 'copy' : (hovering.mode === 'point' ? 'nwse-resize' : 'move'))
          : '');

      if (self.pending || changed || (self.tool !== 'cursor' && self.mods.ctrl)) self.requestRedraw();
    };

    this._onUp = function () {
      if (self._interceptorDrag) {
        self._interceptorDrag = false;
        self.interceptor.dragEnd();
        self.redraw();
        return;
      }
      if (self.drag && self.drag.measure) {
        self.drag = null;
        if (self.ephemeral) {
          self._measureStart = null;
        }
        self.redraw();
        return;
      }
      if (self.drag) {
        self.drag = null;
        self.onChange();
        self.redraw();
      }
    };

    this._onLeave = function () {
      self.hover = null;
      if (!self.pending) self.requestRedraw();
    };

    // 双击已选/未选中的画线都打开样式面板 (TradingView 习惯)
    this._onDblClick = function (e) {
      if (self.tool !== 'cursor') return;
      var target = e.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      var r = host.getBoundingClientRect();
      var hit = self._hitTest(e.clientX - r.left, e.clientY - r.top);
      if (!hit) return;
      var hitDrawing = self._find(hit.id);
      if (!hitDrawing || hitDrawing.type === 'measure') return;
      e.preventDefault();
      e.stopPropagation();
      self.selected = hit.id;
      self.redraw();
      if (self.onEdit) self.onEdit(hit.id);
    };

    host.addEventListener('mousedown', this._onDown, true);
    window.addEventListener('mousemove', this._onMove, true);
    window.addEventListener('mouseup', this._onUp, true);
    host.addEventListener('mouseleave', this._onLeave, true);
    host.addEventListener('dblclick', this._onDblClick, true);

    // 修饰键按下/松开本身不会产生 mousemove, 但预览和拖动结果要立刻跟着变
    this._onMods = function (e) {
      var shift = !!e.shiftKey;
      var ctrl = !!(e.ctrlKey || e.metaKey);
      if (shift === self.mods.shift && ctrl === self.mods.ctrl) return;
      self.mods.shift = shift;
      self.mods.ctrl = ctrl;
      if (self.drag) {
        // 还没真正移动时不重算落点, 避免按下端点后碰一下修饰键就把锚点挪走
        if (self.hover && self.drag.moved && !self.drag.clone) {
          self._updateDrag(self.hover.x, self.hover.y);
        } else {
          self.requestRedraw();
        }
      } else if (self.pending || self.tool !== 'cursor') {
        self.requestRedraw();
      }
    };
    window.addEventListener('keydown', this._onMods, true);
    window.addEventListener('keyup', this._onMods, true);
  };

  /** 窗格销毁时解除全局监听并停掉 rAF 循环, 防止旧实例继续响应按键/重绘 */
  DrawingLayer.prototype.dispose = function () {
    if (this._disposed) return;
    this._disposed = true;
    this._syncStopped = true;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    if (this._syncTimer) { clearTimeout(this._syncTimer); this._syncTimer = 0; }
    if (this._onTimeRangeChange) {
      try { this.chart.timeScale().unsubscribeVisibleLogicalRangeChange(this._onTimeRangeChange); } catch (e) { }
      this._onTimeRangeChange = null;
    }
    if (this._onViewWheel) {
      this.host.removeEventListener('wheel', this._onViewWheel);
      this.host.removeEventListener('pointerdown', this._onViewDown);
      this.host.removeEventListener('pointermove', this._onViewDrag);
      this.host.removeEventListener('dblclick', this._onViewDown, true);
      this._onViewWheel = this._onViewDown = this._onViewDrag = null;
    }
    if (this._onVisibility) {
      document.removeEventListener('visibilitychange', this._onVisibility);
      this._onVisibility = null;
    }
    this.host.removeEventListener('mousedown', this._onDown, true);
    window.removeEventListener('mousemove', this._onMove, true);
    window.removeEventListener('mouseup', this._onUp, true);
    this.host.removeEventListener('mouseleave', this._onLeave, true);
    this.host.removeEventListener('dblclick', this._onDblClick, true);
    window.removeEventListener('keydown', this._onMods, true);
    window.removeEventListener('keyup', this._onMods, true);
    this.drag = null;
    this.pending = null;
    this.hover = null;
  };

  /** 拖动中的落点计算 (鼠标移动、或按住/松开修饰键时调用) */
  DrawingLayer.prototype._updateDrag = function (x, y) {
    if (!this.drag) return;

    if (this.drag.measure) {
      var end = this._resolvePoint(x, y, this._measureStart ? this._measureStart.price : null, true);
      if (this._measureStart && end) {
        this.ephemeral = { type: 'measure', pts: [this._measureStart, end.pt], color: '#4caf50', width: 1.4 };
      }
      this.requestRedraw();
      return;
    }

    // 第一次真正移动时才生成副本, 这样 Ctrl + 单击不会凭空多出一条线
    if (this.drag.clone) {
      var src = this._find(this.drag.id);
      if (!src) { this.drag = null; return; }
      var copy = JSON.parse(JSON.stringify(src));
      copy.id = uid();
      this.drawings.push(copy);
      this.selected = copy.id;
      this.drag.id = copy.id;
      this.drag.clone = false;
      this.onHint('已复制一份，可继续拖动');
    }

    if (this.drag.mode === 'body') {
      var anchor0 = this.xyOf(this.drag.orig[0]);
      var anchor1 = this.xyOf(this.drag.orig[this.drag.orig.length - 1]);
      var now0 = this.pointOf(x, y);
      if (now0 && anchor0 && anchor1) {
        var cur0 = this.pointOf(this.drag.start.x, this.drag.start.y);
        if (cur0) {
          var dt = now0.time - cur0.time;
          // Shift: 整条只水平平移, 价格不动
          var dp = this.mods.shift ? 0 : now0.price - cur0.price;
          var d = this._find(this.drag.id);
          d.pts = this.drag.orig.map(function (p) {
            return { time: p.time + dt, price: p.price + dp };
          });
        }
      }
    } else {
      // 拖端点: Ctrl 吸附 OHLC, Shift 锁价 (两者同时按住时 Shift 优先)
      // 第四个参数只表示「允许 Ctrl 吸附」, 未按 Ctrl 时仍按鼠标位置自由落位
      var orig = this.drag.orig[this.drag.index];
      var np = this._resolvePoint(x, y, orig ? orig.price : null, this.drag.canSnap);
      if (np) {
        var dd = this._find(this.drag.id);
        dd.pts[this.drag.index] = np.pt;
      }
    }
    this.requestRedraw();
  };

  DrawingLayer.prototype._find = function (id) {
    for (var i = 0; i < this.drawings.length; i++) if (this.drawings[i].id === id) return this.drawings[i];
    return null;
  };

  DrawingLayer.prototype._hitTest = function (x, y) {
    for (var i = this.drawings.length - 1; i >= 0; i--) {
      var d = this.drawings[i];
      if (d.type === 'measure') continue;
      // 先测端点手柄
      for (var k = 0; k < d.pts.length; k++) {
        var p = this.xyOf(d.pts[k]);
        if (p && Math.hypot(x - p.x, y - p.y) <= HIT + 2) {
          return { id: d.id, mode: 'point', index: k };
        }
      }
      if (this._hitBody(d, x, y)) return { id: d.id, mode: 'body', index: -1 };
    }
    return null;
  };

  DrawingLayer.prototype._hitBody = function (d, x, y) {
    var self = this;
    var xy = d.pts.map(function (p) { return self.xyOf(p); });
    if (xy.some(function (p) { return !p; })) {
      if (d.type === 'hline' || d.type === 'vline') {
        // 单点画线只要一个点有效即可
      } else if (d.type !== 'rect') {
        return false;
      }
    }
    if (d.type === 'hline') {
      var y0 = xy[0] ? xy[0].y : null;
      return y0 !== null && Math.abs(y - y0) <= HIT;
    }
    if (d.type === 'vline') {
      var x0 = xy[0] ? xy[0].x : null;
      return x0 !== null && Math.abs(x - x0) <= HIT;
    }
    if (d.type === 'rect') {
      if (!xy[0] || !xy[1]) return false;
      var l = Math.min(xy[0].x, xy[1].x), r = Math.max(xy[0].x, xy[1].x);
      var t = Math.min(xy[0].y, xy[1].y), b = Math.max(xy[0].y, xy[1].y);
      var nearEdge = (Math.abs(x - l) <= HIT && y >= t - HIT && y <= b + HIT) ||
                     (Math.abs(x - r) <= HIT && y >= t - HIT && y <= b + HIT) ||
                     (Math.abs(y - t) <= HIT && x >= l - HIT && x <= r + HIT) ||
                     (Math.abs(y - b) <= HIT && x >= l - HIT && x <= r + HIT);
      var inside = x > l && x < r && y > t && y < b;
      return nearEdge || inside;
    }
    if (!xy[0] || !xy[1]) return false;
    if (d.type === 'fib') {
      var yA = xy[0].y, yB = xy[1].y, x1 = Math.min(xy[0].x, xy[1].x), x2 = Math.max(xy[0].x, xy[1].x);
      var lvls = fibLevelsOf(d).filter(function (lv) { return lv.visible !== false && isFinite(Number(lv.ratio)); });
      return x >= x1 - HIT && x <= x2 + HIT && (Math.abs(y - yA) <= HIT || Math.abs(y - yB) <= HIT ||
        lvls.some(function (lv) { return Math.abs(y - (yA + (yB - yA) * Number(lv.ratio))) <= HIT; }));
    }
    return dist2seg(x, y, xy[0].x, xy[0].y, xy[1].x, xy[1].y) <= HIT;
  };

  /* 画布内即时输入文字 (避免 window.prompt 阻塞) */
  DrawingLayer.prototype._inlineEdit = function (x, y, anchor) {
    var self = this;
    var pt = anchor || this.pointOf(x, y);
    if (!pt) return;
    var input = document.createElement('input');
    input.className = 'draw-text-input';
    input.style.left = Math.max(0, x) + 'px';
    input.style.top = Math.max(0, y - 13) + 'px';
    input.placeholder = '输入文字后回车';
    this.host.appendChild(input);

    var done = false;
    function finish(commit) {
      if (done) return;
      done = true;
      var val = (input.value || '').trim();
      if (input.parentNode) input.parentNode.removeChild(input);
      if (commit && val) self._add('text', [pt], { text: val });
      else self.redraw();
    }

    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', function () { finish(true); });
    input.addEventListener('mousedown', function (e) { e.stopPropagation(); });

    setTimeout(function () { input.focus(); }, 0);
  };

  /* ------------------------------------------------------------ 渲染 */

  DrawingLayer.prototype.redraw = function () {
    var ctx = this.ctx;
    if (this._disposed || !ctx || !this.w) return;
    this.redrawCount = (this.redrawCount || 0) + 1;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.plotWidth(), Math.max(0, this.paneHeight()));
    ctx.clip();

    for (var i = 0; i < this.drawings.length; i++) {
      this._paint(this.drawings[i], false);
    }
    if (this.extraPainter) {
      try { this.extraPainter(ctx, this); } catch (e) { /* 交易层异常不影响画线 */ }
    }
    if (this.ephemeral) this._paint(this.ephemeral, true);

    if (this.pending && this.hover) {
      this._paintPreview();
    } else if (this.hover && this.tool !== 'cursor' && this.mods.ctrl) {
      // 还没落第一点时也提示 Ctrl 会吸到哪
      var hov = this._resolvePoint(this.hover.x, this.hover.y, null, true);
      var hb = hov ? this.xyOf(hov.pt) : null;
      if (hov && hov.snap && hb) this._paintSnap(hov, hb);
    }
    if (this.drag && this.drag.canSnap && this.hover && this.mods.ctrl) {
      // 拖端点时同样标出会吸附到哪个价位
      var dOrig = this.drag.orig[this.drag.index];
      var dRes = this._resolvePoint(this.hover.x, this.hover.y, dOrig ? dOrig.price : null, true);
      var dXY = dRes ? this.xyOf(dRes.pt) : null;
      if (dRes && dRes.snap && dXY) this._paintSnap(dRes, dXY);
    }
    ctx.restore();
  };

  DrawingLayer.prototype._paint = function (d, ephemeral) {
    var self = this;
    var ctx = this.ctx;
    var color = d.type === 'measure' ? (d.pts.length === 2 && d.pts[1].price >= d.pts[0].price ? '#26a69a' : '#ef5350') : (d.color || '#2962ff');
    var selected = !ephemeral && this.selected === d.id;
    var xy = d.pts.map(function (p) { return self.xyOf(p); });

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.globalAlpha = clamp01(d.opacity === undefined || d.opacity === null ? 1 : d.opacity);
    ctx.strokeStyle = color;
    ctx.lineWidth = d.width || 1.4;

    if (d.type === 'hline') {
      // 水平线只跟价格有关, 与锚点时间无关 —— 回放到锚点之前也应整条显示
      var y = this.yOf(d.pts[0].price);
      if (y === null) { ctx.restore(); return; }
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.plotWidth(), y); ctx.stroke();
      this._tag(d.pts[0].price.toFixed(this.digits || 2), this.plotWidth() - 6, y, color, 'right');
    } else if (d.type === 'vline') {
      var x = xy[0] ? xy[0].x : null;
      if (x === null) { ctx.restore(); return; }
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.paneHeight()); ctx.stroke();
      this._tag(this._fmtTime(d.pts[0].time), x + 5, 14, color, 'left');
    } else if (d.type === 'text') {
      if (!xy[0]) { ctx.restore(); return; }
      this._text(d.text || '文字', xy[0].x, xy[0].y, color);
    } else if (d.type === 'rect') {
      if (!xy[0] || !xy[1]) { ctx.restore(); return; }
      var rx = Math.min(xy[0].x, xy[1].x), ry = Math.min(xy[0].y, xy[1].y);
      var rw = Math.abs(xy[1].x - xy[0].x), rh = Math.abs(xy[1].y - xy[0].y);
      var fillOpacity = d.fillOpacity === undefined || d.fillOpacity === null ? 0.1 : clamp01(d.fillOpacity);
      ctx.fillStyle = this._alpha(d.fillColor || color, fillOpacity);
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeRect(rx, ry, rw, rh);
    } else if (d.type === 'fib') {
      if (!xy[0] || !xy[1]) { ctx.restore(); return; }
      this._paintFib(d, xy[0], xy[1]);
    } else if (d.type === 'measure') {
      if (!xy[0] || !xy[1]) { ctx.restore(); return; }
      this._paintMeasure(d, xy[0], xy[1], color);
    } else {
      if (!xy[0] || !xy[1]) { ctx.restore(); return; }
      var p0 = xy[0], p1 = xy[1];
      if (d.type === 'ray') {
        var dx = p1.x - p0.x, dy = p1.y - p0.y;
        var k = (dx === 0) ? 1 : (this.w - p0.x) / dx;
        if (dx < 0) k = (0 - p0.x) / dx;
        if (!isFinite(k) || k < 1) k = 1;
        p1 = { x: p0.x + dx * k, y: p0.y + dy * k };
      }
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }

    if (selected) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#2962ff';
      ctx.lineWidth = 1.5;
      d.pts.forEach(function (p) {
        var s = self.xyOf(p);
        if (!s) return;
        ctx.beginPath();
        ctx.rect(s.x - HANDLE, s.y - HANDLE, HANDLE * 2, HANDLE * 2);
        ctx.fill();
        ctx.stroke();
      });
    }
    ctx.restore();
  };

  DrawingLayer.prototype._paintPreview = function () {
    var ctx = this.ctx;
    var a = this.xyOf(this.pending);
    if (!a) return;
    var res = this._resolvePoint(this.hover.x, this.hover.y, this.pending.price, true);
    if (!res) return;
    var b = this.xyOf(res.pt);
    if (!b) return;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(41,98,255,.9)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    if (this.tool === 'rect') {
      ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else if (this.tool === 'fib') {
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      var previewLevels = normalizeLevels(
        (this.defaults && this.defaults.fib && this.defaults.fib.levels) || FIB_DEFAULT_LEVELS
      );
      for (var i = 0; i < previewLevels.length; i++) {
        if (previewLevels[i].visible === false) continue;
        var yy = a.y + (b.y - a.y) * previewLevels[i].ratio;
        ctx.moveTo(Math.min(a.x, b.x), yy); ctx.lineTo(Math.max(a.x, b.x), yy);
      }
    } else {
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.restore();
    if (res.snap) this._paintSnap(res, b);
  };

  /** Ctrl 吸附时在目标价位上画个标记, 松手前就能看到会落在哪 */
  DrawingLayer.prototype._paintSnap = function (res, b) {
    var ctx = this.ctx;
    var color = '#ffc107';
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(b.x - 16, b.y);
    ctx.lineTo(b.x + 16, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(b.x, b.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,193,7,.22)';
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    this._tag(res.snap.kind + '  ' + res.snap.price.toFixed(this.digits || 2), b.x + 12, b.y - 16, color, 'left');
  };

  DrawingLayer.prototype._paintFib = function (d, a, b) {
    var ctx = this.ctx;
    var x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
    var dg = this.digits || 2;
    var p0 = d.pts[0].price, p1 = d.pts[1].price;
    var levels = fibLevelsOf(d);
    var baseColor = d.color || '#9598a1';
    for (var i = 0; i < levels.length; i++) {
      var lv = levels[i];
      if (!lv || lv.visible === false) continue;
      var ratioNum = Number(lv.ratio);
      if (!isFinite(ratioNum)) continue;
      var col = lv.color || baseColor;
      var y = a.y + (b.y - a.y) * ratioNum;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();

      var ratio = fmtRatio(ratioNum);
      var price = p0 + (p1 - p0) * ratioNum;
      var text = ratio + '  ' + price.toFixed(dg);
      ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
      var tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(19,23,34,.78)';
      ctx.fillRect(x2 + 2, y - 8, tw + 8, 15);
      ctx.fillStyle = col;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x2 + 6, y);
    }
  };

  DrawingLayer.prototype._paintMeasure = function (d, a, b, color) {
    var ctx = this.ctx;
    var dp = b.price - a.price;
    var pct = a.price ? (dp / a.price) * 100 : 0;
    var bars = Math.abs(Math.round((b.x - a.x) / Math.max(1, this._barSpacing())));
    var up = dp >= 0;
    var col = up ? '#26a69a' : '#ef5350';
    ctx.fillStyle = this._alpha(col, 0.14);
    ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.strokeStyle = col;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.setLineDash([]);
    var label = (up ? '+' : '') + dp.toFixed(this.digits || 2) + '  (' + (up ? '+' : '') + pct.toFixed(2) + '%)  ' + bars + ' 根';
    this._tag(label, (a.x + b.x) / 2, Math.min(a.y, b.y) - 10, col, 'center');
  };

  DrawingLayer.prototype._barSpacing = function () {
    try {
      var o = this.chart.timeScale().options();
      return o.barSpacing || 6;
    } catch (e) { return 6; }
  };

  DrawingLayer.prototype._alpha = function (hex, a) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  };

  DrawingLayer.prototype._tag = function (text, x, y, color, align) {
    var ctx = this.ctx;
    ctx.save();
    ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
    var w = ctx.measureText(text).width + 10;
    var h = 17;
    var bx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    var by = y - h / 2;
    ctx.fillStyle = 'rgba(20,24,34,.92)';
    this._roundRect(bx, by, w, h, 3);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    this._roundRect(bx, by, w, h, 3);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + 5, y + 0.5);
    ctx.restore();
    return { x: bx, y: by, w: w, h: h };
  };

  DrawingLayer.prototype._text = function (text, x, y, color) {
    var ctx = this.ctx;
    ctx.save();
    ctx.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif';
    var w = ctx.measureText(text).width + 12;
    ctx.fillStyle = 'rgba(20,24,34,.86)';
    this._roundRect(x, y - 10, w, 20, 4);
    ctx.fill();
    ctx.strokeStyle = this._alpha(color, .5);
    ctx.lineWidth = 1;
    this._roundRect(x, y - 10, w, 20, 4);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 6, y);
    ctx.restore();
  };

  DrawingLayer.prototype._roundRect = function (x, y, w, h, r) {
    var ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };

  DrawingLayer.prototype._fmtTime = function (t) {
    var d = new Date(t * 1000);
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
      p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  };

  DrawingLayer.prototype.setDigits = function (d) { this.digits = d; };

  /* 供交易层复用的绘制钩子 (画在画线之上) */
  DrawingLayer.prototype.setExtraPainter = function (fn) { this.extraPainter = fn; };

  /* 交易层可以把鼠标事件抢过去 (工具栏, 止损拖拽等) */
  DrawingLayer.prototype.setInterceptor = function (obj) { this.interceptor = obj; };

  /* 平移/缩放/拖动价格轴都不会触发 mousemove, 必须自己盯住视图变化.
     以前是每个窗格常驻 60fps 的 rAF 轮询, 4 窗格时每秒几百次签名比较;
     现在视图变化优先走事件 (时间轴订阅 + 滚轮/拖拽), 200ms 轮询只做兜底. */
  DrawingLayer.prototype._viewSignature = function () {
    try {
      var r = this.chart.timeScale().getVisibleLogicalRange();
      var bars = this.getBars ? this.getBars() : null;
      var cur = this.getCursor ? Math.min(this.getCursor(), bars.length - 1) : bars.length - 1;
      var ref = bars && bars.length && cur >= 0 ? bars[cur].close : 0;
      var y = this.series.priceToCoordinate(ref);
      return [
        r ? r.from.toFixed(3) : '-',
        r ? r.to.toFixed(3) : '-',
        y === null || y === undefined ? 'n' : y.toFixed(2),
        this.w, this.h
      ].join('|');
    } catch (e) {
      return '';
    }
  };

  DrawingLayer.prototype.startAutoSync = function () {
    if (this._syncStarted) return;
    this._syncStarted = true;
    var self = this;
    var last = null;
    var burstUntil = 0;

    function check() {
      if (self._disposed || self._syncStopped) return;
      if (document.visibilityState !== 'hidden') {
        var sig = self._viewSignature();
        if (sig !== last) {
          last = sig;
          self.redraw();
        }
      }
    }

    function loop() {
      if (self._disposed || self._syncStopped) return;
      check();
      // 拖动/滚轮后的惯性动画期间临时用 60fps 跟住, 静止后回到 200ms 兜底
      var delay = performance.now() < burstUntil ? 16 : 200;
      self._syncTimer = setTimeout(loop, delay);
    }

    function kick() {
      burstUntil = performance.now() + 500;
      self.requestRedraw();
    }

    // 时间轴变化 (拖动/缩放/程序化 setVisibleLogicalRange) 立即重绘
    try {
      self._onTimeRangeChange = function () { self.requestRedraw(); };
      this.chart.timeScale().subscribeVisibleLogicalRangeChange(self._onTimeRangeChange);
    } catch (e) { /* 老版本图表库没有该订阅时由轮询兜底 */ }

    // 价格轴的拖动 / 滚轮缩放不会改变时间轴, 需要单独监听
    this._onViewWheel = function () { kick(); };
    this._onViewDrag = function (e) {
      if (!e || e.buttons || (e.pointerType && e.pointerType !== 'mouse')) kick();
    };
    this._onViewDown = function () { kick(); };
    this.host.addEventListener('wheel', this._onViewWheel, { passive: true });
    this.host.addEventListener('pointerdown', this._onViewDown, { passive: true });
    this.host.addEventListener('pointermove', this._onViewDrag, { passive: true });
    this.host.addEventListener('dblclick', this._onViewDown, true);
    // 后台标签页的定时器会被节流, 切回来时立刻补一次对齐
    this._onVisibility = function () { if (document.visibilityState === 'visible') kick(); };
    document.addEventListener('visibilitychange', this._onVisibility);

    loop();
  };

  /* 键盘 */
  DrawingLayer.prototype.handleKey = function (e) {
    if (e.key === 'Escape') {
      if (this.pending) { this.pending = null; this.redraw(); return true; }
      if (this.selected) { this.selected = null; this.redraw(); return true; }
      if (this.tool !== 'cursor') { this._resetToCursor(); return true; }
      return false;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
      this.deleteSelected();
      return true;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      return this.undo();
    }
    return false;
  };

  global.DrawingLayer = DrawingLayer;
  global.DRAW_TOOLS = { SINGLE_POINT: SINGLE_POINT, DEFAULTS: DEFAULTS, FIB_DEFAULT_LEVELS: FIB_DEFAULT_LEVELS };
})(window);
