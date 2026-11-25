import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto('http://127.0.0.1:8766/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(1000);

// 切到 M15
await page.click('#periodBar button:nth-child(3)');
await page.waitForTimeout(1800);

const box = await page.locator('#chartHost').boundingBox();
const P = (fx, fy) => [Math.round(box.x + box.width * fx), Math.round(box.y + box.height * fy)];

const draw = async (tool, pts) => {
  await page.click(`button[data-tool="${tool}"]`);
  for (const p of pts) {
    await page.mouse.click(...P(p[0], p[1]));
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(200);
};

await draw('trend', [[0.10, 0.72], [0.86, 0.34]]);
await draw('hline', [[0.5, 0.24]]);
await draw('hline', [[0.5, 0.66]]);
await draw('rect', [[0.58, 0.40], [0.72, 0.58]]);
await draw('fib', [[0.30, 0.66], [0.52, 0.30]]);

// 文字: 点击后出现画布内输入框
await page.click('button[data-tool="text"]');
await page.mouse.click(...P(0.63, 0.79));
await page.waitForTimeout(250);
await page.fill('.draw-text-input', '4574 支撑 / 等回踩');
await page.keyboard.press('Enter');
await page.waitForTimeout(250);

await page.click('button[data-tool="cursor"]');
await page.mouse.move(10, 10);
await page.waitForTimeout(500);
await page.screenshot({ path: 'shots/00-hero.png' });

// 带 MACD 副图的一张
await page.click('#btnIndicators');
await page.check('input[name="sub"][value="macd"]');
await page.mouse.move(10, 10);
await page.waitForTimeout(900);
await page.screenshot({ path: 'shots/00-hero-macd.png' });

console.log('done');
await browser.close();
