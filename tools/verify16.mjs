import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

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
await page.waitForTimeout(350);
let box = await page.locator('#chartHost').boundingBox();

const bookState = () => page.evaluate(() => {
  const b = window.KR.book;
  return {
    count: b.positions.length,
    positions: b.positions.map((p) => ({
      id: p.id, no: p.no, dir: p.dir, lots: p.lots,
      entryReason: p.entryReason, sl: p.sl, tp: p.tp,
      slReason: p.slReason, tpReason: p.tpReason
    })),
    trades: b.trades.map((t) => ({
      lots: t.lots, reason: t.reason, exitReason: t.exitReason,
      entryReason: t.entryReason, pnl: t.pnl
    })),
    orders: b.orders.map((o) => ({ id: o.id, price: o.price, entryReason: o.entryReason })),
    active: b.activePosId
  };
});

const hintText = async () => String((await page.textContent('#hint')) || '').trim();
const activeId = () => page.evaluate(() => (document.activeElement && document.activeElement.id) || '');

async function reset() {
  await page.evaluate(() => window.KR.book.clear());
  await page.waitForTimeout(250);
}

async function setCursor(i) {
  await page.evaluate((n) => window.KR.api.setCursor(n), i);
  await page.waitForTimeout(300);
}

async function currentClose() {
  return page.evaluate(() => window.KR.book.currentClose());
}

async function openPos(reason, opts = {}) {
  await page.fill('#entryReason', reason);
  if (opts.sl != null) await page.fill('#slInput', String(opts.sl));
  if (opts.tp != null) await page.fill('#tpTargetInput', String(opts.tp));
  if (opts.slReason != null) await page.fill('#slReasonInput', opts.slReason);
  if (opts.tpReason != null) await page.fill('#tpReasonInput', opts.tpReason);
  await page.click(opts.dir === -1 ? '#btnSell' : '#btnBuy');
  await page.waitForTimeout(320);
}

async function closeViaDialog(reason) {
  await page.click('#btnClosePos');
  await page.waitForTimeout(150);
  if (reason != null) await page.fill('#reasonText', reason);
  await page.click('#reasonConfirm');
  await page.waitForTimeout(320);
}

async function openLevelOf(id, kind) {
  await page.evaluate(([pid, k]) => window.KR.api.openLevel(pid, k), [id, kind]);
  await page.waitForTimeout(200);
}

