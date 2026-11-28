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

// 打开交易面板
await page.click('#btnTradePanel');
await page.waitForTimeout(400);

// 回到 200 根之前，进入回放
await page.evaluate(() => window.KR.api.setCursor(window.KR.state.cursor - 200));
await page.waitForTimeout(400);

const entryPrice = await page.evaluate(() => window.KR.state.bars[window.KR.state.cursor].close);
const entryTime = await page.evaluate(() => window.KR.state.bars[window.KR.state.cursor].time);

// ---- 1. 手动开多
await page.fill('#lotsInput', '0.1');
await page.fill('#contractInput', '100');
await page.fill('#entryReason', 'M5 回踩趋势线不破');
await page.click('#btnBuy');
await page.waitForTimeout(300);

let st = await page.evaluate(() => {
  const p = window.KR.book.position;
  return p ? { dir: p.dir, entry: p.entryPrice, lots: p.lots, contract: p.contract } : null;
});
check('开多仓成功', st && st.dir === 1, JSON.stringify(st));
check('开仓价=当前收盘价', st && Math.abs(st.entry - entryPrice) < 1e-6, `${st && st.entry} vs ${entryPrice}`);
check('面板显示持仓', (await page.textContent('#posBlock')).includes('多'));

// ---- 2. 推进 40 根，浮动盈亏应变化
await page.evaluate(() => window.KR.api.setCursor(window.KR.state.cursor + 40));
await page.waitForTimeout(400);
const fl = await page.evaluate(() => window.KR.book.floating());
const px40 = await page.evaluate(() => window.KR.state.bars[window.KR.state.cursor].close);
const expect40 = (px40 - entryPrice) * 0.1 * 100;
check('浮动盈亏计算正确', Math.abs(fl - expect40) < 1e-6, `floating=${fl.toFixed(2)} expect=${expect40.toFixed(2)}`);
const posText = await page.textContent('#posBlock');
check('面板浮动盈亏同步', posText.includes(fl.toFixed(2)), `面板=${posText.replace(/\s+/g, ' ').trim()} 期望包含 ${fl.toFixed(2)}`);

// ---- 3. 手动平仓（先写平仓理由）
await page.click('#btnClosePos');
await page.waitForTimeout(150);
await page.fill('#reasonText', '趋势按预期走完，主动止盈');
await page.click('#reasonConfirm');
await page.waitForTimeout(300);
st = await page.evaluate(() => ({
  pos: window.KR.book.position,
  trades: window.KR.book.trades.length,
  pnl: window.KR.book.trades[0] && window.KR.book.trades[0].pnl,
  reason: window.KR.book.trades[0] && window.KR.book.trades[0].reason
}));
check('平仓后无持仓', st.pos === null);
check('平仓记录 1 笔', st.trades === 1, JSON.stringify(st));
check('平仓盈亏正确', Math.abs(st.pnl - expect40) < 1e-6, `pnl=${st.pnl && st.pnl.toFixed(2)}`);

// ---- 4. 止损自动结算 (跳到数据中段，保证后面有足够 K 线)
await page.evaluate(() => window.KR.api.setCursor(5000));
await page.waitForTimeout(300);
const e2 = await page.evaluate(() => window.KR.state.bars[window.KR.state.cursor].close);
const slPrice = Number((e2 - 0.5).toFixed(2));
await page.fill('#entryReason', '回踩支撑做多');
await page.fill('#slInput', String(slPrice));
await page.fill('#slReasonInput', '突破前高则止损');
await page.click('#btnBuy');
await page.waitForTimeout(250);
const opened = await page.evaluate(() => !!window.KR.book.position);
check('第二个仓位已开', opened);

await page.evaluate(() => {
  for (let i = 0; i < 3000 && window.KR.book.position; i++) {
    window.KR.api.setCursor(window.KR.state.cursor + 1);
  }
});
await page.waitForTimeout(400);
st = await page.evaluate(() => {
  const t = window.KR.book.trades.filter((x) => x.reason === '止损')[0];
  return {
    pos: window.KR.book.position,
    count: window.KR.book.trades.length,
    reason: t && t.reason,
    exit: t && t.exitPrice
  };
});
check('止损自动平仓', st.pos === null && st.reason === '止损', JSON.stringify(st));
check('止损价成交', st.exit != null && Math.abs(st.exit - slPrice) < 1e-6, `${st.exit} vs ${slPrice}`);

