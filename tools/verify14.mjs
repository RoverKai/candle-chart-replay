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
await page.waitForTimeout(350);
let box = await page.locator('#chartHost').boundingBox();

const bookState = () => page.evaluate(() => {
  const b = window.KR.book;
  const p = b.position;
  return {
    count: b.positions.length,
    lots: p ? p.lots : null,
    entry: p ? p.entryPrice : null,
    close: b.currentClose(),
    sl: p ? p.sl : null,
    tp: p ? p.tp : null,
    slLots: p ? p.slLots : null,
    tpLots: p ? p.tpLots : null,
    trades: b.trades.map((t) => ({ lots: t.lots, reason: t.reason, exit: t.exitPrice, pnl: t.pnl }))
  };
});

async function dragTag(toPrice) {
  const g = await page.evaluate((price) => {
    const b = window.KR.book;
    const p = b.activePosition();
    return {
      tag: b._btns[p.id].tag,
      y: window.KR.candle.priceToCoordinate(price)
    };
  }, toPrice);
  const sx = box.x + g.tag.x + g.tag.w / 2;
  const sy = box.y + g.tag.y + g.tag.h / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx, box.y + g.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(350);
}

async function clickTag() {
  const tag = await page.evaluate(() => {
    const b = window.KR.book;
    const p = b.activePosition();
    return b._btns[p.id].tag;
  });
  await page.mouse.click(box.x + tag.x + tag.w / 2, box.y + tag.y + tag.h / 2);
  await page.waitForTimeout(350);
}