async function dragTagTo(price) {
  const g = await page.evaluate((p) => {
    const b = window.KR.book;
    const pos = b.activePosition();
    return { tag: b._btns[pos.id].tag, y: window.KR.candle.priceToCoordinate(p) };
  }, price);
  await page.mouse.move(box.x + g.tag.x + g.tag.w / 2, box.y + g.tag.y + g.tag.h / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + g.tag.x + g.tag.w / 2, box.y + g.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(320);
}

/* ============================================================ 1. 入场理由为空的各入口 */
await reset();
await page.fill('#entryReason', '');
await page.click('#btnBuy');
await page.waitForTimeout(200);
let st = await bookState();
check('空入场理由点击买入不产生持仓', st.count === 0, JSON.stringify(st.count));
check('空入场理由提示正确', (await hintText()).includes('请先填写入场理由'), await hintText());
check('空入场理由自动聚焦输入框', (await activeId()) === 'entryReason', await activeId());

await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
await page.locator('#chartHost').click({ position: { x: 40, y: 40 } });
await page.keyboard.press('q');
await page.waitForTimeout(250);
st = await bookState();
check('Q 键同样被入场理由阻止', st.count === 0, JSON.stringify(st.count));

await page.fill('#entryReason', '   ');
await page.click('#btnBuy');
await page.waitForTimeout(200);
st = await bookState();
check('全空白入场理由按空处理', st.count === 0, JSON.stringify(st.count));

/* ============================================================ 2. 右键市价 / 挂单入口 */
await page.fill('#entryReason', '');
await setCursor(8000);
const close0 = await currentClose();
const belowY = await page.evaluate((p) => window.KR.candle.priceToCoordinate(p), close0 - 3);
await page.mouse.click(box.x + box.width * 0.55, box.y + belowY, { button: 'right' });
await page.waitForTimeout(250);
await page.locator('#ctxMenu .ctx-item', { hasText: '买入限价' }).click();
await page.waitForTimeout(250);
st = await bookState();
check('空理由右键挂单被阻止', st.orders.length === 0, JSON.stringify(st.orders));
check('空理由挂单提示正确', (await hintText()).includes('请先填写入场理由'), await hintText());

await page.fill('#entryReason', '挂单入场理由');
await page.mouse.click(box.x + box.width * 0.55, box.y + belowY, { button: 'right' });
await page.waitForTimeout(250);
await page.locator('#ctxMenu .ctx-item', { hasText: '买入限价' }).click();
await page.waitForTimeout(300);
st = await bookState();
check('填写理由后挂单成功', st.orders.length === 1 && st.orders[0].entryReason === '挂单入场理由',
  JSON.stringify(st.orders));
check('挂单成功后清空入场理由', (await page.inputValue('#entryReason')) === '');
const orderPrice = st.orders[0].price;
const fillIdx = await page.evaluate((price) => {
  const bars = window.KR.state.bars;
  for (let i = window.KR.state.cursor + 1; i < bars.length; i++) if (bars[i].low <= price) return i;
  return -1;
}, orderPrice);
check('找到挂单成交 K 线', fillIdx > 0, String(fillIdx));
if (fillIdx > 0) await setCursor(fillIdx);
st = await bookState();
check('挂单成交后持仓继承入场理由', st.count === 1 && st.positions[0].entryReason === '挂单入场理由',
  JSON.stringify(st.positions));
check('挂单成交后挂单清空', st.orders.length === 0, JSON.stringify(st.orders));

/* ============================================================ 3. 开仓表单的初始止盈止损理由 */
await reset();
await setCursor(8000);
let c = await currentClose();
await page.fill('#entryReason', '初始止损止盈');
await page.fill('#slInput', String(Number((c - 3).toFixed(2))));
await page.fill('#tpTargetInput', String(Number((c + 3).toFixed(2))));
await page.click('#btnBuy');
await page.waitForTimeout(250);
st = await bookState();
check('初始止损缺少理由时不开仓', st.count === 0, JSON.stringify(st.count));
check('初始止损缺少理由提示正确', (await hintText()).includes('止损理由'), await hintText());
check('初始止损缺少理由聚焦止损理由', (await activeId()) === 'slReasonInput', await activeId());

await page.fill('#slReasonInput', '跌破回踩低点');
await page.click('#btnBuy');
await page.waitForTimeout(250);
st = await bookState();
check('初始止盈缺少理由时不开仓', st.count === 0, JSON.stringify(st.count));
check('初始止盈缺少理由提示正确', (await hintText()).includes('止盈理由'), await hintText());

await page.fill('#tpReasonInput', '到前高阻力');
await page.click('#btnBuy');
await page.waitForTimeout(350);
st = await bookState();
check('补齐初始理由后成功开仓', st.count === 1, JSON.stringify(st.count));
check('初始止盈止损理由写入持仓',
  st.positions[0] && st.positions[0].slReason === '跌破回踩低点' && st.positions[0].tpReason === '到前高阻力',
  JSON.stringify(st.positions[0]));
check('开仓成功后清空入场理由', (await page.inputValue('#entryReason')) === '');

await page.click('#btnBuy');
await page.waitForTimeout(200);
st = await bookState();
check('下一笔开仓必须重新填写理由', st.count === 1, JSON.stringify(st.count));
await openPos('第二笔入场理由');
st = await bookState();
check('第二笔理由独立保存', st.count === 2 && st.positions[1].entryReason === '第二笔入场理由',
  JSON.stringify(st.positions.map((p) => p.entryReason)));

/* ============================================================ 4. 止盈止损设置面板理由 */
await reset();
await setCursor(9000);
await openPos('止盈止损面板测试');
let id = (await bookState()).positions[0].id;
c = await currentClose();
await openLevelOf(id, 'sl');
await page.fill('#lpSlPrice', String(Number((c - 5).toFixed(2))));
await page.click('#lpApply');
await page.waitForTimeout(250);
st = await bookState();
check('止损理由为空时设置被拒绝', st.positions[0].sl == null, JSON.stringify(st.positions[0]));
check('止损理由为空时面板错误提示', (await page.textContent('#lpHint')).includes('止损理由'), await page.textContent('#lpHint'));
await page.fill('#lpSlReason', '跌破支撑位');
await page.click('#lpApply');
await page.waitForTimeout(300);
st = await bookState();
check('填写止损理由后设置成功',
  st.positions[0].sl != null && st.positions[0].slReason === '跌破支撑位', JSON.stringify(st.positions[0]));
check('应用后止盈止损面板关闭', await page.locator('#levelPop').isHidden());
check('持仓面板显示止损理由', (await page.textContent('#posBlock')).includes('跌破支撑位'), await page.textContent('#posBlock'));

await openLevelOf(id, 'tp');
await page.fill('#lpTpPrice', String(Number((c + 5).toFixed(2))));
await page.fill('#lpTpReason', '前高目标');
await page.click('#lpApply');
await page.waitForTimeout(300);
st = await bookState();
check('填写止盈理由后设置成功',
  st.positions[0].tp != null && st.positions[0].tpReason === '前高目标', JSON.stringify(st.positions[0]));

// 只改理由也应落盘
await openLevelOf(id, 'tp');
await page.fill('#lpTpReason', '前高目标（修正）');
await page.click('#lpApply');
await page.waitForTimeout(800);
const storedWhy = await page.evaluate(() => {
  const k = Object.keys(localStorage).find((x) => x.startsWith('kline-replay:trades:'));
  if (!k) return null;
  const d = JSON.parse(localStorage.getItem(k));
  return d.positions && d.positions[0] ? d.positions[0].tpReason : null;
});
check('只修改理由也会写入 localStorage', storedWhy === '前高目标（修正）', String(storedWhy));

// 待确认档位即使原样点应用也要立即落盘（签名未变时不能只存在内存）
await dragTagTo(c + 20);
await page.waitForTimeout(800);
const pendingApplyReason = await page.inputValue('#lpTpReason');
const pendingApplyPrice = Number(await page.inputValue('#lpTpPrice'));
check('拖动已有止盈时带出原理由', pendingApplyReason === '前高目标（修正）', pendingApplyReason);
await page.click('#lpApply');
await page.waitForTimeout(300);
const storedAppliedTp = await page.evaluate(() => {
  const k = Object.keys(localStorage).find((x) => x.startsWith('kline-replay:trades:'));
  if (!k) return null;
  const d = JSON.parse(localStorage.getItem(k));
  return d.positions && d.positions[0] ? d.positions[0].tp : null;
});
check('待确认档位原样应用立即落盘', storedAppliedTp != null && Math.abs(storedAppliedTp - pendingApplyPrice) < 1e-6,
  JSON.stringify({ pendingApplyPrice, storedAppliedTp }));

// 清除止盈止损时理由一起清除
await openLevelOf(id, 'sl');
await page.click('#lpSlClear');
await page.waitForTimeout(250);
st = await bookState();
check('清除止损同时清空理由', st.positions[0].sl == null && st.positions[0].slReason == null,
  JSON.stringify(st.positions[0]));
await page.click('#lpClose');

/* ============================================================ 5. 拖拽只预览，应用后才写入 */
await reset();
await setCursor(9500);
await openPos('拖拽理由测试');
id = (await bookState()).positions[0].id;
c = await currentClose();
await dragTagTo(c + 20);
st = await bookState();
const dragPending = await page.evaluate(() => {
  const b = window.KR.book;
  const p = b.position;
  return b.hasPendingLevel(p.id, 'tp');
});
check('拖成本线后表单打开', await page.locator('#levelPop').isVisible());
check('拖拽未填理由前只是待确认档位', dragPending === true && st.positions[0].tp != null,
  JSON.stringify({ pending: dragPending, tp: st.positions[0].tp }));
check('拖拽草稿价已填入面板', (await page.inputValue('#lpTpPrice')) !== '', await page.inputValue('#lpTpPrice'));
await page.waitForTimeout(800);
const storedPendingTp = await page.evaluate(() => {
  const k = Object.keys(localStorage).find((x) => x.startsWith('kline-replay:trades:'));
  if (!k) return 'missing';
  const d = JSON.parse(localStorage.getItem(k));
  return d.positions && d.positions[0] ? d.positions[0].tp : undefined;
});
check('未应用的拖动档位不会落盘', storedPendingTp == null, JSON.stringify({ storedTp: storedPendingTp }));
await page.click('#lpClose');
await page.waitForTimeout(200);
st = await bookState();
check('取消拖拽不改变止盈', st.positions[0].tp == null, JSON.stringify(st.positions[0]));

await dragTagTo(c + 20);
await page.fill('#lpTpReason', '拖拽止盈理由');
await page.click('#lpApply');
await page.waitForTimeout(350);
st = await bookState();
const dragCleared = await page.evaluate(() => {
  const b = window.KR.book;
  const p = b.position;
  return !b.hasPendingLevel(p.id, 'tp');
});
check('拖拽后填写理由应用才写入止盈',
  st.positions[0].tp != null && st.positions[0].tpReason === '拖拽止盈理由' && dragCleared,
  JSON.stringify({ tp: st.positions[0].tp, why: st.positions[0].tpReason, pending: !dragCleared }));

/* ============================================================ 6. 平仓理由弹窗 */
await reset();
await setCursor(10000);
await openPos('平仓入口测试');
await page.click('#btnClosePos');
await page.waitForTimeout(200);
check('平仓按钮打开理由弹窗', await page.locator('#reasonDialog').isVisible());
check('平仓弹窗标题正确', (await page.textContent('#reasonTitle')) === '平仓理由');
await page.click('#reasonConfirm');
await page.waitForTimeout(200);
st = await bookState();
check('空平仓理由不成交', st.count === 1 && st.trades.length === 0, JSON.stringify({ count: st.count, trades: st.trades.length }));
check('空平仓理由弹窗保持打开', await page.locator('#reasonDialog').isVisible());
check('空平仓理由显示内联错误', (await page.textContent('#reasonError')).includes('请填写平仓理由'));
await page.fill('#reasonText', '看错,但"止损"执行');
await page.click('#reasonConfirm');
await page.waitForTimeout(350);
st = await bookState();
check('填写平仓理由后成交', st.count === 0 && st.trades.length === 1, JSON.stringify({ count: st.count, trades: st.trades.length }));
check('成交记录保存平仓理由与原因',
  st.trades[0].reason === '手动平仓' && st.trades[0].exitReason === '看错,但"止损"执行',
  JSON.stringify(st.trades[0]));
check('成交记录保存入场理由', st.trades[0].entryReason === '平仓入口测试', JSON.stringify(st.trades[0]));
check('平仓后弹窗关闭', await page.locator('#reasonDialog').isHidden());
check('成交列表显示平仓理由', (await page.textContent('#tradeList')).includes('看错,但'), await page.textContent('#tradeList'));

/* ============================================================ 7. E / 行内 × / 全部平仓 / 右键 */
await reset();
await openPos('E 键平仓理由');
await page.locator('#chartHost').click({ position: { x: 40, y: 40 } });
await page.keyboard.press('e');
await page.waitForTimeout(200);
check('E 键打开平仓理由弹窗', await page.locator('#reasonDialog').isVisible());
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
st = await bookState();
check('Esc 取消平仓弹窗不成交', st.count === 1 && st.trades.length === 0, JSON.stringify(st));

await page.locator('#chartHost').click({ position: { x: 40, y: 40 } });
await page.keyboard.press('e');
await page.waitForTimeout(200);
await page.fill('#reasonText', 'E 键平仓理由');
await page.click('#reasonConfirm');
await page.waitForTimeout(300);

await reset();
await openPos('行内平仓一');
await openPos('行内平仓二');
st = await bookState();
check('准备两笔持仓', st.count === 2, JSON.stringify(st.count));
await page.locator('.pos-close').nth(0).click();
await page.waitForTimeout(200);
check('行内 × 打开平仓理由弹窗', await page.locator('#reasonDialog').isVisible());
await page.fill('#reasonText', '行内 × 理由');
await page.click('#reasonConfirm');
await page.waitForTimeout(300);
st = await bookState();
check('行内 × 只平掉一笔', st.count === 1, JSON.stringify(st.count));

await openPos('全部平仓理由二');
st = await bookState();
check('准备两笔全部平仓', st.count === 2, JSON.stringify(st.count));
await page.click('#btnCloseAll');
await page.waitForTimeout(200);
check('全部平仓打开理由弹窗', await page.locator('#reasonDialog').isVisible());
check('全部平仓弹窗标题正确', (await page.textContent('#reasonTitle')).includes('全部平仓'));
await page.fill('#reasonText', '全部离场理由');
await page.click('#reasonConfirm');
await page.waitForTimeout(350);
st = await bookState();
check('全部平仓后清空', st.count === 0, JSON.stringify(st.count));
const allWhy = st.trades.filter((t) => t.exitReason === '全部离场理由').length;
check('全部平仓同一理由记入每一笔', allWhy >= 2, JSON.stringify(st.trades));

await reset();
await openPos('右键平仓理由');
await page.mouse.click(box.x + 420, box.y + 300, { button: 'right' });
await page.waitForTimeout(250);
const closeItem = page.locator('#ctxMenu .ctx-item').filter({ hasText: '平仓' }).first();
check('右键菜单出现平仓入口', (await closeItem.count()) > 0);
if (await closeItem.count()) await closeItem.click();
await page.waitForTimeout(200);
check('右键平仓打开理由弹窗', await page.locator('#reasonDialog').isVisible());
await page.click('#reasonCancel');

/* ============================================================ 8. 自动止盈止损继承理由 */
await reset();
await setCursor(11000);
c = await currentClose();
await openPos('自动止损理由', { sl: Number((c - 2).toFixed(2)), slReason: '跌破就止损' });
let sl = (await bookState()).positions[0].sl;
let hit = await page.evaluate((price) => {
  const bars = window.KR.state.bars;
  for (let i = window.KR.state.cursor + 1; i < bars.length; i++) if (bars[i].low <= price) return i;
  return -1;
}, sl);
check('找到自动止损触发 K 线', hit > 0, String(hit));
if (hit > 0) await setCursor(hit);
st = await bookState();
check('自动止损成交原因正确', st.trades.length > 0 && st.trades[st.trades.length - 1].reason === '止损',
  JSON.stringify(st.trades));
check('自动止损继承止损理由', st.trades.length > 0 && st.trades[st.trades.length - 1].exitReason === '跌破就止损',
  JSON.stringify(st.trades));

await reset();
c = await currentClose();
await openPos('自动止盈理由', { tp: Number((c + 2).toFixed(2)), tpReason: '到目标就止盈' });
let tp = (await bookState()).positions[0].tp;
hit = await page.evaluate((price) => {
  const bars = window.KR.state.bars;
  for (let i = window.KR.state.cursor + 1; i < bars.length; i++) if (bars[i].high >= price) return i;
  return -1;
}, tp);
check('找到自动止盈触发 K 线', hit > 0, String(hit));
if (hit > 0) await setCursor(hit);
st = await bookState();
check('自动止盈继承止盈理由', st.trades.length > 0 && st.trades[st.trades.length - 1].exitReason === '到目标就止盈',
  JSON.stringify(st.trades));

// 部分止盈
await reset();
c = await currentClose();
await openPos('部分止盈理由', { tp: Number((c + 2).toFixed(2)), tpReason: '部分止盈理由' });
id = (await bookState()).positions[0].id;
await page.evaluate(([pid, price]) => window.KR.book.setLevel(pid, 'tp', price, 0.05, '部分止盈理由'), [id, Number((c + 2).toFixed(2))]);
await page.waitForTimeout(250);
tp = (await bookState()).positions[0].tp;
hit = await page.evaluate((price) => {
  const bars = window.KR.state.bars;
  for (let i = window.KR.state.cursor + 1; i < bars.length; i++) if (bars[i].high >= price) return i;
  return -1;
}, tp);
if (hit > 0) await setCursor(hit);
st = await bookState();
check('部分止盈后剩余仓位仍在', st.count === 1 && Math.abs(st.positions[0].lots - 0.05) < 1e-9,
  JSON.stringify(st.positions));
check('部分止盈成交继承理由', st.trades.length > 0 && st.trades[st.trades.length - 1].exitReason === '部分止盈理由',
  JSON.stringify(st.trades));

/* ============================================================ 9. 转义 / XSS */
await reset();
c = await currentClose();
await openPos('<img src=x onerror="window.__xss=1">');
await page.waitForTimeout(300);
const xss = await page.evaluate(() => ({
  imgs: document.querySelectorAll('#posBlock img').length,
  flag: window.__xss,
  text: document.getElementById('posBlock').textContent
}));
check('理由中的 HTML 不会生成元素', xss.imgs === 0 && !xss.flag, JSON.stringify(xss));
check('理由按原文显示', xss.text.includes('<img src=x'), xss.text.slice(0, 120));

/* ============================================================ 10. CSV 理由列与转义 */
await reset();
c = await currentClose();
await openPos('入场,含"引号"');
await closeViaDialog('看错,但"止损"执行');
await openPos('=1+1');
await closeViaDialog('@SUM(A1)');
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#btnExportTrades')
]);
const dlPath = await download.path();
const csv = await readFile(dlPath, 'utf8');
check('CSV 表头含入场理由/平仓理由',
  csv.includes('入场理由') && csv.includes('平仓理由') && csv.includes('止损理由') && csv.includes('止盈理由'),
  csv.split('\r\n')[0]);
