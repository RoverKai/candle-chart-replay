import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
await page.goto('http://127.0.0.1:8766/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.panes[0].bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(900);

const box = await page.locator('#chartHost').boundingBox();
const P = (fx, fy) => [Math.round(box.x + box.width * fx), Math.round(box.y + box.height * fy)];

// 趋势线: 左低右高，终点贴右边
await page.click('button[data-tool="trend"]');
await page.mouse.click(...P(0.12, 0.72));
await page.mouse.click(...P(0.90, 0.34));
await page.waitForTimeout(200);

// 水平支撑位
await page.click('button[data-tool="hline"]');
await page.mouse.click(...P(0.5, 0.80));
await page.waitForTimeout(200);

// 矩形
await page.click('button[data-tool="rect"]');
await page.mouse.click(...P(0.55, 0.40));
await page.mouse.click(...P(0.80, 0.58));
await page.waitForTimeout(200);

await page.click('button[data-tool="cursor"]');

// 回退 60 根: 右边部分进入"未来"
await page.evaluate(() => window.KR.api.setCursor(window.KR.state.cursor - 60));
await page.waitForTimeout(700);
await page.mouse.move(10, 10);
await page.waitForTimeout(300);
await page.screenshot({ path: 'shots/16-future-drawings.png' });

console.log('done');
await browser.close();
