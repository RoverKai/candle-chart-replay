/* 模拟交易 (多笔持仓 / 逐单平仓 / 统计) —— 在回放位置上手动开仓, 逐根推进时自动结算止损止盈。
   持仓用 positions 数组保存, 每笔独立止损止盈, 因此支持加仓、对冲和多单同时持仓。 */
(function (global) {
  'use strict';

  var DIR_COLOR = { 1: '#26a69a', '-1': '#ef5350' };
  var SL_COLOR = '#ef5350';
  var TP_COLOR = '#26a69a';

  // 挂单: 买入限价/卖出限价/买入止损/卖出止损
  var ORDER_DIR = { buy_limit: 1, sell_limit: -1, buy_stop: 1, sell_stop: -1 };
  var ORDER_LABEL = { buy_limit: '买入限价', sell_limit: '卖出限价', buy_stop: '买入止损', sell_stop: '卖出止损' };
  var ORDER_COLOR = { buy_limit: '#26a69a', sell_limit: '#ef5350', buy_stop: '#26a69a', sell_stop: '#ef5350' };

  var OCO_KEY = 'kline-replay:oco';

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

    this.positions = [];       // 未平仓持仓 (每笔一个对象)
    this.activePosId = null;   // 面板/键盘操作的目标持仓
    this.trades = [];
    this.orders = [];
    this.oco = false;          // 挂单 OCO: 任意一张成交后撤销其余挂单
    this._nextNo = 1;          // 持仓显示编号, 平仓后不复用
    try { this.oco = localStorage.getItem(OCO_KEY) === '1'; } catch (e) { }

    this._btns = {};           // 每笔持仓的 SL/TP 按钮矩形 (每帧绘制时更新)
    this._slBtn = null;        // 活动持仓的按钮, 兼容旧调用方
    this._tpBtn = null;
    this._layer = null;
    this._dragMode = null;     // { kind, id } 或旧的 'sl-button' 字符串
  }

  /* 兼容旧接口: book.position 返回当前选中的持仓 */
  Object.defineProperty(TradeBook.prototype, 'position', {
    configurable: true,
    get: function () { return this.activePosition(); }
  });

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

  /** 挂单 OCO 开关: 打开后任意一张挂单成交会撤销其余挂单; 切换立即作用于已有挂单 */
  TradeBook.prototype.setOco = function (on) {
    this.oco = !!on;
    // 开关是全局的, 已挂出的单也要跟随, 否则勾选后旧挂单仍然各自成交
    for (var i = 0; i < this.orders.length; i++) this.orders[i].oco = this.oco;
    try { localStorage.setItem(OCO_KEY, this.oco ? '1' : '0'); } catch (e) { }
    this.onUpdate();
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
    var p = this.activePosition();
    return p ? this.idxOfTime(p.entryTime) : -1;
  };

  /* ------------------------------------------------------------ 持仓查找 / 选中 */

  TradeBook.prototype._posIndex = function (id) {
    for (var i = 0; i < this.positions.length; i++) {
      if (this.positions[i].id === id) return i;
    }
    return -1;
  };

  TradeBook.prototype._posById = function (id) {
    var i = this._posIndex(id);
    return i >= 0 ? this.positions[i] : null;
  };

  /** 当前选中的持仓; 选中项被平掉后回退到最后一笔 */
  TradeBook.prototype.activePosition = function () {
    var p = this._posById(this.activePosId);
    if (p) return p;
    return this.positions.length ? this.positions[this.positions.length - 1] : null;
  };

  TradeBook.prototype.setActivePosition = function (id) {
    var p = this._posById(id);
    if (!p) return false;
    if (this.activePosId === id) return true;
    this.activePosId = id;
    this.onUpdate();
    return true;
  };

  /* ------------------------------------------------------------ 开仓 / 平仓 */

  TradeBook.prototype.canOpen = function () {
    return this.bars.length > 0;
  };

  TradeBook.prototype._newPosition = function (dir, time, price, opts) {
    return {
      id: opts.id || uid(),
      no: this._nextNo++,
      dir: dir,
      entryTime: time,
      entryPrice: price,
      lots: opts.lots != null ? opts.lots : this.lots,
      contract: opts.contract != null ? opts.contract : this.contract,
      sl: opts.sl != null ? opts.sl : null,
      tp: opts.tp != null ? opts.tp : null
    };
  };

  TradeBook.prototype.open = function (dir, extra) {
    if (!this.bars.length) {
      this.onHint('还没有数据');
      return null;
    }
    var idx = this.getCursor();
    var bar = this.bars[idx];
    if (!bar) return null;

    var opts = extra || {};
    var pos = this._newPosition(dir, bar.time, bar.close, opts);
    // 止损止盈方向校验
    if (pos.sl && ((dir === 1 && pos.sl >= pos.entryPrice) || (dir === -1 && pos.sl <= pos.entryPrice))) {
      this.onHint('止损价方向不对，已忽略');
      pos.sl = null;
    }
    if (pos.tp && ((dir === 1 && pos.tp <= pos.entryPrice) || (dir === -1 && pos.tp >= pos.entryPrice))) {
      this.onHint('止盈价方向不对，已忽略');
      pos.tp = null;
    }

    this.positions.push(pos);
    this.activePosId = pos.id;
    this.onHint((dir === 1 ? '开多' : '开空') + ' ' + pos.lots + ' 手 @ ' + pos.entryPrice.toFixed(this.digits) +
      (this.positions.length > 1 ? '（第 ' + pos.no + ' 单）' : ''));
    this.onUpdate();
    return pos;
  };

  /** 平掉当前选中的持仓 (兼容旧调用: close(reason)) */
  TradeBook.prototype.close = function (reason) {
    var p = this.activePosition();
    return p ? this.closePosition(p.id, reason) : null;
  };

  TradeBook.prototype.closePosition = function (id, reason) {
    var pos = this._posById(id);
    if (!pos) return null;
    var idx = this.getCursor();
    var bar = this.bars[idx];
    if (!bar) return null;
    return this._settle(pos, bar.time, bar.close, reason || '手动平仓');
  };

  /** 一次平掉全部持仓, 返回成交记录数组 */
  TradeBook.prototype.closeAll = function (reason) {
    if (!this.positions.length) return [];
    var idx = this.getCursor();
    var bar = this.bars[idx];
    if (!bar) return [];
    var closed = [];
    var list = this.positions.slice();
    for (var i = 0; i < list.length; i++) {
      var t = this._settle(list[i], bar.time, bar.close, reason || '全部平仓');
      if (t) closed.push(t);
    }
    return closed;
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
      sl: opts.sl != null ? opts.sl : null,
      tp: opts.tp != null ? opts.tp : null,
      oco: opts.oco != null ? !!opts.oco : this.oco,
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

  /** 逐根检查挂单是否触发; 每张挂单独立成交, 不会顶掉已有持仓 (OCO 开启时才互相撤销) */
  TradeBook.prototype._checkOrders = function (bar) {
    if (!this.orders.length) return 0;
    var filled = 0;
    var rest = [];
    var msgs = [];
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
      if (fill === null) {
        rest.push(o);
        continue;
      }

      var pos = this._newPosition(ORDER_DIR[o.type], bar.time, fill, {
        id: o.id, lots: o.lots, contract: o.contract, sl: o.sl, tp: o.tp
      });
      this.positions.push(pos);
      this.activePosId = pos.id;
      filled++;
      msgs.push(ORDER_LABEL[o.type] + ' 成交 @ ' + fill.toFixed(this.digits));

      if (o.oco) {
        // 尚未处理的挂单 + 已检查但未成交的挂单, 才是真正会被撤掉的数量
        var others = rest.length + (this.orders.length - i - 1);
        if (others > 0) msgs.push('其余 ' + others + ' 张挂单已撤销');
        rest = [];            // 撤销尚未检查的挂单
        break;
      }
    }
    this.orders = rest;
    if (filled) {
      this.onHint(msgs.join('；'));
      this.onUpdate();
    }
    return filled;
  };

  TradeBook.prototype._settle = function (pos, exitTime, exitPrice, reason) {
    var i = this._posIndex(pos.id);
    if (i < 0) return null;
    this.positions.splice(i, 1);

    var pnl = this._pnl(pos, exitPrice);
    var trade = {
      id: pos.id,
      no: pos.no,
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

    if (this.activePosId === pos.id) {
      var last = this.positions.length ? this.positions[this.positions.length - 1] : null;
      this.activePosId = last ? last.id : null;
    }
    this.onUpdate();
    return trade;
  };

  TradeBook.prototype._pnl = function (pos, price) {
    return (price - pos.entryPrice) * pos.dir * pos.lots * pos.contract;
  };

  /** 单笔持仓的浮动盈亏: 光标在开仓之前时按 0 处理 */
  TradeBook.prototype.floatingOf = function (pos) {
    var bar = this.bars[this.getCursor()];
    if (!bar || pos.entryTime > bar.time) return 0;
    return this._pnl(pos, bar.close);
  };

  /** 全部持仓的浮动盈亏合计 */
  TradeBook.prototype.floating = function () {
    var sum = 0;
    for (var i = 0; i < this.positions.length; i++) sum += this.floatingOf(this.positions[i]);
    return sum;
  };

  /* ------------------------------------------------------------ 推进结算 */

  TradeBook.prototype.onCursorMove = function (prev, next) {
    if (next <= prev) return;               // 回退不重算
    if (!this.positions.length && !this.orders.length) return;
    for (var i = prev + 1; i <= next; i++) {
      var bar = this.bars[i];
      if (!bar) break;
      if (this.orders.length) this._checkOrders(bar);
      if (!this.positions.length) continue;

      // 当根刚成交/开仓的持仓不判止损止盈, 与单仓时代一致
      var snapshot = this.positions.slice();
      for (var k = 0; k < snapshot.length; k++) {
        var pos = snapshot[k];
        if (pos.entryTime >= bar.time) continue;
        if (this._posIndex(pos.id) < 0) continue;    // 同一根里已被前面的判断平掉
        this._checkBar(pos, bar);
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
      openCount: this.positions.length,
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
    this._btns = {};
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

    if (this.positions.length) this._paintPositions(ctx, layer, dg, cur);
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

      var txt = (o.oco ? 'OCO · ' : '') + ORDER_LABEL[o.type] + ' ' + o.price.toFixed(dg) + ' · ' + o.lots + '手';
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

  /**
   * 画出所有持仓: 成本线 + 入场箭头 + 浮动盈亏标签。
   * 同一价位/相近价位的标签会按 20px 间距错开, 否则加仓时几笔持仓完全叠成一团。
   * 每笔持仓都有自己的 SL/TP 按钮, 未选中的持仓只画淡色止损止盈线。
   */
  TradeBook.prototype._paintPositions = function (ctx, layer, dg, cur) {
    var self = this;
    var active = this.activePosition();
    var right = layer.w;
    if (this.getPlotWidth) {
      var pw = this.getPlotWidth();
      if (pw > 0) right = pw;      // 贴住价格轴内侧, 不压住刻度
    }
    if (!layer.h) return;

    var items = [];
    for (var i = 0; i < this.positions.length; i++) {
      var p = this.positions[i];
      var pe = this.idxOfTime(p.entryTime);
      if (pe < 0 || pe > cur) continue;           // 还没到这个持仓的开仓时间
      var x1 = layer.xOf(p.entryTime);
      var y = layer.yOf(p.entryPrice);
      if (x1 === null || y === null) continue;
      items.push({ p: p, x1: x1, y: y, tagY: y });
    }
    if (!items.length) return;

    // 标签错开: 从最上面的成本线开始向下排, 保证至少 20px 间距;
    // 持仓多到画布放不下时自动缩小间距, 避免标签被裁掉
    var sorted = items.slice().sort(function (a, b) { return a.y - b.y; });
    var available = Math.max(20, layer.h - 20);
    var gap = Math.min(20, available / Math.max(1, sorted.length - 1));
    var prevY = -Infinity;
    for (var s = 0; s < sorted.length; s++) {
      var it = sorted[s];
      it.tagY = Math.max(it.y, prevY + gap);
      prevY = it.tagY;
    }
    var over = prevY - (layer.h - 10);
    if (over > 0) {
      for (s = 0; s < sorted.length; s++) sorted[s].tagY -= over;
    }
    var under = sorted.length ? 10 - sorted[0].tagY : 0;
    if (under > 0) {
      for (s = 0; s < sorted.length; s++) sorted[s].tagY += under;
    }

    // 1. 成本线 + 入场箭头
    items.forEach(function (item) {
      var pos = item.p;
      var color = DIR_COLOR[pos.dir];
      var isActive = !!(active && active.id === pos.id);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = isActive ? 1 : 0.55;
      ctx.lineWidth = isActive ? 1.6 : 1.2;
      ctx.beginPath();
      ctx.moveTo(item.x1, item.y);
      ctx.lineTo(right, item.y);
      ctx.stroke();
      ctx.restore();
      self._arrow(ctx, item.x1, item.y, pos.dir, color);
    });

    // 2. 止损 / 止盈线: 选中持仓带文字, 其余只画淡线, 避免多单时满屏标签
    items.forEach(function (item) {
      var pos = item.p;
      var isActive = !!(active && active.id === pos.id);
      if (pos.sl != null) {
        if (isActive) self._level(ctx, layer, pos.sl, SL_COLOR, 'SL');
        else self._levelQuiet(ctx, layer, pos.sl, SL_COLOR);
      }
      if (pos.tp != null) {
        if (isActive) self._level(ctx, layer, pos.tp, TP_COLOR, 'TP');
        else self._levelQuiet(ctx, layer, pos.tp, TP_COLOR);
      }
    });

    // 3. 标签 + 每笔持仓自己的 SL / TP 拖拽按钮
    items.forEach(function (item) {
      var pos = item.p;
      var color = DIR_COLOR[pos.dir];
      var fl = self.floatingOf(pos);
      var txt = '#' + (pos.no || (self._posIndex(pos.id) + 1)) + ' ' + (pos.dir === 1 ? '多' : '空') + ' ' +
        pos.lots + ' @ ' + pos.entryPrice.toFixed(dg) + '  ' + (fl >= 0 ? '+' : '') + fl.toFixed(2);
      var tag = layer._tag(txt, right - 6, item.tagY, color, 'right');
      if (!tag) return;
      var btns = self._drawButtons(ctx, layer, tag, item.tagY, pos);
      self._btns[pos.id] = btns;
      if (active && active.id === pos.id) {
        self._slBtn = btns.sl;
        self._tpBtn = btns.tp;
      }
    });
  };

  /** 成本线标签左侧的 SL / TP 按钮: 按住上下拖即可设置; 返回两个按钮的屏幕矩形 */
  TradeBook.prototype._drawButtons = function (ctx, layer, tag, y, p) {
    var bw = 24, bh = 17, gap = 4;
    var rightEdge = tag.x - gap;
    var tpX = rightEdge - bw;
    var slX = tpX - gap - bw;
    var light = !!(window.ChartStyle && window.ChartStyle.isLight && window.ChartStyle.isLight());

    var slBtn = { x: slX, y: y - bh / 2, w: bw, h: bh };
    var tpBtn = { x: tpX, y: y - bh / 2, w: bw, h: bh };

    this._pill(ctx, layer, slBtn, y, p.sl != null, 'SL',
      '#ef5350', light ? '#c62828' : '#ff8a87', light ? 'rgba(239,83,80,.14)' : 'rgba(239,83,80,.26)', light);
    this._pill(ctx, layer, tpBtn, y, p.tp != null, 'TP',
      '#26a69a', light ? '#00796b' : '#4fd8c6', light ? 'rgba(38,166,154,.14)' : 'rgba(38,166,154,.26)', light);

    return { sl: slBtn, tp: tpBtn, y: y };
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

  /** 返回命中的持仓控件 { kind, id }; 未命中返回 null */
  TradeBook.prototype.hitTestEx = function (x, y) {
    if (!this.positions.length) return null;
    var curBar = this.bars[this.getCursor()];
    var curTime = curBar ? curBar.time : 0;

    // 按钮: 后画的在上层, 倒序命中
    for (var i = this.positions.length - 1; i >= 0; i--) {
      var p = this.positions[i];
      if (p.entryTime > curTime) continue;          // 开仓时间在游标之后的持仓不画, 也不响应
      var b = this._btns[p.id];
      if (!b) continue;
      if (inside(b.sl, x, y)) return { kind: 'sl-button', id: p.id };
      if (inside(b.tp, x, y)) return { kind: 'tp-button', id: p.id };
    }

    if (!this._layer) return null;

    // 止损/止盈线靠得很近时只取距离最近的一条
    var best = null;
    var bestD = 6;
    for (i = 0; i < this.positions.length; i++) {
      var q = this.positions[i];
      if (q.entryTime > curTime) continue;
      if (q.sl != null) {
        var sy = this._layer.yOf(q.sl);
        if (sy !== null) {
          var d1 = Math.abs(y - sy);
          if (d1 <= bestD) { bestD = d1; best = { kind: 'sl-line', id: q.id }; }
        }
      }
      if (q.tp != null) {
        var ty = this._layer.yOf(q.tp);
        if (ty !== null) {
          var d2 = Math.abs(y - ty);
          if (d2 < bestD) { bestD = d2; best = { kind: 'tp-line', id: q.id }; }
        }
      }
    }
    return best;
  };

  /** 兼容旧调用: 只返回命中类型字符串 */
  TradeBook.prototype.hitTest = function (x, y) {
    var hit = this.hitTestEx(x, y);
    return hit ? hit.kind : false;
  };

  TradeBook.prototype.dragStart = function (x, y) {
    var hit = this.hitTestEx(x, y);
    this._dragMode = hit || null;
    if (hit && this.activePosId !== hit.id) {
      this.activePosId = hit.id;      // 直接拖某笔持仓的止损线时顺便选中它
      this.onUpdate();
    }
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
    var mode = this._dragMode;
    if (!mode || !this.getPriceAt) return;
    var kind = typeof mode === 'string' ? mode : mode.kind;
    var id = typeof mode === 'string' ? this.activePosId : mode.id;
    var p = this._posById(id) || this.activePosition();
    if (!p) return;
    var price = this.getPriceAt(y);
    if (price === null || price === undefined || !isFinite(price)) return;

    if (kind === 'sl-button' || kind === 'sl-line') {
      p.sl = this._clampStop(price, p.dir);
    } else {
      p.tp = this._clampTarget(price, p.dir);
    }
    this.onUpdate();
  };

  TradeBook.prototype.dragEnd = function () {
    var mode = this._dragMode;
    this._dragMode = null;
    if (!mode) return;
    var kind = typeof mode === 'string' ? mode : mode.kind;
    var id = typeof mode === 'string' ? this.activePosId : mode.id;
    var p = this._posById(id) || this.activePosition();
    if (!p) return;
    if (kind === 'sl-button' || kind === 'sl-line') {
      if (p.sl != null) this.onHint('止损设为 ' + p.sl.toFixed(this.digits) + (this.positions.length > 1 ? '（#' + p.no + '）' : ''));
    } else if (p.tp != null) {
      this.onHint('止盈设为 ' + p.tp.toFixed(this.digits) + (this.positions.length > 1 ? '（#' + p.no + '）' : ''));
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

  /** 未选中持仓的止损/止盈线: 只要位置, 不要文字标签 */
  TradeBook.prototype._levelQuiet = function (ctx, layer, price, color) {
    var y = layer.yOf(price);
    if (y === null) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(layer.w, y);
    ctx.stroke();
    ctx.restore();
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
    return {
      positions: this.positions,
      activePosId: this.activePosId,
      trades: this.trades,
      orders: this.orders
    };
  };

  TradeBook.prototype.restore = function (data) {
    var d = data || {};
    // 兼容旧版本的单持仓存档 { position: {...} }
    var raw = Array.isArray(d.positions) ? d.positions : (d.position ? [d.position] : []);
    this.positions = [];
    for (var i = 0; i < raw.length; i++) {
      var p = raw[i];
      if (!p || !p.dir || p.entryTime == null || p.entryPrice == null) continue;
      this.positions.push({
        id: p.id || uid(),
        no: p.no || (i + 1),
        dir: p.dir === -1 ? -1 : 1,
        entryTime: p.entryTime,
        entryPrice: p.entryPrice,
        lots: p.lots != null ? p.lots : this.lots,
        contract: p.contract != null ? p.contract : this.contract,
        sl: p.sl != null ? p.sl : null,
        tp: p.tp != null ? p.tp : null
      });
    }
    this._nextNo = 1;
    for (i = 0; i < this.positions.length; i++) {
      this._nextNo = Math.max(this._nextNo, (this.positions[i].no || 0) + 1);
    }
    this.trades = (d.trades || []).slice().sort(function (a, b) { return a.exitTime - b.exitTime; });
    this.orders = (d.orders || []).slice();
    // 旧版挂单没有 oco 字段, 当时是隐式 OCO (一张成交撤销其余); 迁移时保留该语义,
    // 否则升级后旧存档里的多张挂单会各自成交, 敞口突然放大。
    var legacyOco = false;
    for (i = 0; i < this.orders.length; i++) {
      var order = this.orders[i];
      if (order && typeof order === 'object' && !Object.prototype.hasOwnProperty.call(order, 'oco')) {
        order.oco = true;
        legacyOco = true;
      }
    }
    if (legacyOco) {
      this.oco = true;
      try { localStorage.setItem(OCO_KEY, '1'); } catch (e) { }
    }
    this.activePosId = d.activePosId != null && this._posIndex(d.activePosId) >= 0
      ? d.activePosId
      : (this.positions.length ? this.positions[this.positions.length - 1].id : null);
    // 旧周期的按钮/拖拽状态不能留到新数据上
    this._btns = {};
    this._slBtn = null;
    this._tpBtn = null;
    this._dragMode = null;
  };

  TradeBook.prototype.clear = function () {
    this.positions = [];
    this.activePosId = null;
    this._nextNo = 1;
    this.trades = [];
    this.orders = [];
    this.onUpdate();
  };

  global.TradeBook = TradeBook;
})(window);
