import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: process.env.CHANNEL || 'msedge' });
const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto('http://127.0.0.1:8766/', { waitUntil: 'networkidle' });
await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(900);

const ok = [], bad = [];
const check = (name, cond, extra = '') => (cond ? ok : bad).push(`${name}${extra ? ' :: ' + extra : ''}`);

await page.click('#btnTradePanel');
await page.waitForTimeout(400);
const box = await page.locator('#chartHost').boundingBox();

const bookState = () => page.evaluate(() => {
  const b = window.KR.book;
  return {
    count: b.positions.length,
    ids: b.positions.map((p) => p.id),
    nos: b.positions.map((p) => p.no),
    dirs: b.positions.map((p) => p.dir),
    lots: b.positions.map((p) => p.lots),
    entries: b.positions.map((p) => p.entryPrice),
    sls: b.positions.map((p) => p.sl),
    tps: b.positions.map((p) => p.tp),
    active: b.activePosId,
    legacyPos: b.position ? b.position.id : null,
    floating: b.floating(),
    sum: b.positions.reduce((s, p) => s + b.floatingOf(p), 0),
    trades: b.trades.length,
    orders: b.orders.length,
    statsOpen: b.stats().openCount,
    cursor: window.KR.state.cursor,
    close: window.KR.state.bars[window.KR.state.cursor].close
  };
});

async function resetBook() {
  await page.evaluate(() => {
    const b = window.KR.book;
    b.clear();
    b.setOco(false);
    try { localStorage.removeItem('kline-replay:oco-manual'); } catch (e) {}
  });
  await page.waitForTimeout(250);
}

async function openPos(dir, opts = {}) {
  return page.evaluate(([d, o]) => {
    const b = window.KR.book;
    const p = b.open(d, {
      lots: o.lots || 0.1,
      contract: 100,
      sl: o.sl == null ? null : o.sl,
      tp: o.tp == null ? null : o.tp
    });
    return p ? { id: p.id, no: p.no, entry: p.entryPrice } : null;
  }, [dir, opts]);
}

async function jumpToLow(price, limit = 6000) {
  const idx = await page.evaluate(([p, lim]) => {
    const bars = window.KR.state.bars;
    const cur = window.KR.state.cursor;
    for (let i = cur + 1; i < bars.length && i <= cur + lim; i++) if (bars[i].low <= p) return i;
    return -1;
  }, [price, limit]);
  if (idx >= 0) {
    await page.evaluate((i) => window.KR.api.setCursor(i), idx);
    await page.waitForTimeout(350);
  }
  return idx;
}

async function jumpToHigh(price, limit = 6000) {
  const idx = await page.evaluate(([p, lim]) => {
    const bars = window.KR.state.bars;
    const cur = window.KR.state.cursor;
    for (let i = cur + 1; i < bars.length && i <= cur + lim; i++) if (bars[i].high >= p) return i;
    return -1;
  }, [price, limit]);
  if (idx >= 0) {
    await page.evaluate((i) => window.KR.api.setCursor(i), idx);
    await page.waitForTimeout(350);
  }
  return idx;
}

/* ============================================================ 1. 连续多次开仓 */
await page.evaluate(() => window.KR.api.setCursor(8000));
await page.waitForTimeout(350);
await page.fill('#lotsInput', '0.1');
await page.fill('#contractInput', '100');
await page.click('#btnBuy');
await page.waitForTimeout(200);
await page.click('#btnBuy');
await page.waitForTimeout(200);
await page.click('#btnSell');
await page.waitForTimeout(400);

let st = await bookState();
check('同一位置连续开出 3 笔持仓', st.count === 3, JSON.stringify({ count: st.count, dirs: st.dirs }));
check('多空可以同时持有', st.dirs.filter((d) => d === 1).length === 2 && st.dirs.filter((d) => d === -1).length === 1,
  JSON.stringify(st.dirs));
check('每笔持仓有独立编号', st.nos.join(',') === '1,2,3', JSON.stringify(st.nos));
check('新开的持仓成为选中项', st.active === st.ids[2], `${st.active} vs ${st.ids[2]}`);
check('有持仓时买入按钮仍可用', (await page.isDisabled('#btnBuy')) === false);
check('面板列出 3 笔持仓', (await page.locator('.pos-item').count()) === 3);
check('面板出现全部平仓按钮', (await page.locator('#btnCloseAll').count()) === 1);
check('stats.openCount 同步', st.statsOpen === 3, String(st.statsOpen));

// 推进一段, 浮动盈亏 = 各单之和
await page.evaluate(() => window.KR.api.setCursor(window.KR.state.cursor + 30));
await page.waitForTimeout(400);
st = await bookState();
check('总浮盈等于各单浮盈之和', Math.abs(st.floating - st.sum) < 1e-6,
  `floating=${st.floating.toFixed(2)} sum=${st.sum.toFixed(2)}`);
