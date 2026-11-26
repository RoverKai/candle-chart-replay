/* 模拟交易 (开仓 / 平仓 / 统计) —— 在回放位置上手动开仓, 逐根推进时自动结算止损止盈。 */
(function (global) {
  'use strict';

  var DIR_COLOR = { 1: '#26a69a', '-1': '#ef5350' };
  var SL_COLOR = '#ef5350';
  var TP_COLOR = '#26a69a';

  // 挂单: 买入限价/卖出限价/买入止损/卖出止损
  var ORDER_DIR = { buy_limit: 1, sell_limit: -1, buy_stop: 1, sell_stop: -1 };
  var ORDER_LABEL = { buy_limit: '买入限价', sell_limit: '卖出限价', buy_stop: '买入止损', sell_stop: '卖出止损' };
  var ORDER_COLOR = { buy_limit: '#26a69a', sell_limit: '#ef5350', buy_stop: '#26a69a', sell_stop: '#ef5350' };

  // 各品种默认合约规模 (1 手对应的标的数量)
  var CONTRACT_DEFAULT = {
    XAUUSD: 100, XAGUSD: 5000, XTIUSD: 1000, XBRUSD: 1000,
    BTCUSD: 1, ETHUSD: 1, NAS100: 10, US30: 10, SPX500: 10,
    EURUSD: 100000, GBPUSD: 100000, USDJPY: 100000, USDCHF: 100000
  };

  function uid() {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function TradeBook(opts) {
    this.getBars = opts.getBars;
    this.getCursor = opts.getCursor;
    this.getPlotWidth = opts.getPlotWidth || null;
    this.getPriceAt = opts.getPriceAt || null;
    this.onUpdate = opts.onUpdate || function () {};
    this.onHint = opts.onHint || function () {};

    this.symbol = '';
    this.digits = 2;
    this.bars = [];
    this.lots = 0.1;
    this.contract = 100;
    this.showHistory = opts.showHistory !== false;

    this.position = null;
    this.trades = [];
    this.orders = [];
    this._slBtn = null;        // 止损/止盈按钮的屏幕矩形 (每帧绘制时更新)
    this._tpBtn = null;
    this._layer = null;
    this._dragMode = null;
  }

  /* ------------------------------------------------------------ 上下文 */

  TradeBook.prototype.setContext = function (ctx) {
    this.symbol = ctx.symbol || '';
    this.digits = ctx.digits != null ? ctx.digits : 2;
    this.bars = ctx.bars || [];
    var saved = null;
    try { saved = localStorage.getItem('kline-replay:lots:' + this.symbol); } catch (e) { }
    this.lots = saved ? parseFloat(saved) || 0.1 : 0.1;
    var contract = CONTRACT_DEFAULT[this.symbol.toUpperCase()];
    this.contract = contract || 100;
    var savedContract = null;
    try { savedContract = localStorage.getItem('kline-replay:contract:' + this.symbol); } catch (e) { }
    if (savedContract) this.contract = parseFloat(savedContract) || this.contract;
    this.onUpdate();
  };

  TradeBook.prototype.setLots = function (v) {
    this.lots = Math.max(0.01, parseFloat(v) || 0.1);
    try { localStorage.setItem('kline-replay:lots:' + this.symbol, String(this.lots)); } catch (e) { }
  };

  TradeBook.prototype.setContract = function (v) {
    this.contract = Math.max(1, parseFloat(v) || 100);
    try { localStorage.setItem('kline-replay:contract:' + this.symbol, String(this.contract)); } catch (e) { }
  };

  /** 历史仓位 (已平仓记录) 是否画在图上; 当前持仓不受影响 */
  TradeBook.prototype.setShowHistory = function (on) {
    this.showHistory = !!on;
    this.onUpdate();
  };

  TradeBook.prototype.idxOfTime = function (time) {
    var bars = this.bars;
    var lo = 0, hi = bars.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (bars[mid].time === time) return mid;
      if (bars[mid].time < time) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  };

  TradeBook.prototype.entryIdx = function () {
    return this.position ? this.idxOfTime(this.position.entryTime) : -1;
  };

  /* ------------------------------------------------------------ 开仓 / 平仓 */

  TradeBook.prototype.canOpen = function () {
    return !this.position && this.bars.length > 0;
  };

  TradeBook.prototype.open = function (dir, extra) {
    if (!this.canOpen()) {
      this.onHint(this.position ? '已有持仓，先平仓' : '还没有数据');
      return null;
    }
    var idx = this.getCursor();
    var bar = this.bars[idx];
    if (!bar) return null;

    var opts = extra || {};
    var hadOrders = this.orders.length > 0;
    if (hadOrders) this.orders = [];      // 只支持单仓, 开仓时清掉挂单
    var pos = {
      id: uid(),
      dir: dir,
      entryTime: bar.time,
      entryPrice: bar.close,
      lots: opts.lots != null ? opts.lots : this.lots,
      contract: opts.contract != null ? opts.contract : this.contract,
      sl: opts.sl || null,
      tp: opts.tp || null
    };
    // 止损止盈方向校验
    if (pos.sl && ((dir === 1 && pos.sl >= pos.entryPrice) || (dir === -1 && pos.sl <= pos.entryPrice))) {
      this.onHint('止损价方向不对，已忽略');
      pos.sl = null;
    }
    if (pos.tp && ((dir === 1 && pos.tp <= pos.entryPrice) || (dir === -1 && pos.tp >= pos.entryPrice))) {
      this.onHint('止盈价方向不对，已忽略');
      pos.tp = null;
    }

    this.position = pos;
    if (hadOrders) this.onHint('已开仓，原有挂单已取消');
    this.onHint((dir === 1 ? '开多' : '开空') + ' ' + pos.lots + ' 手 @ ' + pos.entryPrice.toFixed(this.digits));
    this.onUpdate();
    return pos;
  };

  TradeBook.prototype.close = function (reason) {
    if (!this.position) return null;
    var idx = this.getCursor();
    var bar = this.bars[idx];
    if (!bar) return null;
    return this._settle(this.position, bar.time, bar.close, reason || '手动平仓');
  };

  /* ------------------------------------------------------------ 挂单 */

  TradeBook.prototype.currentClose = function () {
    var bar = this.bars[this.getCursor()];
    return bar ? bar.close : null;
  };

  /** 挂单方向是否合法: 限价单必须在现价下方(买)/上方(卖), 止损单相反 */
  TradeBook.prototype.orderSideOk = function (type, price) {
    var close = this.currentClose();
    if (close === null) return false;
    if (type === 'buy_limit') return price < close;
    if (type === 'sell_limit') return price > close;
    if (type === 'buy_stop') return price > close;
    if (type === 'sell_stop') return price < close;
    return false;
  };

  TradeBook.prototype.placeOrder = function (type, price, extra) {
    if (!ORDER_DIR[type]) return null;
    if (this.position) {
      this.onHint('已有持仓，先平仓再挂单');
      return null;
    }
    if (!isFinite(price)) return null;
    if (!this.orderSideOk(type, price)) {
      this.onHint(ORDER_LABEL[type] + ' 价格应在现价的' + (ORDER_DIR[type] === 1 ? '下方' : '上方'));
      return null;
    }
    var opts = extra || {};
    var order = {
      id: uid(),
      type: type,
      price: price,
      lots: opts.lots != null ? opts.lots : this.lots,
      contract: opts.contract != null ? opts.contract : this.contract,
      sl: opts.sl || null,
      tp: opts.tp || null,
      createdTime: this.bars[this.getCursor()] ? this.bars[this.getCursor()].time : 0
    };
    this.orders.push(order);
    this.onHint('已挂 ' + ORDER_LABEL[type] + ' @ ' + price.toFixed(this.digits));
    this.onUpdate();
    return order;
  };

  TradeBook.prototype.cancelOrder = function (id) {
    var before = this.orders.length;
    this.orders = this.orders.filter(function (o) { return o.id !== id; });
    if (this.orders.length !== before) {
      this.onHint('已取消挂单');
      this.onUpdate();
      return true;
    }
    return false;
  };

  TradeBook.prototype.cancelAllOrders = function () {
    if (!this.orders.length) return;
    this.orders = [];
    this.onHint('已取消全部挂单');
    this.onUpdate();
  };

  /** 逐根检查挂单是否触发; 触发后按跳空规则成交 */
  TradeBook.prototype._checkOrders = function (bar) {
    if (this.position || !this.orders.length) return false;
    for (var i = 0; i < this.orders.length; i++) {
      var o = this.orders[i];
      var fill = null;
      if (o.type === 'buy_limit') {
        if (bar.low <= o.price) fill = Math.min(o.price, bar.open);
      } else if (o.type === 'sell_limit') {
        if (bar.high >= o.price) fill = Math.max(o.price, bar.open);
      } else if (o.type === 'buy_stop') {
        if (bar.high >= o.price) fill = Math.max(o.price, bar.open);
      } else if (o.type === 'sell_stop') {
        if (bar.low <= o.price) fill = Math.min(o.price, bar.open);
      }
      if (fill === null) continue;

      var dir = ORDER_DIR[o.type];
      var rest = this.orders.length - 1;
      this.orders = [];                     // OCO: 一张成交, 其余撤销
      this.position = {
        id: o.id,
        dir: dir,
        entryTime: bar.time,
        entryPrice: fill,
        lots: o.lots,
        contract: o.contract,
        sl: o.sl,
        tp: o.tp
      };
      this.onHint(ORDER_LABEL[o.type] + ' 成交 @ ' + fill.toFixed(this.digits) + (rest > 0 ? '，其余挂单已撤销' : ''));
      this.onUpdate();
      return true;
    }
    return false;
  };

  TradeBook.prototype._settle = function (pos, exitTime, exitPrice, reason) {
    var pnl = this._pnl(pos, exitPrice);
    var trade = {
      id: pos.id,
      dir: pos.dir,
      entryTime: pos.entryTime,
      entryPrice: pos.entryPrice,
      exitTime: exitTime,
      exitPrice: exitPrice,
      lots: pos.lots,
      contract: pos.contract,
      sl: pos.sl,
      tp: pos.tp,
      reason: reason,
      pnl: pnl
    };
    this.trades.push(trade);
    this.trades.sort(function (a, b) { return a.exitTime - b.exitTime; });
    this.position = null;
    this.onUpdate();
    return trade;
  };

  TradeBook.prototype._pnl = function (pos, price) {
    return (price - pos.entryPrice) * pos.dir * pos.lots * pos.contract;
  };

  TradeBook.prototype.floating = function () {
    if (!this.position) return 0;
    var idx = this.getCursor();
    var pe = this.idxOfTime(this.position.entryTime);
    if (pe < 0 || idx < pe) return 0;      // 光标在开仓之前
    var bar = this.bars[idx];
    return bar ? this._pnl(this.position, bar.close) : 0;
  };

  /* ------------------------------------------------------------ 推进结算 */

  TradeBook.prototype.onCursorMove = function (prev, next) {
    if (next <= prev) return;               // 回退不重算
    var needOrder = this.orders.length > 0;
    if (!this.position && !needOrder) return;
    for (var i = prev + 1; i <= next; i++) {
      var bar = this.bars[i];
      if (!bar) break;
      if (needOrder && this._checkOrders(bar)) {
        needOrder = false;                  // 成交当根不再判止损
        continue;
      }
      if (this.position) {
        var pe = this.idxOfTime(this.position.entryTime);
        if (i > pe && this._checkBar(this.position, bar)) continue;
      }
    }
  };

  TradeBook.prototype._checkBar = function (pos, bar) {
    var sl = pos.sl, tp = pos.tp;
    if (pos.dir === 1) {
      if (sl && bar.low <= sl) { this._settle(pos, bar.time, sl, '止损'); return true; }
      if (tp && bar.high >= tp) { this._settle(pos, bar.time, tp, '止盈'); return true; }
    } else {
      if (sl && bar.high >= sl) { this._settle(pos, bar.time, sl, '止损'); return true; }
      if (tp && bar.low <= tp) { this._settle(pos, bar.time, tp, '止盈'); return true; }
    }
    return false;
  };

  /* ------------------------------------------------------------ 统计 */

  TradeBook.prototype.stats = function () {
    var ts = this.trades;
    var total = 0, wins = 0, losses = 0, grossWin = 0, grossLoss = 0;
    var best = 0, worst = 0;
    var equity = 0, peak = 0, maxDD = 0;
    var longCount = 0, shortCount = 0;
    for (var i = 0; i < ts.length; i++) {
      var t = ts[i];
      total += t.pnl;
      if (t.dir === 1) longCount++; else shortCount++;
      if (t.pnl > 0) { wins++; grossWin += t.pnl; }
      else if (t.pnl < 0) { losses++; grossLoss += -t.pnl; }
      if (t.pnl > best) best = t.pnl;
      if (t.pnl < worst) worst = t.pnl;
      equity += t.pnl;
      if (equity > peak) peak = equity;
      if (peak - equity > maxDD) maxDD = peak - equity;
    }
    return {
      count: ts.length,
      wins: wins,
      losses: losses,
      longCount: longCount,
      shortCount: shortCount,
      winRate: ts.length ? wins / ts.length * 100 : 0,
      total: total,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      avg: ts.length ? total / ts.length : 0,
      best: best,
      worst: worst,
      maxDD: maxDD
    };
  };

  /* ------------------------------------------------------------ 绘制 */

  TradeBook.prototype.paint = function (ctx, layer) {
    var self = this;
    var dg = this.digits;
    var cur = this.getCursor();
    this._layer = layer;
    this._slBtn = null;
    this._tpBtn = null;

    if (this.showHistory) {
      this.trades.forEach(function (t) {
        var ei = self.idxOfTime(t.entryTime);
        var xi = self.idxOfTime(t.exitTime);
        if (ei > cur || xi > cur) return;          // 未来成交不显示
        self._paintTrade(ctx, layer, t, dg);
      });
    }

    if (this.position) this._paintOpen(ctx, layer, dg, cur);
    if (this.orders.length) this._paintOrders(ctx, layer, dg, cur);
  };

  TradeBook.prototype._paintOrders = function (ctx, layer, dg, cur) {
    var curBar = this.bars[cur];
    var curTime = curBar ? curBar.time : 0;
    for (var i = 0; i < this.orders.length; i++) {
      var o = this.orders[i];
      if (o.createdTime && o.createdTime > curTime) continue;   // 还没到挂单时间
      var y = layer.yOf(o.price);
      if (y === null) continue;
      var color = ORDER_COLOR[o.type];
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([1, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(layer.w, y);
      ctx.stroke();
      ctx.restore();

      var txt = ORDER_LABEL[o.type] + ' ' + o.price.toFixed(dg) + ' · ' + o.lots + '手';
      layer._tag(txt, 10, y, color, 'left');
    }
  };

  TradeBook.prototype._paintTrade = function (ctx, layer, t, dg) {
    var x1 = layer.xOf(t.entryTime);
    var x2 = layer.xOf(t.exitTime);
    var y1 = layer.yOf(t.entryPrice);
    var y2 = layer.yOf(t.exitPrice);
    if (x1 === null || x2 === null || y1 === null || y2 === null) return;

    var color = t.pnl >= 0 ? '#26a69a' : '#ef5350';
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // 入场箭头
    this._arrow(ctx, x1, y1, t.dir, DIR_COLOR[t.dir]);
    // 出场点
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x2, y2, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    var label = (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2);
    layer._tag(label, x2 + 6, y2 - 12, color, 'left');
  };

  TradeBook.prototype._paintOpen = function (ctx, layer, dg, cur) {
    var p = this.position;
    var pe = this.idxOfTime(p.entryTime);
    if (pe < 0 || pe > cur) return;
    var x1 = layer.xOf(p.entryTime);
    var y = layer.yOf(p.entryPrice);
    if (x1 === null || y === null) return;

    var color = DIR_COLOR[p.dir];
    var right = layer.w;
    if (this.getPlotWidth) {
      var pw = this.getPlotWidth();
      if (pw > 0) right = pw;      // 贴住价格轴内侧, 不压住刻度
    }

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(right, y);
    ctx.stroke();

    // 止损 / 止盈
    if (p.sl) this._level(ctx, layer, p.sl, SL_COLOR, 'SL');
    if (p.tp) this._level(ctx, layer, p.tp, TP_COLOR, 'TP');
    ctx.restore();

    this._arrow(ctx, x1, y, p.dir, color);

    var floating = this.floating();
    var sgn = p.dir === 1 ? '多' : '空';
    var txt = sgn + ' ' + p.lots + ' @ ' + p.entryPrice.toFixed(dg) +
      '   ' + (floating >= 0 ? '+' : '') + floating.toFixed(2);
    var tag = layer._tag(txt, right - 6, y, color, 'right');
    if (tag) this._drawButtons(ctx, layer, tag, y, p);
  };

  /** 成本线标签左侧的 SL / TP 按钮: 按住上下拖即可设置 */
  TradeBook.prototype._drawButtons = function (ctx, layer, tag, y, p) {
    var bw = 24, bh = 17, gap = 4;
    var rightEdge = tag.x - gap;
    var tpX = rightEdge - bw;
    var slX = tpX - gap - bw;
    var light = !!(window.ChartStyle && window.ChartStyle.isLight && window.ChartStyle.isLight());

    this._slBtn = { x: slX, y: y - bh / 2, w: bw, h: bh };
    this._tpBtn = { x: tpX, y: y - bh / 2, w: bw, h: bh };

    this._pill(ctx, layer, this._slBtn, y, p.sl != null, 'SL',
      '#ef5350', light ? '#c62828' : '#ff8a87', light ? 'rgba(239,83,80,.14)' : 'rgba(239,83,80,.26)', light);
    this._pill(ctx, layer, this._tpBtn, y, p.tp != null, 'TP',
      '#26a69a', light ? '#00796b' : '#4fd8c6', light ? 'rgba(38,166,154,.14)' : 'rgba(38,166,154,.26)', light);
  };

  TradeBook.prototype._pill = function (ctx, layer, r, y, active, text, stroke, fg, bgActive, light) {
    ctx.save();
    ctx.fillStyle = active ? bgActive : (light ? 'rgba(90,102,120,.10)' : 'rgba(120,134,150,.16)');
    layer._roundRect(r.x, r.y, r.w, r.h, 3);
    ctx.fill();
    ctx.strokeStyle = active ? stroke : (light ? 'rgba(70,80,95,.55)' : 'rgba(150,163,180,.55)');
    ctx.lineWidth = 1;
    layer._roundRect(r.x, r.y, r.w, r.h, 3);
    ctx.stroke();
    ctx.fillStyle = active ? fg : (light ? '#4f5b6e' : '#9aa5b8');
    ctx.font = 'bold 10px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, r.x + r.w / 2, y + 0.5);
    ctx.restore();
  };

  /* ------------------------------------------------------------ 止损/止盈拖拽 */

  function inside(r, x, y, pad) {
    if (!r) return false;
    pad = pad || 2;
    return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
  }

  TradeBook.prototype.hitTest = function (x, y) {
    if (!this.position) return false;
    if (inside(this._slBtn, x, y)) return 'sl-button';
    if (inside(this._tpBtn, x, y)) return 'tp-button';
    if (!this._layer) return false;

    // 两条线靠得很近时, 取距离更近的那条
    var p = this.position;
    var best = null;
    var bestD = 6;
    if (p.sl != null) {
      var ly = this._layer.yOf(p.sl);
      if (ly !== null) {
        var d1 = Math.abs(y - ly);
        if (d1 <= bestD) { bestD = d1; best = 'sl-line'; }
      }
    }
    if (p.tp != null) {
      var ty = this._layer.yOf(p.tp);
      if (ty !== null) {
        var d2 = Math.abs(y - ty);
        if (d2 < bestD) { bestD = d2; best = 'tp-line'; }
      }
    }
    return best || false;
  };

  TradeBook.prototype.dragStart = function (x, y) {
    this._dragMode = this.hitTest(x, y) || null;
  };

  TradeBook.prototype._tick = function () {
    return Math.pow(10, -this.digits);
  };

  /** 止损必须落在当前收盘价的亏损侧; 止盈落在盈利侧 */
  TradeBook.prototype._clampStop = function (price, dir) {
    var close = this.currentClose();
    if (close === null) return price;
    var tick = this._tick();
    return dir === 1 ? Math.min(price, close - tick) : Math.max(price, close + tick);
  };

  TradeBook.prototype._clampTarget = function (price, dir) {
    var close = this.currentClose();
    if (close === null) return price;
    var tick = this._tick();
    return dir === 1 ? Math.max(price, close + tick) : Math.min(price, close - tick);
  };

  TradeBook.prototype.dragMove = function (x, y) {
    var p = this.position;
    var mode = this._dragMode;
    if (!p || !mode || !this.getPriceAt) return;
    var price = this.getPriceAt(y);
    if (price === null || price === undefined || !isFinite(price)) return;

    if (mode === 'sl-button' || mode === 'sl-line') {
      p.sl = this._clampStop(price, p.dir);
    } else {
      p.tp = this._clampTarget(price, p.dir);
    }
    this.onUpdate();
  };

  TradeBook.prototype.dragEnd = function () {
    var p = this.position;
    var mode = this._dragMode;
    this._dragMode = null;
    if (!p || !mode) return;
    if (mode === 'sl-button' || mode === 'sl-line') {
      if (p.sl != null) this.onHint('止损设为 ' + p.sl.toFixed(this.digits));
    } else if (p.tp != null) {
      this.onHint('止盈设为 ' + p.tp.toFixed(this.digits));
    }
    this.onUpdate();
  };

  TradeBook.prototype._level = function (ctx, layer, price, color, tag) {
    var y = layer.yOf(price);
    if (y === null) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(layer.w, y);
    ctx.stroke();
    ctx.restore();
    layer._tag(tag + ' ' + price.toFixed(this.digits), 8, y, color, 'left');
  };

  TradeBook.prototype._arrow = function (ctx, x, y, dir, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    if (dir === 1) {
      ctx.moveTo(x, y + 2);
      ctx.lineTo(x - 6, y + 12);
      ctx.lineTo(x + 6, y + 12);
    } else {
      ctx.moveTo(x, y - 2);
      ctx.lineTo(x - 6, y - 12);
      ctx.lineTo(x + 6, y - 12);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  /* ------------------------------------------------------------ 持久化 */

  TradeBook.prototype.serialize = function () {
    return { position: this.position, trades: this.trades, orders: this.orders };
  };

  TradeBook.prototype.restore = function (data) {
    var d = data || {};
    this.position = d.position || null;
    this.trades = (d.trades || []).slice().sort(function (a, b) { return a.exitTime - b.exitTime; });
    this.orders = (d.orders || []).slice();
  };

  TradeBook.prototype.clear = function () {
    this.position = null;
    this.trades = [];
    this.orders = [];
    this.onUpdate();
  };

  global.TradeBook = TradeBook;
})(window);