check('CSV 含完整理由文本', csv.includes('入场,含""引号""') && csv.includes('看错,但""止损""执行'),
  csv.split('\r\n').slice(1, 3).join(' / '));
check('CSV 对公式前缀做防护', csv.includes("'=1+1") && csv.includes("'@SUM(A1)"), csv.split('\r\n').slice(1, 3).join(' / '));
check('CSV 保留 BOM', csv.charCodeAt(0) === 0xfeff, String(csv.charCodeAt(0)));

/* ============================================================ 11. 持久化 / 旧存档兼容 */
await reset();
await setCursor(12000);
c = await currentClose();
await openPos('持久化入场理由', {
  sl: Number((c - 2).toFixed(2)), slReason: '持久化止损理由',
  tp: Number((c + 2).toFixed(2)), tpReason: '持久化止盈理由'
});
await page.waitForTimeout(800);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(900);
if (await page.locator('#tradePanel').isHidden()) {
  await page.click('#btnTradePanel');
  await page.waitForTimeout(300);
}
st = await bookState();
check('刷新后入场理由恢复', st.count === 1 && st.positions[0].entryReason === '持久化入场理由',
  JSON.stringify(st.positions));
check('刷新后止盈止损理由恢复',
  st.positions[0] && st.positions[0].slReason === '持久化止损理由' &&
  st.positions[0].tpReason === '持久化止盈理由',
  JSON.stringify(st.positions[0]));

