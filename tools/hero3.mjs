import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
await page.goto('http://127.0.0.1:8766/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(1000);

await page.click('#btnTradePanel');
await page.waitForTimeout(400);

const box = await page.locator('#chartHost').boundingBox();
const P = (fx, fy) => [Math.round(box.x + box.width * fx), Math.round(box.y + box.height * fy)];

// 跳到有行情的位置
await page.evaluate(() => window.KR.api.setCursor(9000));
await page.waitForTimeout(500);

// 挂两张单：下方买入限价 + 上方卖出限价
await page.evaluate(() => {
  const b = window.KR.book;
  const c = b.currentClose();
  b.placeOrder('buy_limit', Number((c - 12).toFixed(2)), { lots: 0.1, contract: 100 });
  b.placeOrder('sell_limit', Number((c + 12).toFixed(2)), { lots: 0.1, contract: 100 });
});
await page.waitForTimeout(600);

// 右键菜单
await page.mouse.click(...P(0.45, 0.42), { button: 'right' });
await page.waitForTimeout(400);
await page.screenshot({ path: 'shots/09-orders.png' });
await page.keyboard.press('Escape');

// 再生成一张：持仓中的成本线
await page.evaluate(() => {
  window.KR.book.cancelAllOrders();
  window.KR.api.setCursor(window.KR.state.cursor - 60);
});
await page.waitForTimeout(400);
await page.evaluate(() => window.KR.api.open(1));
await page.waitForTimeout(300);
await page.evaluate(() => window.KR.api.setCursor(window.KR.state.cursor + 55));
await page.waitForTimeout(600);
await page.screenshot({ path: 'shots/10-position.png' });

// 再生成一张：持仓 + 拖出止损
await page.evaluate(() => {
  window.KR.book.cancelAllOrders();
  window.KR.api.setCursor(window.KR.state.cursor - 60);
});
await page.waitForTimeout(400);
await page.evaluate(() => window.KR.api.open(1));
await page.waitForTimeout(400);
await page.evaluate(() => window.KR.api.setCursor(window.KR.state.cursor + 45));
await page.waitForTimeout(600);

const b2 = await page.locator('#chartHost').boundingBox();
const btnPos = await page.evaluate(() => {
  const b = window.KR.book._slBtn;
  return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null;
});
if (btnPos) {
  await page.mouse.move(b2.x + btnPos.x, b2.y + btnPos.y);
  await page.mouse.down();
  await page.mouse.move(b2.x + btnPos.x, b2.y + btnPos.y + 95, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(500);
}
await page.screenshot({ path: 'shots/12-sl.png' });

console.log('done');
await browser.close();