const panelText = (await page.textContent('#posBlock')).replace(/\s+/g, ' ');
check('面板显示多单/空单数量', panelText.includes('多 2 / 空 1'), panelText.slice(0, 80));
check('面板显示总浮盈', panelText.includes(st.floating.toFixed(2)), `期望 ${st.floating.toFixed(2)}`);

// 同价加仓的图上标签不能重叠
const tags = await page.evaluate(() => {
  const b = window.KR.book;
  return b.positions.map((p) => (b._btns[p.id] ? b._btns[p.id].y : null));
});
const distinct = tags.filter((y) => y != null);
check('同价多单的图上标签自动错开',
  distinct.length === 3 && new Set(distinct.map((y) => Math.round(y))).size === 3,
  JSON.stringify(tags));

/* ============================================================ 2. 选中 / 单平 / 全部平仓 */
await page.locator('.pos-item').nth(1).click();
await page.waitForTimeout(300);
st = await bookState();
check('点击持仓行切换选中项', st.active === st.ids[1], `${st.active} vs ${st.ids[1]}`);
check('选中的行有高亮样式', (await page.locator('.pos-item').nth(1).getAttribute('class')).includes('active'));

await page.locator('.pos-close').nth(0).click();
await page.waitForTimeout(350);
st = await bookState();
check('行内 × 只平掉这一笔', st.count === 2 && st.trades === 1, JSON.stringify({ count: st.count, trades: st.trades }));
check('平仓后选中项不变', st.active === st.ids[0], `${st.active} vs ${st.ids[0]}`);

await page.locator('#chartHost').click({ position: { x: 50, y: 50 } });
await page.keyboard.press('e');
await page.waitForTimeout(350);
st = await bookState();
check('E 只平掉当前选中那一笔', st.count === 1 && st.trades === 2, JSON.stringify({ count: st.count, trades: st.trades }));

await page.click('#btnClosePos');
await page.waitForTimeout(350);
st = await bookState();
check('最后一笔平仓后面板清空', st.count === 0 && st.trades === 3 && st.legacyPos === null,
  JSON.stringify({ count: st.count, trades: st.trades }));
check('无持仓时隐藏全部平仓按钮', (await page.locator('#btnCloseAll').count()) === 0);
check('无持仓时提示当前无持仓', (await page.textContent('#posBlock')).includes('当前无持仓'));

/* ============================================================ 3. 挂单与持仓并存 */
await resetBook();
await page.evaluate(() => window.KR.api.setCursor(9000));
await page.waitForTimeout(300);
await openPos(1);
st = await bookState();
const c0 = st.close;
await page.evaluate((c) => window.KR.book.placeOrder('buy_limit', c - 5, { lots: 0.1, contract: 100 }), c0);
await page.waitForTimeout(300);
st = await bookState();
check('持仓中可以挂单', st.count === 1 && st.orders === 1, JSON.stringify({ count: st.count, orders: st.orders }));

await page.click('#btnBuy');
await page.waitForTimeout(300);
st = await bookState();
check('开新仓不清掉已有挂单', st.count === 2 && st.orders === 1, JSON.stringify({ count: st.count, orders: st.orders }));

const fillIdx = await jumpToLow(c0 - 5);
st = await bookState();
check('挂单在持仓期间照常成交', fillIdx > 0 && st.count === 3 && st.orders === 0,
  JSON.stringify({ idx: fillIdx, count: st.count, orders: st.orders }));
check('成交单没有覆盖旧持仓', st.count === 3 && st.trades === 0, JSON.stringify({ count: st.count, trades: st.trades }));

// 两张独立限价单都能成交
await resetBook();
await openPos(1);
st = await bookState();
const c1 = st.close;
await page.evaluate((c) => {
  const b = window.KR.book;
  b.placeOrder('buy_limit', c - 2, { lots: 0.1, contract: 100 });
  b.placeOrder('buy_limit', c - 6, { lots: 0.1, contract: 100 });
}, c1);
await page.waitForTimeout(300);
st = await bookState();
check('两张独立挂单并存', st.orders === 2, String(st.orders));
await jumpToLow(c1 - 6);
await page.waitForTimeout(300);
st = await bookState();
check('独立挂单两张都成交', st.count === 3 && st.orders === 0 && st.trades === 0,
  JSON.stringify({ count: st.count, orders: st.orders, trades: st.trades }));

