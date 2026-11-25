/* 画图层 —— 叠加在 lightweight-charts 上的 canvas, 用 {time, price} 锚点存储,
   因此随缩放/平移/回放自动跟随, 且可跨会话持久化。 */
(function (global) {
  'use strict';

  var FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  var FIB_COLORS = ['#787b86', '#f23645', '#ff9800', '#4caf50', '#089981', '#2962ff', '#787b86'];
  var HIT = 7;            // 命中测试像素半径
  var HANDLE = 3.5;       // 端点手柄半宽

  var DEFAULTS = {
    trend:   { color: '#2962ff', width: 1.6 },
    ray:     { color: '#2962ff', width: 1.6 },
    hline:   { color: '#f4a261', width: 1.4 },
    vline:   { color: '#f4a261', width: 1.4 },
    rect:    { color: '#26a69a', width: 1.4 },
    fib:     { color: '#9598a1', width: 1.2 },
    text:    { color: '#e8eaf0', width: 1 },
    measure: { color: '#4caf50', width: 1.4 }
  };

  var SINGLE_POINT = { hline: 1, vline: 1, text: 1 };

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

    this.ctx = this.canvas.getContext('2d');
    this.drawings = [];
    this.tool = 'cursor';
    this.selected = null;
    this.pending = null;        // 正在放置的第一个点
    this.hover = null;          // 鼠标位置 {x,y}
    this.hoverTarget = null;
    this.drag = null;           // {id, mode:'point'|'body', index, start, orig}
    this.ephemeral = null;      // 测量工具临时结果
    this.undoStack = [];
    this.w = 0;
    this.h = 0;
    this._raf = 0;
    this._bind();
    this.resize();
  }

  /* ------------------------------------------------------------ 基础 */

  DrawingLayer.prototype.resize = function () {
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
    if (this._raf) return;
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

  DrawingLayer.prototype.pointOf = function (x, y) {
    var bars = this.getBars() || [];
    if (!bars.length) return null;
    var limit = bars.length - 1;
    if (this.getCursor) limit = Math.min(limit, this.getCursor());   // 不能画到未来
    var logical = this.chart.timeScale().coordinateToLogical(x);
    if (logical === null || logical === undefined) return null;
    var idx = Math.round(logical);
    if (idx < 0) idx = 0;
    if (idx > limit) idx = limit;
    var price = this.series.coordinateToPrice(y);
    if (price === null || price === undefined) return null;
    return { time: bars[idx].time, price: price };
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
    this.drawings = (list || []).filter(function (d) { return d && d.type && d.pts && d.pts.length; });
    this.selected = null;
    this.pending = null;
    this.redraw();
  };

  DrawingLayer.prototype.getDrawings = function () {
    return this.drawings.filter(function (d) { return d.type !== 'measure'; });
  };

  DrawingLayer.prototype.setTool = function (tool) {
    this.tool = tool;
    this.pending = null;
    this.ephemeral = null;
    if (tool !== 'cursor') this.selected = null;
    this.host.style.cursor = tool === 'cursor' ? '' : 'crosshair';
    this.redraw();
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
    var d = Object.assign({ id: uid(), type: type, pts: pts }, DEFAULTS[type] || { color: '#2962ff', width: 1.4 });
    if (extra) Object.assign(d, extra);
    this.drawings.push(d);
    this.selected = d.id;
    this.onChange();
    this.redraw();
    return d;
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
        self.drag = {
          id: hit.id,
          mode: hit.mode,
          index: hit.index,
          start: { x: x, y: y },
          orig: JSON.parse(JSON.stringify(d.pts)),
          clone: !!(e.ctrlKey || e.metaKey)   // Ctrl/⌘ + 拖动 → 复制一份再拖
        };
        self.redraw();
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      if (self.tool === 'measure') {
        self._measureStart = self.pointOf(x, y);
        self.ephemeral = null;
        self.drag = { measure: true, start: { x: x, y: y } };
        return;
      }

      var pt = self.pointOf(x, y);
      if (!pt) return;

      if (SINGLE_POINT[self.tool]) {
        if (self.tool === 'text') {
          self._inlineEdit(x, y);
          self.pending = null;
          self.setTool('cursor');
          return;
        }
        self._add(self.tool, [pt]);
        self.pending = null;
        self.setTool('cursor');
        return;
      }

      if (!self.pending) {
        self.pending = pt;
        self.redraw();
      } else {
        self._add(self.tool, [self.pending, pt]);
        self.pending = null;
        self.setTool('cursor');
      }
    };

    this._onMove = function (e) {
      var r = host.getBoundingClientRect();
      var x = e.clientX - r.left;
      var y = e.clientY - r.top;

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

      if (self.drag && self.drag.measure) {
        var cur = self.pointOf(x, y);
        if (self._measureStart && cur) {
          self.ephemeral = { type: 'measure', pts: [self._measureStart, cur], color: '#4caf50', width: 1.4 };
        }
        self.requestRedraw();
        return;
      }

      if (self.drag) {
        // 第一次真正移动时才生成副本, 这样 Ctrl + 单击不会凭空多出一条线
        if (self.drag.clone) {
          var src = self._find(self.drag.id);
          if (!src) { self.drag = null; return; }
          var copy = JSON.parse(JSON.stringify(src));
          copy.id = uid();
          self.drawings.push(copy);
          self.selected = copy.id;
          self.drag.id = copy.id;
          self.drag.clone = false;
          self.onHint('已复制一份，可继续拖动');
        }
        if (self.drag.mode === 'body') {
          var anchor0 = self.xyOf(self.drag.orig[0]);
          var anchor1 = self.xyOf(self.drag.orig[self.drag.orig.length - 1]);
          var now0 = self.pointOf(x, y);
          if (now0 && anchor0 && anchor1) {
            var cur0 = self.pointOf(self.drag.start.x, self.drag.start.y);
            if (cur0) {
              var dt = now0.time - cur0.time;
              var dp = now0.price - cur0.price;
              var d = self._find(self.drag.id);
              d.pts = self.drag.orig.map(function (p) {
                return { time: p.time + dt, price: p.price + dp };
              });
            }
          }
        } else {
          var np = self.pointOf(x, y);
          if (np) {
            var dd = self._find(self.drag.id);
            dd.pts[self.drag.index] = np;
          }
        }
        self.requestRedraw();
        return;
      }

      if (self.tool === 'cursor' && self.interceptor && self.interceptor.hitTest(x, y)) {
        host.style.cursor = 'ns-resize';
        return;
      }

      var hovering = self.tool === 'cursor' ? self._hitTest(x, y) : null;
      var changed = false;
      if ((hovering && hovering.id) !== (self.hoverTarget && self.hoverTarget.id)) {
        self.hoverTarget = hovering;
        changed = true;
      }
      var cloneKey = e.ctrlKey || e.metaKey;
      host.style.cursor = self.tool !== 'cursor'
        ? 'crosshair'
        : (hovering ? (cloneKey ? 'copy' : (hovering.mode === 'point' ? 'nwse-resize' : 'move')) : '');

      if (self.pending || changed) self.requestRedraw();
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

    host.addEventListener('mousedown', this._onDown, true);
    window.addEventListener('mousemove', this._onMove, true);
    window.addEventListener('mouseup', this._onUp, true);
    host.addEventListener('mouseleave', this._onLeave, true);
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
      return x >= x1 - HIT && x <= x2 + HIT && (Math.abs(y - yA) <= HIT || Math.abs(y - yB) <= HIT ||
        FIB_LEVELS.some(function (lv) { return Math.abs(y - (yA + (yB - yA) * lv)) <= HIT; }));
    }
    return dist2seg(x, y, xy[0].x, xy[0].y, xy[1].x, xy[1].y) <= HIT;
  };

  /* 画布内即时输入文字 (避免 window.prompt 阻塞) */
  DrawingLayer.prototype._inlineEdit = function (x, y) {
    var self = this;
    var pt = this.pointOf(x, y);
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
    if (!ctx || !this.w) return;
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
      ctx.fillStyle = this._alpha(color, 0.1);
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
    var b = this.hover;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(41,98,255,.9)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    if (this.tool === 'rect') {
      ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else if (this.tool === 'fib') {
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      for (var i = 0; i < FIB_LEVELS.length; i++) {
        var yy = a.y + (b.y - a.y) * FIB_LEVELS[i];
        ctx.moveTo(Math.min(a.x, b.x), yy); ctx.lineTo(Math.max(a.x, b.x), yy);
      }
    } else {
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.restore();
  };

  DrawingLayer.prototype._paintFib = function (d, a, b) {
    var ctx = this.ctx;
    var x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
    var dg = this.digits || 2;
    var p0 = d.pts[0].price, p1 = d.pts[1].price;
    for (var i = 0; i < FIB_LEVELS.length; i++) {
      var lv = FIB_LEVELS[i];
      var y = a.y + (b.y - a.y) * lv;
      ctx.strokeStyle = FIB_COLORS[i];
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();

      var ratio = lv.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
      var price = p0 + (p1 - p0) * lv;
      var text = ratio + '  ' + price.toFixed(dg);
      ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
      var tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(19,23,34,.78)';
      ctx.fillRect(x2 + 2, y - 8, tw + 8, 15);
      ctx.fillStyle = FIB_COLORS[i];
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
     用 rAF 做一次廉价的签名比较, 变了才重绘 (每帧两次 API 调用, 可忽略). */
  DrawingLayer.prototype._viewSignature = function () {
    try {
      var r = this.chart.timeScale().getVisibleLogicalRange();
      var bars = this.getBars ? this.getBars() : null;
      var cur = this.getCursor ? Math.min(this.getCursor(), bars.length - 1) : bars.length - 1;
      var ref = bars && bars.length ? bars[cur].close : 0;
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
    function tick() {
      var sig = self._viewSignature();
      if (sig !== last) {
        last = sig;
        self.redraw();
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  };

  /* 键盘 */
  DrawingLayer.prototype.handleKey = function (e) {
    if (e.key === 'Escape') {
      if (this.pending) { this.pending = null; this.redraw(); return true; }
      if (this.selected) { this.selected = null; this.redraw(); return true; }
      if (this.tool !== 'cursor') { this.setTool('cursor'); return true; }
      return false;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
      this.deleteSelected();
      return true;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      this.undo();
      return true;
    }
    return false;
  };

  global.DrawingLayer = DrawingLayer;
  global.DRAW_TOOLS = { SINGLE_POINT: SINGLE_POINT, DEFAULTS: DEFAULTS };
})(window);