const legacyKey = await page.evaluate(() => {
  const k = Object.keys(localStorage).find((x) => x.startsWith('kline-replay:trades:'));
  return k || ('kline-replay:trades:' + window.KR.state.serverId + ':' + window.KR.state.symbol + ':' + window.KR.state.panes[0].period);
});
await page.evaluate((k) => {
  const bar = window.KR.state.bars[window.KR.state.cursor];
  localStorage.setItem(k, JSON.stringify({
    position: {
      id: 'legacy-reason-1', dir: 1, entryTime: bar.time, entryPrice: bar.close,
      lots: 0.5, contract: 100, sl: null, tp: null
    },
    trades: [],
    orders: []
  }));
}, legacyKey);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(900);
if (await page.locator('#tradePanel').isHidden()) {
  await page.click('#btnTradePanel');
  await page.waitForTimeout(300);
}
st = await bookState();
check('旧存档无理由可正常加载', st.count === 1 && st.positions[0].entryReason === '',
  JSON.stringify(st.positions));
check('旧存档持仓显示未填写理由', (await page.textContent('#posBlock')).includes('未填写'),
  (await page.textContent('#posBlock')).slice(0, 160));
await page.click('#btnClosePos');
await page.waitForTimeout(200);
await page.fill('#reasonText', '旧仓位平仓理由');
await page.click('#reasonConfirm');
await page.waitForTimeout(300);
st = await bookState();
check('旧持仓平仓仍需理由并正确记录',
  st.count === 0 && st.trades[0] && st.trades[0].exitReason === '旧仓位平仓理由',
  JSON.stringify(st.trades[0]));

