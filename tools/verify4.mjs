import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
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

// 先打开交易面板（挂单列表在这里，不打开就不可见）
await page.click('#btnTradePanel');
await page.waitForTimeout(400);

const box = await page.locator('#chartHost').boundingBox();
const P = (fx, fy) => [Math.round(box.x + box.width * fx), Math.round(box.y + box.height * fy)];
const state = () => page.evaluate(() => ({
  orders: window.KR.book.orders.length,
  pos: !!window.KR.book.position,
  trades: window.KR.book.trades.length
}));

// ---- 1. 视图变化后画布自动重绘（成本线跟随的机制）
const before = await page.evaluate(() => window.KR.drawLayer.redrawCount || 0);
await page.evaluate(() => {
  const ts = window.KR.chart.timeScale();
  const r = ts.getVisibleLogicalRange();
  ts.setVisibleLogicalRange({ from: r.from - 60, to: r.to - 60 });
});
await page.waitForTimeout(350);
const after = await page.evaluate(() => window.KR.drawLayer.redrawCount || 0);
check('平移视图自动重绘', after > before, `redraw ${before} -> ${after}`);

// 缩放也算
const before2 = await page.evaluate(() => window.KR.drawLayer.redrawCount);
await page.evaluate(() => {
  const ts = window.KR.chart.timeScale();
  const r = ts.getVisibleLogicalRange();
  ts.setVisibleLogicalRange({ from: r.from + 20, to: r.to - 20 });
});
await page.waitForTimeout(350);
const after2 = await page.evaluate(() => window.KR.drawLayer.redrawCount);
check('缩放视图自动重绘', after2 > before2, `redraw ${before2} -> ${after2}`);

// ---- 2. 右键菜单
await page.evaluate(() => window.KR.api.setCursor(window.KR.state.cursor - 120));
await page.waitForTimeout(300);
await page.mouse.click(...P(0.45, 0.45), { button: 'right' });
await page.waitForTimeout(250);

check('右键菜单打开', await page.isVisible('#ctxMenu'));
const items = await page.$$eval('.ctx-item', (els) => els.map((e) => e.textContent.trim()));
const want = ['市价买入', '市价卖出', '买入限价', '卖出限价', '买入止损', '卖出止损'];
check('菜单含 6 个交易项', want.every((t) => items.some((i) => i.startsWith(t))), items.join(' | '));

// ---- 3. 菜单里市价买入
await page.locator('.ctx-item', { hasText: '市价买入' }).click();
await page.waitForTimeout(300);
let st = await state();
check('菜单市价买入成功', st.pos === true, JSON.stringify(st));
check('菜单已关闭', !(await page.isVisible('#ctxMenu')));

// 平仓并跳到数据中段（保证后面有足够 K 线可以走）
await page.evaluate(() => window.KR.api.close());
await page.evaluate(() => { window.KR.book.cancelAllOrders(); window.KR.api.setCursor(8000); });
await page.waitForTimeout(400);

// ---- 4. 挂单：买入限价（点在现价下方）
const closeNow = await page.evaluate(() => window.KR.state.bars[window.KR.state.cursor].close);
await page.mouse.click(...P(0.55, 0.72), { button: 'right' });
await page.waitForTimeout(250);
await page.locator('.ctx-item', { hasText: '买入限价' }).click();
await page.waitForTimeout(300);

st = await state();
const order = await page.evaluate(() => window.KR.book.orders[0] || null);
check('挂单已创建', st.orders === 1, JSON.stringify(st));
check('买入限价在现价下方', order && order.price < closeNow, order ? `${order.price.toFixed(2)} < ${closeNow.toFixed(2)}` : 'null');
check('面板显示挂单', (await page.textContent('#ordersBlock')).includes('买入限价'));

// ---- 5. 推进直到成交
await page.evaluate(() => {
  for (let i = 0; i < 4000 && !window.KR.book.position; i++) {
    window.KR.api.setCursor(window.KR.state.cursor + 1);
  }
});
await page.waitForTimeout(400);
st = await state();
const pos = await page.evaluate(() => window.KR.book.position);
check('限价单触发成交', st.pos === true && st.orders === 0, JSON.stringify(st));
check('成交价不高于挂单价', pos && pos.entryPrice <= order.price + 1e-9,
  pos ? `${pos.entryPrice.toFixed(2)} <= ${order.price.toFixed(2)}` : 'null');

await page.evaluate(() => window.KR.api.close());
await page.evaluate(() => { window.KR.book.cancelAllOrders(); window.KR.api.setCursor(12000); });
await page.waitForTimeout(400);

// ---- 6. 多张挂单独立触发：一张成交后其余挂单保留（多持仓模式）
const c2 = await page.evaluate(() => window.KR.state.bars[window.KR.state.cursor].close);
await page.evaluate((c) => {
  const b = window.KR.book;
  b.placeOrder('buy_limit', c - 3, { lots: 0.1, contract: 100 });
  b.placeOrder('sell_limit', c + 3, { lots: 0.1, contract: 100 });
}, c2);
await page.waitForTimeout(300);
st = await state();
check('两张挂单并存', st.orders === 2, JSON.stringify(st));

await page.evaluate(() => {
  for (let i = 0; i < 4000 && !window.KR.book.position; i++) {
    window.KR.api.setCursor(window.KR.state.cursor + 1);
  }
});
await page.waitForTimeout(400);
st = await state();
check('一张挂单成交', st.pos === true, JSON.stringify(st));
check('成交后其余挂单保留', st.orders === 1, JSON.stringify(st));

await page.evaluate(() => window.KR.api.close());
await page.evaluate(() => window.KR.book.cancelAllOrders());
await page.waitForTimeout(250);

// ---- 7. 面板取消挂单
await page.evaluate((c) => window.KR.book.placeOrder('buy_limit', c - 5, { lots: 0.1, contract: 100 }), c2);
await page.waitForTimeout(300);
let beforeCancel = await state();
check('取消前有挂单', beforeCancel.orders >= 1, JSON.stringify(beforeCancel));
await page.locator('#ordersList .cancel').first().click();
await page.waitForTimeout(300);
st = await state();
check('面板取消挂单', st.orders === beforeCancel.orders - 1, `${beforeCancel.orders} -> ${st.orders}`);

// ---- 8. 挂单持久化
await page.evaluate((c) => window.KR.book.placeOrder('buy_stop', c + 8, { lots: 0.1, contract: 100 }), c2);
await page.waitForTimeout(400);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(900);
st = await state();
check('刷新后挂单恢复', st.orders === 1, JSON.stringify(st));

// ---- 9. 截图
await page.evaluate(() => window.KR.api.setCursor(window.KR.state.cursor - 80));
await page.waitForTimeout(300);
await page.mouse.click(...P(0.42, 0.38), { button: 'right' });
await page.waitForTimeout(300);
await page.screenshot({ path: 'shots/08-orders-menu.png' });
await page.keyboard.press('Escape');

const posLine = await page.evaluate(() => {
  const b = window.KR.book;
  const y = window.KR.candle.priceToCoordinate(b.orders[0] ? b.orders[0].price : 0);
  return y !== null;
});
check('挂单线可定位', posLine);

console.log('通过:');
ok.forEach((s) => console.log('  ✓ ' + s));
if (bad.length) { console.log('失败:'); bad.forEach((s) => console.log('  ✗ ' + s)); }
console.log('控制台错误:', errors.length ? errors.join(' | ') : '(无)');

await browser.close();
process.exitCode = bad.length || errors.length ? 1 : 0;