// OCO 开关保留旧行为
await resetBook();
await openPos(1);
st = await bookState();
const c2 = st.close;
await page.evaluate(() => window.KR.book.setOco(true));
await page.waitForTimeout(200);
check('OCO 勾选后写入 book 状态', await page.evaluate(() => window.KR.book.oco === true));
check('OCO 勾选同步到面板复选框', await page.isChecked('#ocoInput'));
await page.evaluate((c) => {
  const b = window.KR.book;
  b.placeOrder('buy_limit', c - 2, { lots: 0.1, contract: 100 });
  b.placeOrder('buy_limit', c - 6, { lots: 0.1, contract: 100 });
}, c2);
await page.waitForTimeout(250);
check('OCO 两张挂单并存', (await bookState()).orders === 2);
await jumpToLow(c2 - 6);
await page.waitForTimeout(300);
st = await bookState();
check('OCO 一张成交撤销其余', st.count === 2 && st.orders === 0,
  JSON.stringify({ count: st.count, orders: st.orders }));
await page.evaluate(() => window.KR.book.setOco(false));
await page.waitForTimeout(200);

/* ============================================================ 4. 每笔止损互相独立 */
await resetBook();
await page.evaluate(() => window.KR.api.setCursor(10000));
await page.waitForTimeout(300);
st = await bookState();
const base = st.close;
const a = await openPos(1, { sl: base - 1 });
const b = await openPos(1);
st = await bookState();
check('两笔持仓各自的止损独立保存', st.count === 2 && st.sls[0] === base - 1 && st.sls[1] === null,
  JSON.stringify(st.sls));

await jumpToLow(base - 1);
await page.waitForTimeout(300);
st = await bookState();
check('只有触发止损的那一笔被平掉', st.count === 1 && st.ids[0] === b.id,
  JSON.stringify({ count: st.count, ids: st.ids, b: b.id }));
const slTrade = await page.evaluate(() => window.KR.book.trades[0]);
check('止损成交价与原因正确', slTrade && slTrade.reason === '止损' && Math.abs(slTrade.exitPrice - (base - 1)) < 1e-9,
  JSON.stringify(slTrade && { reason: slTrade.reason, exit: slTrade.exitPrice }));

// 非选中持仓的 SL 按钮同样可以直接拖
const c = await openPos(1);
await page.waitForTimeout(350);
await page.evaluate((id) => window.KR.book.setActivePosition(id), b.id);
await page.waitForTimeout(250);
const btns = await page.evaluate((id) => {
  const bkt = window.KR.book;
  const bt = bkt._btns[id];
  return bt ? { sl: bt.sl, tp: bt.tp } : null;
}, c.id);
check('每笔持仓都有独立的 SL/TP 按钮', !!btns && !!btns.sl && !!btns.tp, JSON.stringify(btns));
const targetSl = (await bookState()).close - 3;
const targetY = await page.evaluate((p) => window.KR.candle.priceToCoordinate(p), targetSl);
if (btns) {
  const cx = box.x + btns.sl.x + btns.sl.w / 2;
  const cy = box.y + btns.sl.y + btns.sl.h / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, box.y + targetY, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}
st = await bookState();
const ci = st.ids.indexOf(c.id);
check('拖动非选中持仓的 SL 只改这一笔',
  ci >= 0 && st.sls[ci] != null && Math.abs(st.sls[ci] - targetSl) < 1 && st.sls[0] == null,
  JSON.stringify({ sls: st.sls, target: targetSl }));
check('拖动时自动选中该持仓', st.active === c.id, `${st.active} vs ${c.id}`);
const hit = await page.evaluate((id) => {
  const b = window.KR.book;
  const p = b._posById(id);
  return b.hitTest(400, window.KR.candle.priceToCoordinate(p.sl));
}, c.id);
check('止损线可命中', hit === 'sl-line', String(hit));

await page.evaluate(() => window.KR.api.closeAll());
await page.waitForTimeout(300);
st = await bookState();
check('全部平仓一次清空', st.count === 0 && st.trades >= 3, JSON.stringify({ count: st.count, trades: st.trades }));

/* ============================================================ 5. 持久化 */
await resetBook();
await page.evaluate(() => window.KR.api.setCursor(11000));
await page.waitForTimeout(300);
st = await bookState();
const p1 = await openPos(1, { lots: 0.2, sl: st.close - 10, tp: st.close + 20 });
const p2 = await openPos(-1, { lots: 0.3, sl: st.close + 15, tp: st.close - 25 });
await page.evaluate((id) => window.KR.book.setActivePosition(id), p1.id);
await page.waitForTimeout(600);
const expected = await bookState();

