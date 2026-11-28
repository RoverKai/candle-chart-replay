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

await page.click('#btnTradePanel');
await page.waitForTimeout(400);
const box = await page.locator('#chartHost').boundingBox();

// 找一段确定性上涨的行情（保证测得到"盈利后上移止损"）
const spot = await page.evaluate(() => {
  const bars = window.KR.state.bars;
  for (let i = 8000; i < 16000; i += 25) {
    if (bars[i + 80] && bars[i + 80].close > bars[i].close + 12) {
      return { i, c0: bars[i].close, c1: bars[i + 80].close };
    }
  }
  return null;
});
check('找到上涨样本', !!spot, spot ? `${spot.c0.toFixed(2)} -> ${spot.c1.toFixed(2)}` : '');

await page.evaluate((i) => window.KR.api.setCursor(i), spot.i);
await page.waitForTimeout(300);
await page.fill('#entryReason', 'M5 回踩支撑后做多');
await page.click('#btnBuy');
await page.waitForTimeout(400);
await page.evaluate((i) => window.KR.api.setCursor(i + 80), spot.i);
await page.waitForTimeout(500);

const st0 = await page.evaluate(() => {
  const p = window.KR.book.position;
  const close = window.KR.state.bars[window.KR.state.cursor].close;
  return { entry: p.entryPrice, close: close, sl: p.sl, tp: p.tp, floating: window.KR.book.floating() };
});
check('持仓浮盈', st0.floating > 0, `floating=${st0.floating.toFixed(2)} entry=${st0.entry.toFixed(2)} close=${st0.close.toFixed(2)}`);

// ---- 1. SL / TP 两个按钮
const btns = await page.evaluate(() => {
  const b = window.KR.book;
  return { sl: b._slBtn, tp: b._tpBtn };
});
check('SL 按钮存在', !!btns.sl, JSON.stringify(btns.sl));
check('TP 按钮存在', !!btns.tp, JSON.stringify(btns.tp));
check('TP 在 SL 右侧', btns.sl && btns.tp && btns.tp.x > btns.sl.x + btns.sl.w - 1,
  `sl.x=${btns.sl && btns.sl.x} tp.x=${btns.tp && btns.tp.x}`);
check('两个按钮都贴着成本线', btns.sl && btns.tp &&
  Math.abs((btns.sl.y + btns.sl.h / 2) - (btns.tp.y + btns.tp.h / 2)) < 1);

// ---- 2. 拖动 SL 到「开仓价之上、现价之下」——跟踪止损
const target = st0.entry + (st0.close - st0.entry) * 0.5;
const ty = await page.evaluate((price) => window.KR.candle.priceToCoordinate(price), target);
const slCenter = { x: btns.sl.x + btns.sl.w / 2, y: btns.sl.y + btns.sl.h / 2 };