async function clickPriceLine(price) {
  const y = await page.evaluate((v) => window.KR.candle.priceToCoordinate(v), price);
  await page.mouse.move(box.x + 500, box.y + y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(350);
}

/* ============================================================ 1. 成本线拖动自动识别 */
const spot = await page.evaluate(() => {
  const bars = window.KR.state.bars;
  for (let i = 8000; i < 16000; i += 25) {
    if (bars[i + 80] && bars[i + 80].close > bars[i].close + 12) return { i };
  }
  return null;
});
check('找到确定性上涨样本', !!spot, spot ? String(spot.i) : '');
await page.evaluate((i) => window.KR.api.setCursor(i), spot.i);
await page.waitForTimeout(300);
await page.click('#btnBuy');
await page.waitForTimeout(500);
let st = await bookState();
check('开多仓成功', st.count === 1, JSON.stringify({ entry: st.entry, close: st.close }));
const firstEntry = st.entry;
const firstId = await page.evaluate(() => window.KR.book.position.id);

await dragTag(st.close + 40);
let panel = await page.evaluate(() => ({
  hidden: document.getElementById('levelPop').hidden,
  slPrice: document.getElementById('lpSlPrice').value,
  tpPrice: document.getElementById('lpTpPrice').value,
  tpLots: document.getElementById('lpTpLots').value,
  tpFocus: document.getElementById('lpTpRow').classList.contains('focus'),
  hint: document.getElementById('lpHint').textContent
}));
st = await bookState();
check('拖动成本线后弹出设置面板', panel.hidden === false);
check('拖到现价上方自动识别为止盈', st.tp != null && st.tp > st.close && st.sl == null,
  JSON.stringify({ tp: st.tp, close: st.close, sl: st.sl }));
check('面板自动高亮止盈行', panel.tpFocus === true, panel.tpFocus ? '' : JSON.stringify(panel));
check('面板提示自动识别结果', panel.hint.includes('已自动识别为') && panel.hint.includes('止盈'), panel.hint);

check('新止盈默认手数为空（全部仓位）', panel.tpLots === '', JSON.stringify({ tpLots: panel.tpLots }));
await page.fill('#lpTpLots', '0.04');
await page.click('#lpApply');
await page.waitForTimeout(350);
st = await bookState();
check('止盈手数可设为 0.04', st.tpLots === 0.04, JSON.stringify({ tp: st.tp, tpLots: st.tpLots }));
check('应用后设置面板关闭', await page.locator('#levelPop').isHidden());
check('持仓面板显示止盈手数', (await page.textContent('#posBlock')).includes('0.04手'));

await dragTag(st.close - 40);
panel = await page.evaluate(() => ({
  hidden: document.getElementById('levelPop').hidden,
  slPrice: document.getElementById('lpSlPrice').value,
  tpPrice: document.getElementById('lpTpPrice').value,
  slFocus: document.getElementById('lpSlRow').classList.contains('focus'),
  hint: document.getElementById('lpHint').textContent
}));
st = await bookState();
check('拖到现价下方自动识别为止损', st.sl != null && st.sl < st.close, JSON.stringify({ sl: st.sl, close: st.close }));
check('面板自动高亮止损行', panel.slFocus === true, JSON.stringify(panel));
check('止损面板同时显示已有止盈', panel.tpPrice !== '' && Number(panel.tpPrice) > st.close, panel.tpPrice);
await page.fill('#lpSlLots', '0.03');
await page.click('#lpApply');
await page.waitForTimeout(350);
st = await bookState();
check('止损手数可设为 0.03', st.slLots === 0.03, JSON.stringify({ sl: st.sl, slLots: st.slLots }));

/* ============================================================ 2. 点击线/标签打开面板、取消 */
await clickPriceLine(st.tp);
panel = await page.evaluate(() => ({
  hidden: document.getElementById('levelPop').hidden,
  tpPrice: document.getElementById('lpTpPrice').value,
  tpLots: document.getElementById('lpTpLots').value,
  slLots: document.getElementById('lpSlLots').value,
  tpFocus: document.getElementById('lpTpRow').classList.contains('focus')
}));
check('单击止盈线可打开设置面板', panel.hidden === false);
check('面板带出止盈价格与手数', Number(panel.tpPrice) === Number(st.tp.toFixed(2)) && Number(panel.tpLots) === 0.04,
  JSON.stringify(panel));
check('单击线时高亮对应行', panel.tpFocus === true);

await page.click('#lpSlClear');
await page.waitForTimeout(300);
st = await bookState();
check('面板清除按钮可取消止损', st.sl == null, JSON.stringify({ sl: st.sl }));
check('清除后面板保持打开', (await page.locator('#levelPop').isVisible()));
await page.click('#lpClose');

await clickTag();
panel = await page.evaluate(() => ({
  hidden: document.getElementById('levelPop').hidden,
  slFocus: document.getElementById('lpSlRow').classList.contains('focus'),
  tpFocus: document.getElementById('lpTpRow').classList.contains('focus')
}));
check('单击成本线标签打开完整面板', panel.hidden === false && !panel.slFocus && !panel.tpFocus, JSON.stringify(panel));

const manualSl = st.close - 500;
await page.fill('#lpSlPrice', String(manualSl));
await page.fill('#lpSlLots', '0.02');
await page.click('#lpApply');
await page.waitForTimeout(350);
st = await bookState();
check('可在面板手工设置止损价格', st.sl != null && Math.abs(st.sl - manualSl) < 0.02, JSON.stringify({ sl: st.sl, want: manualSl }));
check('可在面板手工设置止损手数', st.slLots === 0.02, String(st.slLots));

await page.waitForTimeout(300);
const tpX = await page.evaluate(() => {
  const b = window.KR.book;
  return b._levelHits[b.position.id + ':tp'];
});
check('图上止盈标签带 × 取消按钮', !!tpX, JSON.stringify(tpX));
await page.mouse.click(box.x + tpX.x + 8, box.y + tpX.y + 8);
await page.waitForTimeout(400);
st = await bookState();
check('点图上 × 可取消止盈', st.tp == null, JSON.stringify({ tp: st.tp }));
check('持仓面板同步显示—', (await page.textContent('#posBlock')).includes('止盈 TP'));

/* ============================================================ 3. 部分平仓 */
const partial = await page.evaluate(() => {
  const b = window.KR.book;
  const p = b.position;
  const tp = b.currentClose() + 1;
  b.setLevel(p.id, 'tp', tp, 0.04);
  return { tp, lotsBefore: p.lots };
});
await page.waitForTimeout(350);
const hitIdx = await page.evaluate((tp) => {
  const bars = window.KR.state.bars;
  for (let i = window.KR.state.cursor + 1; i < bars.length; i++) if (bars[i].high >= tp) return i;
  return -1;
}, partial.tp);
check('找到触发部分止盈的未来 K 线', hitIdx > 0, String(hitIdx));
if (hitIdx > 0) await page.evaluate((i) => window.KR.api.setCursor(i), hitIdx);
await page.waitForTimeout(500);
st = await bookState();
check('部分止盈后仓位仍在', st.count === 1 && Math.abs(st.lots - 0.06) < 1e-9,
  JSON.stringify({ count: st.count, lots: st.lots, before: partial.lotsBefore }));
check('部分止盈只平 0.04 手', st.trades.length === 1 && st.trades[0].lots === 0.04 && st.trades[0].reason === '止盈',
  JSON.stringify(st.trades));
check('触发后的止盈被清除', st.tp == null && st.tpLots == null, JSON.stringify({ tp: st.tp, tpLots: st.tpLots }));
check('剩余止损不受影响', st.sl != null && st.slLots === 0.02, JSON.stringify({ sl: st.sl, slLots: st.slLots }));

/* ============================================================ 4. 持久化 */
await page.waitForTimeout(700);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(900);
if (await page.locator('#tradePanel').isHidden()) {
  await page.click('#btnTradePanel');
  await page.waitForTimeout(300);
}
box = await page.locator('#chartHost').boundingBox();
st = await bookState();
check('刷新后剩余仓位恢复', st.count === 1 && Math.abs(st.lots - 0.06) < 1e-9, JSON.stringify({ lots: st.lots }));
check('刷新后止损价格与手数恢复', st.sl != null && st.slLots === 0.02, JSON.stringify({ sl: st.sl, slLots: st.slLots }));
check('刷新后已触发的止盈保持清除', st.tp == null, JSON.stringify({ tp: st.tp }));

/* ============================================================ 5. 全部手数触发整笔平仓 */
const full = await page.evaluate(() => {
  const b = window.KR.book;
  const p = b.position;
  const tp = b.currentClose() + 1;
  b.setLevel(p.id, 'tp', tp, p.lots);
  return { tp, lots: p.lots, id: p.id };
});
await page.waitForTimeout(350);
const fullIdx = await page.evaluate((tp) => {
  const bars = window.KR.state.bars;
  for (let i = window.KR.state.cursor + 1; i < bars.length; i++) if (bars[i].high >= tp) return i;
  return -1;
}, full.tp);
check('找到整笔止盈的触发 K 线', fullIdx > 0, String(fullIdx));
if (fullIdx > 0) await page.evaluate((i) => window.KR.api.setCursor(i), fullIdx);
await page.waitForTimeout(500);
st = await bookState();
check('止盈手数等于全部仓位时整笔平仓', st.count === 0, JSON.stringify({ count: st.count, lots: st.lots }));
check('整笔止盈成交手数正确', st.trades.some((t) => t.reason === '止盈' && t.lots === Number(full.lots.toFixed(2))),
  JSON.stringify(st.trades));

/* ============================================================ 6. 空头方向相反 */
await page.evaluate(() => {
  window.KR.book.clear();
  window.KR.api.setCursor(9000);
});
await page.waitForTimeout(400);
await page.click('#btnSell');
await page.waitForTimeout(500);
st = await bookState();
check('开空仓成功', st.count === 1 && st.entry === st.close, JSON.stringify({ entry: st.entry, close: st.close }));
await dragTag(st.close + 40);
st = await bookState();
panel = await page.evaluate(() => ({ hint: document.getElementById('lpHint').textContent }));
check('空头拖到现价上方自动识别为止损', st.sl != null && st.tp == null, JSON.stringify({ sl: st.sl, tp: st.tp }));
check('空头止损提示正确', panel.hint.includes('已自动识别为') && panel.hint.includes('止损'), panel.hint);
await page.click('#lpClose');
await dragTag(st.close - 40);
st = await bookState();
check('空头拖到现价下方自动识别为止盈', st.tp != null && st.sl != null, JSON.stringify({ sl: st.sl, tp: st.tp }));
await page.fill('#lpTpLots', '0.05');
await page.click('#lpApply');
await page.waitForTimeout(350);
st = await bookState();
check('空头止盈手数可设置', st.tpLots === 0.05, JSON.stringify({ tp: st.tp, tpLots: st.tpLots }));

/* ============================================================ 7. 右键菜单 */
const tpY = await page.evaluate(() => window.KR.candle.priceToCoordinate(window.KR.book.position.tp));
await page.mouse.click(box.x + 500, box.y + tpY, { button: 'right' });
await page.waitForTimeout(300);
const menuText = await page.textContent('#ctxMenu');
check('右键止盈线出现设置入口', menuText.includes('止盈设置'), menuText.slice(0, 120));
check('右键止盈线出现取消入口', menuText.includes('取消止盈'));
const cancelItem = page.locator('#ctxMenu .ctx-item', { hasText: '取消止盈' });
if (await cancelItem.count()) await cancelItem.click();
await page.waitForTimeout(400);
st = await bookState();
check('右键取消止盈生效', st.tp == null, JSON.stringify({ tp: st.tp }));

/* ============================================================ 8. 部分止损 */
const slSetup = await page.evaluate(() => {
  const b = window.KR.book;
  const p = b.position;
  const sl = b.currentClose() + 1;
  b.setLevel(p.id, 'sl', sl, 0.03);
  return { sl, lots: p.lots };
});
await page.waitForTimeout(350);
const slIdx = await page.evaluate((sl) => {
  const bars = window.KR.state.bars;
  for (let i = window.KR.state.cursor + 1; i < bars.length; i++) if (bars[i].high >= sl) return i;
  return -1;
}, slSetup.sl);
check('找到触发部分止损的未来 K 线', slIdx > 0, String(slIdx));
if (slIdx > 0) await page.evaluate((i) => window.KR.api.setCursor(i), slIdx);
await page.waitForTimeout(500);
st = await bookState();
check('部分止损后仓位仍在', st.count === 1 && Math.abs(st.lots - 0.07) < 1e-9,
  JSON.stringify({ count: st.count, lots: st.lots, before: slSetup.lots }));
check('部分止损只平 0.03 手', st.trades.length > 0 && st.trades[st.trades.length - 1].lots === 0.03 &&
  st.trades[st.trades.length - 1].reason === '止损', JSON.stringify(st.trades));
check('触发后的止损被清除', st.sl == null && st.slLots == null, JSON.stringify({ sl: st.sl, slLots: st.slLots }));

console.log('通过:');
ok.forEach((s) => console.log('  ✓ ' + s));
if (bad.length) { console.log('失败:'); bad.forEach((s) => console.log('  ✗ ' + s)); }
console.log('控制台错误:', errors.length ? errors.join(' | ') : '(无)');

await browser.close();
process.exitCode = bad.length || errors.length ? 1 : 0;