const stored = await page.evaluate(() => {
  const k = Object.keys(localStorage).find((x) => x.startsWith('kline-replay:trades:'));
  if (!k) return null;
  const d = JSON.parse(localStorage.getItem(k));
  return { positions: (d.positions || []).length, active: d.activePosId, legacy: !!d.position };
});
check('多笔持仓写入 localStorage', stored && stored.positions === 2 && !stored.legacy, JSON.stringify(stored));

await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(900);
await page.click('#btnTradePanel');
await page.waitForTimeout(300);
st = await bookState();
check('刷新后两笔持仓都恢复', st.count === 2, JSON.stringify({ count: st.count }));
check('刷新后方向/手数/止损止盈都恢复',
  st.count === 2 && st.dirs[0] === 1 && st.dirs[1] === -1 && st.lots[0] === 0.2 && st.lots[1] === 0.3 &&
  st.entries[0] === expected.entries[0] && st.entries[1] === expected.entries[1] &&
  st.sls[0] === expected.sls[0] && st.sls[1] === expected.sls[1] &&
  st.tps[0] === expected.tps[0] && st.tps[1] === expected.tps[1],
  JSON.stringify({ dirs: st.dirs, lots: st.lots, entries: st.entries, sls: st.sls, tps: st.tps }));
check('刷新后保留选中项', st.active === p1.id, `${st.active} vs ${p1.id}`);
check('刷新后面板仍显示两行', (await page.locator('.pos-item').count()) === 2);

/* ============================================================ 6. 旧单持仓存档兼容 */
const legacyKey = await page.evaluate(() => {
  const k = Object.keys(localStorage).find((x) => x.startsWith('kline-replay:trades:'));
  return k || ('kline-replay:trades:' + window.KR.state.serverId + ':' + window.KR.state.symbol + ':' + window.KR.state.panes[0].period);
});
await page.evaluate((k) => {
  const cur = window.KR.state.cursor;
  const bar = window.KR.state.bars[cur];
  localStorage.setItem(k, JSON.stringify({
    position: {
      id: 'legacy-1', dir: 1, entryTime: bar.time, entryPrice: bar.close,
      lots: 0.5, contract: 100, sl: null, tp: null
    },
    trades: [],
    orders: []
  }));
}, legacyKey);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(900);
st = await bookState();
check('旧版单持仓存档可迁移成持仓数组', st.count === 1 && st.legacyPos === 'legacy-1' && st.nos[0] === 1,
  JSON.stringify({ count: st.count, legacy: st.legacyPos, nos: st.nos }));
check('旧存档迁移后手数保留', Math.abs(st.lots[0] - 0.5) < 1e-9, String(st.lots[0]));

/* ============================================================ 6b. OCO 开关对已有挂单生效 */
await resetBook();
await page.evaluate(() => window.KR.api.setCursor(12000));
await page.waitForTimeout(300);
const toggleC = await page.evaluate(() => window.KR.state.bars[window.KR.state.cursor].close);
await page.evaluate((c) => {
  const b = window.KR.book;
  b.placeOrder('buy_limit', c - 2, { lots: 0.1, contract: 100 });
  b.placeOrder('buy_limit', c - 6, { lots: 0.1, contract: 100 });
}, toggleC);
await page.waitForTimeout(250);
let flags = await page.evaluate(() => window.KR.book.orders.map((o) => o.oco === true));
check('OCO 关闭时挂单独立', flags.length === 2 && flags.every((v) => !v), JSON.stringify(flags));

await page.evaluate(() => window.KR.book.setOco(true));
await page.waitForTimeout(250);
flags = await page.evaluate(() => window.KR.book.orders.map((o) => o.oco === true));
check('勾选 OCO 同步已有挂单', flags.length === 2 && flags.every((v) => v), JSON.stringify(flags));
check('勾选 OCO 后面板复选框同步', await page.isChecked('#ocoInput'));
await jumpToLow(toggleC - 6);
await page.waitForTimeout(300);
st = await bookState();
check('运行中开启 OCO 后一张成交撤销其余', st.count === 1 && st.orders === 0,
  JSON.stringify({ count: st.count, orders: st.orders }));
await page.evaluate(() => window.KR.book.setOco(false));

/* ============================================================ 6c. OCO 切换后刷新仍生效 */
await resetBook();
await page.evaluate(() => window.KR.api.setCursor(12500));
await page.waitForTimeout(300);
const persistC = await page.evaluate(() => window.KR.state.bars[window.KR.state.cursor].close);
await page.evaluate((c) => {
  const b = window.KR.book;
  b.placeOrder('buy_limit', c - 2, { lots: 0.1, contract: 100 });
  b.placeOrder('buy_limit', c - 6, { lots: 0.1, contract: 100 });
}, persistC);
await page.waitForTimeout(200);
await page.evaluate(() => window.KR.book.setOco(true));
await page.waitForTimeout(700);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(900);
await page.click('#btnTradePanel');
await page.waitForTimeout(300);
await page.evaluate(() => window.KR.api.setCursor(12500));
await page.waitForTimeout(300);
check('刷新后 OCO 开关保持勾选', await page.isChecked('#ocoInput'));
const persistedOco = await page.evaluate(() => ({
  count: window.KR.book.orders.length,
  flags: window.KR.book.orders.map((o) => o.oco === true)
}));
check('刷新后挂单 OCO 标记保持',
  persistedOco.count === 2 && persistedOco.flags.every((v) => v), JSON.stringify(persistedOco));
