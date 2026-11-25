import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
await page.goto('http://127.0.0.1:8766/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(1000);

await page.click('#btnTradePanel');
await page.waitForTimeout(400);
const box = await page.locator('#chartHost').boundingBox();

// 找一段上涨行情，持多单浮盈
const spot = await page.evaluate(() => {
  const bars = window.KR.state.bars;
  for (let i = 8000; i < 16000; i += 25) {
    if (bars[i + 80] && bars[i + 80].close > bars[i].close + 12) return { i };
  }
  return null;
});

await page.evaluate((i) => window.KR.api.setCursor(i), spot.i);
await page.waitForTimeout(300);
await page.click('#btnBuy');
await page.waitForTimeout(300);
await page.evaluate((i) => window.KR.api.setCursor(i + 80), spot.i);
await page.waitForTimeout(500);

const st = await page.evaluate(() => ({
  entry: window.KR.book.position.entryPrice,
  close: window.KR.book.currentClose(),
  sl: window.KR.book._slBtn,
  tp: window.KR.book._tpBtn
}));

// 拖 SL 到成本线之上（跟踪止损）
const slPrice = st.entry + (st.close - st.entry) * 0.55;
const slY = await page.evaluate((p) => window.KR.candle.priceToCoordinate(p), slPrice);
await page.mouse.move(box.x + st.sl.x + st.sl.w / 2, box.y + st.sl.y + st.sl.h / 2);
await page.mouse.down();
await page.mouse.move(box.x + st.sl.x + st.sl.w / 2, box.y + slY, { steps: 14 });
await page.mouse.up();
await page.waitForTimeout(400);

// 刷新按钮坐标（面板/布局可能变了）
const st2 = await page.evaluate(() => ({ sl: window.KR.book._slBtn, tp: window.KR.book._tpBtn }));

// 拖 TP 到现价上方一段（保持在可视范围内）
const tpPrice = st.close + (st.close - st.entry) * 0.45;
const tpY = await page.evaluate((p) => window.KR.candle.priceToCoordinate(p), tpPrice);
await page.mouse.move(box.x + st2.tp.x + st2.tp.w / 2, box.y + st2.tp.y + st2.tp.h / 2);
await page.mouse.down();
await page.mouse.move(box.x + st2.tp.x + st2.tp.w / 2, box.y + tpY, { steps: 14 });
await page.mouse.up();
await page.waitForTimeout(600);

await page.mouse.move(10, 10);
await page.waitForTimeout(400);
await page.screenshot({ path: 'shots/13-sl-tp.png' });
console.log('done');
await browser.close();