await page.mouse.move(box.x + slCenter.x, box.y + slCenter.y);
await page.mouse.down();
await page.mouse.move(box.x + slCenter.x, box.y + ty, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(400);

// 拖动只打开设置面板, 填理由并应用后才真正保留
check('拖动 SL 后打开设置面板', await page.locator('#levelPop').isVisible());
await page.fill('#lpSlReason', '盈利后上移止损');
await page.click('#lpApply');
await page.waitForTimeout(400);

const st1 = await page.evaluate(() => {
  const p = window.KR.book.position;
  const close = window.KR.state.bars[window.KR.state.cursor].close;
  return { entry: p.entryPrice, close: close, sl: p.sl, slReason: p.slReason };
});
check('止损可拖到开仓价之上（跟踪止损）', st1.sl > st1.entry,
  `sl=${st1.sl.toFixed(2)} > entry=${st1.entry.toFixed(2)}`);
check('止损仍在现价之下', st1.sl < st1.close, `sl=${st1.sl.toFixed(2)} < close=${st1.close.toFixed(2)}`);
check('拖动止损时保存了理由', st1.slReason === '盈利后上移止损', String(st1.slReason));

// ---- 3. SL 拖到现价之上 → 夹到现价下方（setLevel 与拖拽共用同一夹紧逻辑）
await page.evaluate(() => {
  const book = window.KR.book;
  const p = book.position;
  book.setLevel(p.id, 'sl', book.currentClose() + 400, null, '夹紧测试');
});
await page.waitForTimeout(300);
const st2 = await page.evaluate(() => {
  const p = window.KR.book.position;
  return { close: window.KR.book.currentClose(), sl: p.sl, tick: Math.pow(10, -window.KR.state.digits) };
});
check('止损被夹在现价下方', Math.abs(st2.sl - (st2.close - st2.tick)) < 1e-6,
  `sl=${st2.sl.toFixed(2)} close-tick=${(st2.close - st2.tick).toFixed(2)}`);

// ---- 4. 拖动 TP 按钮
const ty2 = await page.evaluate(() => window.KR.candle.priceToCoordinate(window.KR.book.currentClose() + 40));
const tpCenter = { x: btns.tp.x + btns.tp.w / 2, y: btns.tp.y + btns.tp.h / 2 };
await page.mouse.move(box.x + tpCenter.x, box.y + tpCenter.y);
await page.mouse.down();
await page.mouse.move(box.x + tpCenter.x, box.y + ty2, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(400);
check('拖动 TP 后打开设置面板', await page.locator('#levelPop').isVisible());
await page.fill('#lpTpReason', '前高目标止盈');
await page.click('#lpApply');
await page.waitForTimeout(400);

const st3 = await page.evaluate(() => {
  const p = window.KR.book.position;
  return { close: window.KR.book.currentClose(), tp: p.tp, tpReason: p.tpReason };
});
check('拖动 TP 设置了止盈', st3.tp != null, `tp=${st3.tp && st3.tp.toFixed(2)}`);
check('止盈在现价之上', st3.tp > st3.close, `${st3.tp && st3.tp.toFixed(2)} > ${st3.close.toFixed(2)}`);
check('拖动止盈时保存了理由', st3.tpReason === '前高目标止盈', String(st3.tpReason));

// ---- 5. TP 拖到现价之下 → 夹到现价上方
await page.evaluate(() => {
  const book = window.KR.book;
  const p = book.position;
  book.setLevel(p.id, 'tp', book.currentClose() - 400, null, '夹紧测试');
});
await page.waitForTimeout(300);
const st4 = await page.evaluate(() => {
  const p = window.KR.book.position;
  return { close: window.KR.book.currentClose(), tp: p.tp, tick: Math.pow(10, -window.KR.state.digits) };
});
check('止盈被夹在现价上方', Math.abs(st4.tp - (st4.close + st4.tick)) < 1e-6,
  `tp=${st4.tp.toFixed(2)} close+tick=${(st4.close + st4.tick).toFixed(2)}`);

// ---- 6. 止盈线可拖动（命中判定）
const hitTp = await page.evaluate(() => {
  const book = window.KR.book;
  const y = window.KR.candle.priceToCoordinate(book.position.tp);
  return book.hitTest(400, y);
});
check('止盈线可命中', hitTp === 'tp-line', String(hitTp));

// ---- 7. 面板展示
const panel = await page.textContent('#posBlock');
check('面板显示止损与止盈', panel.includes('止损') && panel.includes('止盈'));

await page.screenshot({ path: 'shots/13b-verify.png' });

// ---- 8. 持久化
await page.waitForTimeout(400);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(900);
const after = await page.evaluate(() => {
  const p = window.KR.book.position;
  return p ? { sl: p.sl, tp: p.tp } : null;
});
check('刷新后 SL/TP 都在', after && after.sl != null && after.tp != null, JSON.stringify(after));

console.log('通过:');
ok.forEach((s) => console.log('  ✓ ' + s));
if (bad.length) { console.log('失败:'); bad.forEach((s) => console.log('  ✗ ' + s)); }
console.log('控制台错误:', errors.length ? errors.join(' | ') : '(无)');

await browser.close();
process.exitCode = bad.length || errors.length ? 1 : 0;