await jumpToLow(persistC - 6);
await page.waitForTimeout(300);
st = await bookState();
check('刷新后 OCO 挂单一张成交撤销其余', st.count === 1 && st.orders === 0,
  JSON.stringify({ count: st.count, orders: st.orders }));

/* ============================================================ 6d. 关闭 OCO 后刷新不再互斥 */
await resetBook();
await page.evaluate(() => window.KR.api.setCursor(13500));
await page.waitForTimeout(300);
const offC = await page.evaluate(() => window.KR.state.bars[window.KR.state.cursor].close);
await page.evaluate(() => window.KR.book.setOco(true));
await page.evaluate((c) => {
  const b = window.KR.book;
  b.placeOrder('buy_limit', c - 2, { lots: 0.1, contract: 100 });
  b.placeOrder('buy_limit', c - 6, { lots: 0.1, contract: 100 });
}, offC);
await page.waitForTimeout(200);
await page.evaluate(() => window.KR.book.setOco(false));
await page.waitForTimeout(700);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(900);
await page.click('#btnTradePanel');
await page.waitForTimeout(300);
await page.evaluate(() => window.KR.api.setCursor(13500));
await page.waitForTimeout(300);
check('刷新后 OCO 关闭状态保持', !(await page.isChecked('#ocoInput')));
const persistedNoOco = await page.evaluate(() => window.KR.book.orders.map((o) => o.oco === true));
check('刷新后挂单 OCO 标记关闭', persistedNoOco.length === 2 && persistedNoOco.every((v) => !v),
  JSON.stringify(persistedNoOco));
await jumpToLow(offC - 6);
await page.waitForTimeout(300);
st = await bookState();
check('刷新后关闭 OCO 两张挂单各自成交', st.count === 2 && st.orders === 0,
  JSON.stringify({ count: st.count, orders: st.orders }));

/* ============================================================ 6e. 旧版挂单存档迁移 */
await resetBook();
await page.evaluate(() => window.KR.api.setCursor(13000));
await page.waitForTimeout(300);
const legacyC = await page.evaluate(() => window.KR.state.bars[window.KR.state.cursor].close);
const legacyOrders = await page.evaluate((c) => {
  const b = window.KR.book;
  const bar = window.KR.state.bars[window.KR.state.cursor];
  b.restore({
    positions: [],
    trades: [],
    orders: [
      { id: 'legacy-o1', type: 'buy_limit', price: c - 2, lots: 0.1, contract: 100, sl: null, tp: null, createdTime: bar.time },
      { id: 'legacy-o2', type: 'buy_limit', price: c - 6, lots: 0.1, contract: 100, sl: null, tp: null, createdTime: bar.time }
    ]
  });
  return { oco: b.oco, count: b.orders.length, flags: b.orders.map((o) => o.oco === true) };
}, legacyC);
await page.waitForTimeout(300);
check('旧版挂单迁移后保留 OCO 语义',
  legacyOrders.oco === false && legacyOrders.count === 2 && legacyOrders.flags.every((v) => v),
  JSON.stringify(legacyOrders));
check('旧版挂单迁移不影响全局 OCO 开关',
  legacyOrders.oco === false && !(await page.isChecked('#ocoInput')), JSON.stringify({ oco: legacyOrders.oco }));

// 迁移标记必须落盘, 否则第二次刷新时旧挂单会被全局开关覆盖回独立成交
await page.waitForTimeout(700);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(900);
await page.click('#btnTradePanel');
await page.waitForTimeout(300);
await page.evaluate(() => window.KR.api.setCursor(13000));
await page.waitForTimeout(300);
const legacyReloaded = await page.evaluate(() => ({
  oco: window.KR.book.oco,
  flags: window.KR.book.orders.map((o) => o.oco === true),
  markers: window.KR.book.orders.map((o) => o.ocoLegacy === true)
}));
check('旧版挂单迁移标记跨刷新保持',
  legacyReloaded.oco === false && legacyReloaded.flags.length === 2 &&
  legacyReloaded.flags.every((v) => v) && legacyReloaded.markers.every((v) => v),
  JSON.stringify(legacyReloaded));