// ---- 5. 统计
const stats = await page.evaluate(() => window.KR.book.stats());
check('统计笔数=2', stats.count === 2, JSON.stringify({ count: stats.count, winRate: stats.winRate }));
check('统计面板可见', (await page.textContent('#statsBlock')).includes('总盈亏'));

// ---- 6. 持久化
const ls = await page.evaluate(() => {
  const k = Object.keys(localStorage).filter((x) => x.startsWith('kline-replay:trades:'));
  return k.length ? JSON.parse(localStorage.getItem(k[0])).trades.length : -1;
});
check('交易已持久化', ls === 2, 'items=' + ls);

// 重新加载，校验恢复
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(900);
const restored = await page.evaluate(() => window.KR.book.trades.length);
check('刷新后记录恢复', restored === 2, 'trades=' + restored);

// ---- 7. 截图（再开一仓，带浮动盈亏）
await page.click('#btnTradePanel');
await page.waitForTimeout(300);
await page.evaluate(() => window.KR.api.setCursor(window.KR.state.cursor - 120));
await page.waitForTimeout(300);
await page.fill('#entryReason', '反弹到阻力位试空');
await page.click('#btnSell');
await page.waitForTimeout(300);
await page.evaluate(() => window.KR.api.setCursor(window.KR.state.cursor + 45));
await page.waitForTimeout(600);
await page.screenshot({ path: 'shots/07-trading.png' });

// ---- 8. 历史仓位开关: 只影响绘制, 不影响记录
// 截图前光标停在两笔平仓之前, 先推到最新, 否则历史仓位属于"未来"本来就不绘制
await page.evaluate(() => window.KR.api.setCursor(window.KR.state.bars.length - 1));
await page.waitForTimeout(300);
await page.evaluate(() => {
  window.__paintHistory = 0;
  const proto = Object.getPrototypeOf(window.KR.book);
  if (!proto.__origPaintTrade) {
    proto.__origPaintTrade = proto._paintTrade;
    proto._paintTrade = function () {
      window.__paintHistory++;
      return proto.__origPaintTrade.apply(this, arguments);
    };
  }
  window.KR.drawLayer.redraw();
});
await page.waitForTimeout(300);
const historyPainted = await page.evaluate(() => window.__paintHistory);
check('默认绘制历史仓位', historyPainted > 0, 'paint=' + historyPainted);

await page.click('#btnToggleHistory');
await page.waitForTimeout(250);
await page.evaluate(() => { window.__paintHistory = 0; window.KR.drawLayer.redraw(); });
await page.waitForTimeout(300);
check('关闭历史仓位后不再绘制', await page.evaluate(() => window.__paintHistory) === 0);
check('开关状态已持久化',
  await page.evaluate(() => localStorage.getItem('kline-replay:history-visible')) === '0');

await page.click('#btnToggleHistory');
await page.waitForTimeout(250);
await page.evaluate(() => { window.__paintHistory = 0; window.KR.drawLayer.redraw(); });
await page.waitForTimeout(300);
check('重新开启后恢复绘制', await page.evaluate(() => window.__paintHistory) > 0);

// ---- 9. 清空记录: 图表同步消失, 且立即落盘
page.once('dialog', (d) => d.accept());
await page.click('#btnClearTrades');
await page.waitForTimeout(50);
const cleared = await page.evaluate(() => {
  const k = Object.keys(localStorage).find((x) => x.startsWith('kline-replay:trades:'));
  return {
    trades: window.KR.book.trades.length,
    stored: k ? JSON.parse(localStorage.getItem(k)).trades.length : -1
  };
});
check('清空后记录为 0', cleared.trades === 0, JSON.stringify(cleared));
check('清空立即落盘', cleared.stored === 0, JSON.stringify(cleared));
await page.evaluate(() => { window.__paintHistory = 0; window.KR.drawLayer.redraw(); });
await page.waitForTimeout(300);
check('清空后图上不再绘制历史仓位', await page.evaluate(() => window.__paintHistory) === 0);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(900);
check('清空后刷新仍为空', await page.evaluate(() => window.KR.book.trades.length) === 0);

console.log('通过:');
ok.forEach((s) => console.log('  ✓ ' + s));
if (bad.length) { console.log('失败:'); bad.forEach((s) => console.log('  ✗ ' + s)); }
console.log('控制台错误:', errors.length ? errors.join(' | ') : '(无)');

await browser.close();
process.exitCode = bad.length || errors.length ? 1 : 0;