/* ============================================================ 12. 多窗格理由隔离 */
await reset();
await page.click('#layoutSwitch button[data-layout="2"]');
await page.waitForFunction(() => window.KR.state.panes.length === 2 && window.KR.state.panes[1].bars.length > 0,
  { timeout: 20000 });
await page.waitForTimeout(500);
await page.evaluate(() => window.KR.api.setCursor(window.KR.state.panes[1].bars.length - 1));
await page.waitForTimeout(400);
await page.evaluate(() => {
  const p = window.KR.state.panes[1];
  p.book.open(1, { lots: 0.1, contract: 100, entryReason: '窗格 2 的理由' });
});
await page.waitForTimeout(300);
const paneReasons = await page.evaluate(() => window.KR.state.panes.map((p) => ({
  count: p.book.positions.length,
  reason: p.book.positions[0] ? p.book.positions[0].entryReason : null
})));
check('多窗格理由互不串单', paneReasons[0].count === 0 && paneReasons[1].count === 1 &&
  paneReasons[1].reason === '窗格 2 的理由', JSON.stringify(paneReasons));
await page.click('#layoutSwitch button[data-layout="1"]');
await page.waitForTimeout(700);

/* ============================================================ 13. 截图 */
await reset();
await page.evaluate(() => window.KR.api.setCursor(10000));
await page.waitForTimeout(300);
const shotClose = await currentClose();
await openPos('M5 回踩趋势线不破，结构仍多', {
  sl: Number((shotClose - 5).toFixed(2)), slReason: '跌破回踩低点',
  tp: Number((shotClose + 8).toFixed(2)), tpReason: '前高阻力位'
});
await page.waitForTimeout(400);
await page.screenshot({ path: 'shots/26-trade-reasons.png' });

await page.click('#btnClosePos');
await page.waitForTimeout(300);
await page.screenshot({ path: 'shots/27-close-reason.png' });
await page.click('#reasonCancel');
await page.waitForTimeout(150);

const shotId = (await bookState()).positions[0].id;
await openLevelOf(shotId, 'sl');
await page.waitForTimeout(300);
await page.screenshot({ path: 'shots/28-level-reason.png' });
await page.click('#lpClose');

console.log('通过:');
ok.forEach((s) => console.log('  ✓ ' + s));
if (bad.length) { console.log('失败:'); bad.forEach((s) => console.log('  ✗ ' + s)); }
console.log('控制台错误:', errors.length ? errors.join(' | ') : '(无)');

await browser.close();
process.exitCode = bad.length || errors.length ? 1 : 0;