check('旧版挂单迁移后开关仍关闭', !(await page.isChecked('#ocoInput')));

await jumpToLow(legacyC - 6);
await page.waitForTimeout(300);
st = await bookState();
check('旧版挂单一张成交撤销其余', st.count === 1 && st.orders === 0,
  JSON.stringify({ count: st.count, orders: st.orders }));

/* ============================================================ 6f. 手动切换 OCO 后旧挂单例外跨 key 失效 */
await resetBook();
await page.evaluate(() => window.KR.api.setCursor(14500));
await page.waitForTimeout(300);
const manualC = await page.evaluate(() => window.KR.state.bars[window.KR.state.cursor].close);
const manualOco = await page.evaluate((c) => {
  const b = window.KR.book;
  b.setOco(false);      // 模拟用户在另一个品种/周期手动切换 OCO
  const bar = window.KR.state.bars[window.KR.state.cursor];
  b.restore({
    positions: [],
    trades: [],
    orders: [
      { id: 'manual-o1', type: 'buy_limit', price: c - 2, lots: 0.1, contract: 100, sl: null, tp: null, createdTime: bar.time },
      { id: 'manual-o2', type: 'buy_limit', price: c - 6, lots: 0.1, contract: 100, sl: null, tp: null, createdTime: bar.time }
    ]
  });
  return {
    oco: b.oco,
    flags: b.orders.map((o) => o.oco === true),
    markers: b.orders.map((o) => o.ocoLegacy === true)
  };
}, manualC);
await page.waitForTimeout(300);
check('手动切换 OCO 后旧挂单不再例外',
  manualOco.oco === false && manualOco.flags.every((v) => !v) && manualOco.markers.every((v) => !v),
  JSON.stringify(manualOco));
check('手动切换 OCO 后开关保持关闭', !(await page.isChecked('#ocoInput')));
await jumpToLow(manualC - 6);
await page.waitForTimeout(300);
st = await bookState();
check('手动切换 OCO 后旧挂单各自成交', st.count === 2 && st.orders === 0,
  JSON.stringify({ count: st.count, orders: st.orders }));

/* ============================================================ 6g. 持仓编号跨刷新不重复 */
await resetBook();
await page.evaluate(() => window.KR.api.setCursor(14000));
await page.waitForTimeout(300);
await openPos(1);
await openPos(1);
await page.evaluate(() => window.KR.api.closeAll());
await page.waitForTimeout(700);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(900);
await page.click('#btnTradePanel');
await page.waitForTimeout(300);
await page.evaluate(() => window.KR.api.setCursor(14000));
await page.waitForTimeout(300);
const reopened = await openPos(1);
st = await bookState();
check('清仓刷新后新持仓编号接着成交记录',
  reopened && reopened.no === 3 && st.nos[0] === 3,
  JSON.stringify({ no: reopened && reopened.no, nos: st.nos }));
check('清仓刷新后成交记录仍在', st.trades >= 2, JSON.stringify({ trades: st.trades }));

/* ============================================================ 6h. 挂单自动成交不抢走选中持仓 */
await resetBook();
await page.evaluate(() => window.KR.api.setCursor(15000));
await page.waitForTimeout(300);
const selected = await openPos(1);
await openPos(1);
await page.evaluate((id) => window.KR.book.setActivePosition(id), selected.id);
await page.waitForTimeout(250);
const fillC = await page.evaluate(() => window.KR.state.bars[window.KR.state.cursor].close);
await page.evaluate((c) => window.KR.book.placeOrder('buy_limit', c - 2, { lots: 0.1, contract: 100 }), fillC);
await page.waitForTimeout(200);
await jumpToLow(fillC - 2);
await page.waitForTimeout(300);
st = await bookState();
check('挂单自动成交不抢走选中持仓', st.count === 3 && st.active === selected.id,
  JSON.stringify({ count: st.count, active: st.active, selected: selected.id }));
check('成交单已加入持仓列表', st.count === 3 && st.nos.indexOf(3) >= 0,
  JSON.stringify({ nos: st.nos }));

/* ============================================================ 6i. restore 重新读取全局 OCO */
await resetBook();
await page.evaluate(() => window.KR.api.setCursor(14700));
await page.waitForTimeout(300);
const staleOco = await page.evaluate(() => {
  const b = window.KR.book;
  b.oco = false;                                  // 模拟当前页缓存了旧值
  localStorage.setItem('kline-replay:oco', '1');   // 模拟另一个标签页已改成开启
  const bar = window.KR.state.bars[window.KR.state.cursor];
  b.restore({
    positions: [],
    trades: [],
    orders: [
      { id: 'stale-o1', type: 'buy_limit', price: bar.close - 2, lots: 0.1, contract: 100, sl: null, tp: null, oco: false, createdTime: bar.time }
    ]
  });
  return { oco: b.oco, flags: b.orders.map((o) => o.oco === true) };
});
await page.waitForTimeout(300);
check('restore 重新读取全局 OCO 开关',
  staleOco.oco === true && staleOco.flags.every((v) => v), JSON.stringify(staleOco));
await page.evaluate(() => window.KR.book.setOco(false));

/* ============================================================ 6j. 拖拽中持仓被平掉 */
await resetBook();
await page.evaluate(() => window.KR.api.setCursor(15500));
await page.waitForTimeout(300);
const dragBase = await page.evaluate(() => window.KR.state.bars[window.KR.state.cursor].close);
const dragA = await openPos(1, { sl: dragBase - 5 });
await openPos(1, { sl: dragBase - 8 });
await page.evaluate((id) => window.KR.book.setActivePosition(id), dragA.id);
await page.waitForTimeout(250);
const dragY = await page.evaluate((p) => window.KR.candle.priceToCoordinate(p), dragBase - 2);
const dragRes = await page.evaluate(([aId, y]) => {
  const b = window.KR.book;
  const other = b.positions.filter((p) => p.id !== aId)[0];
  const before = other ? other.sl : null;
  b._dragMode = { kind: 'sl-button', id: aId };
  b.closePosition(aId, '测试');
  b.dragMove(300, y);
  b.dragEnd();
  return { before, after: b.positions.length ? b.positions[0].sl : null, count: b.positions.length };
}, [dragA.id, dragY]);
check('拖拽中持仓被平掉不会改到别的单',
  dragRes.count === 1 && dragRes.after === dragRes.before, JSON.stringify(dragRes));

/* ============================================================ 6k. 全部平仓只刷新一次 */
await resetBook();
await page.evaluate(() => window.KR.api.setCursor(16000));
await page.waitForTimeout(300);
await openPos(1);
await openPos(1);
await openPos(1);
const bulkClose = await page.evaluate(() => {
  const b = window.KR.book;
  let n = 0;
  const orig = b.onUpdate;
  b.onUpdate = function () { n++; return orig.apply(this, arguments); };
  const closed = b.closeAll('测试');
  b.onUpdate = orig;
  return { n, closed: closed.length, positions: b.positions.length, trades: b.trades.length };
});
check('全部平仓只触发一次刷新',
  bulkClose.n === 1 && bulkClose.closed === 3 && bulkClose.positions === 0 && bulkClose.trades === 3,
  JSON.stringify(bulkClose));

/* ============================================================ 7. 多窗格持仓互不影响 */
await resetBook();
await openPos(1);
await page.click('#layoutSwitch button[data-layout="2"]');
await page.waitForFunction(() => window.KR.state.panes.length === 2 && window.KR.state.panes[1].bars.length > 0,
  { timeout: 20000 });
await page.waitForTimeout(500);
// 新窗格可能没有覆盖当前时间点的 K 线 (cursor = -1), 先回到两窗格都有数据的最新位置
await page.evaluate(() => window.KR.api.setCursor(window.KR.state.panes[1].bars.length - 1));
await page.waitForTimeout(400);
await page.evaluate(() => {
  const p = window.KR.state.panes[1];
  p.book.open(1, { lots: 0.1, contract: 100 });
});
await page.waitForTimeout(300);
const paneCounts = await page.evaluate(() => window.KR.state.panes.map((p) => p.book.positions.length));
check('两个窗格的持仓互不影响', paneCounts.length === 2 && paneCounts[0] === 1 && paneCounts[1] === 1,
  JSON.stringify(paneCounts));

/* ============================================================ 7b. 切窗格后交易面板不串数据 */
await page.click('#layoutSwitch button[data-layout="1"]');
await page.waitForTimeout(700);
await resetBook();
await page.evaluate(() => window.KR.api.setCursor(16000));
await page.waitForTimeout(300);
await openPos(1);
await page.evaluate(() => { window.KR.book.close('测试'); });
await page.waitForTimeout(300);
const panelTradeCount0 = await page.evaluate(() => document.querySelectorAll('#tradeList .trade-item').length);
await page.click('#layoutSwitch button[data-layout="2"]');
await page.waitForFunction(() => window.KR.state.panes.length === 2 && window.KR.state.panes[1].bars.length > 0,
  { timeout: 20000 });
await page.waitForTimeout(500);
await page.evaluate(() => window.KR.api.setCursor(window.KR.state.panes[1].bars.length - 1));
await page.waitForTimeout(400);
const clickPane = async (idx) => {
  const pt = await page.evaluate((i) => {
    const r = window.KR.state.panes[i].els.wrap.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, idx);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(350);
};
await clickPane(1);
const panelDuringOther = await page.evaluate(() => ({
  active: window.KR.state.activeIndex,
  trades: document.querySelectorAll('#tradeList .trade-item').length
}));
await clickPane(0);
const panelBack = await page.evaluate(() => ({
  active: window.KR.state.activeIndex,
  trades: document.querySelectorAll('#tradeList .trade-item').length
}));
check('切回原窗格后交易面板恢复该窗格成交记录',
  panelTradeCount0 === 1 && panelDuringOther.active === 1 && panelDuringOther.trades === 0 &&
    panelBack.active === 0 && panelBack.trades === 1,
  JSON.stringify({ panelTradeCount0, panelDuringOther, panelBack }));
await page.click('#layoutSwitch button[data-layout="1"]');
await page.waitForTimeout(700);

/* ============================================================ 7c. 回退后状态栏/交易面板跟随光标 */
await resetBook();
await page.evaluate(() => window.KR.api.setCursor(16000));
await page.waitForTimeout(300);
await openPos(1);
await page.waitForTimeout(250);
const beforeBack = await page.evaluate(() => ({
  cursor: window.KR.state.panes[0].cursor,
  entryTime: window.KR.state.panes[0].book.positions[0].entryTime
}));
await page.evaluate(() => window.KR.api.setCursor(window.KR.state.cursor - 5));
await page.waitForTimeout(400);
const afterBack = await page.evaluate(() => {
  const p = window.KR.state.panes[0];
  const b = p.book;
  const c = p.cursor;
  const bar = p.bars[c];
  const total = p.bars.length;
  return {
    cursor: c,
    barTime: bar.time,
    entryTime: b.positions[0] ? b.positions[0].entryTime : null,
    barPos: document.getElementById('barPos').textContent,
    expectedBarPos: (c + 1).toLocaleString('en-US') + ' / ' + total.toLocaleString('en-US') + ' 根',
    tpEntry: document.getElementById('tpEntryPrice').textContent,
    expectedEntry: bar.close.toFixed(p.digits),
    floating: +b.floating().toFixed(2),
    posFl: (document.querySelector('#posBlock .pos-fl') || {}).textContent || '',
    legend: document.getElementById('legend').textContent
  };
});
check('回退 5 根后状态栏根数与光标一致',
  afterBack.cursor === beforeBack.cursor - 5 && afterBack.barPos === afterBack.expectedBarPos,
  JSON.stringify({ cursor: afterBack.cursor, barPos: afterBack.barPos }));
check('回退到开仓前时交易面板浮盈归零且参考价跟随',
  afterBack.entryTime === beforeBack.entryTime && afterBack.entryTime > afterBack.barTime &&
    afterBack.floating === 0 && afterBack.posFl.trim() === '+0.00' &&
    afterBack.tpEntry === afterBack.expectedEntry &&
    afterBack.legend.includes(afterBack.expectedEntry),
  JSON.stringify({ floating: afterBack.floating, posFl: afterBack.posFl, tpEntry: afterBack.tpEntry, expected: afterBack.expectedEntry }));

/* ============================================================ 8. 截图 */
if (await page.locator('#tradePanel').isHidden()) {
  await page.click('#btnTradePanel');
  await page.waitForTimeout(500);
}
await page.evaluate(() => {
  const b = window.KR.book;
  b.clear();
  b.setOco(false);
  window.KR.api.setCursor(15000);
});
await page.waitForTimeout(300);
const shot = await bookState();
await openPos(1, { lots: 0.2, sl: shot.close - 30, tp: shot.close + 40 });
await page.evaluate(() => window.KR.api.setCursor(window.KR.state.cursor + 20));
await page.waitForTimeout(300);
const shot2 = await bookState();
await openPos(1, { lots: 0.1, sl: shot2.close - 25, tp: shot2.close + 30 });
await openPos(-1, { lots: 0.15, sl: shot2.close + 25, tp: shot2.close - 30 });
await page.evaluate(() => {
  const b = window.KR.book;
  b.setActivePosition(b.positions[1].id);
});
await page.evaluate(() => window.KR.api.setCursor(window.KR.state.cursor + 6));
await page.waitForTimeout(700);
await page.screenshot({ path: 'shots/22-multi-positions.png' });

console.log('通过:');
ok.forEach((s) => console.log('  ✓ ' + s));
if (bad.length) { console.log('失败:'); bad.forEach((s) => console.log('  ✗ ' + s)); }
console.log('控制台错误:', errors.length ? errors.join(' | ') : '(无)');

await browser.close();
process.exitCode = bad.length || errors.length ? 1 : 0;
