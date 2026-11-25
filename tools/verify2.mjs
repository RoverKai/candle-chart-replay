import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto('http://127.0.0.1:8766/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(900);

const ok = [];
const bad = [];
const check = (name, cond, extra = '') => (cond ? ok : bad).push(`${name}${extra ? ' :: ' + extra : ''}`);

const box = await page.locator('#chartHost').boundingBox();
const P = (fx, fy) => [Math.round(box.x + box.width * fx), Math.round(box.y + box.height * fy)];

const range = () => page.evaluate(() => {
  const r = window.KR.chart.timeScale().getVisibleLogicalRange();
  return r ? [Math.round(r.from), Math.round(r.to)] : null;
});

// ---- 1. 画一条趋势线
await page.click('button[data-tool="trend"]');
await page.mouse.click(...P(0.30, 0.70));
await page.mouse.click(...P(0.62, 0.45));
await page.waitForTimeout(250);

let n = await page.evaluate(() => window.KR.drawLayer.drawings.length);
check('创建趋势线', n === 1, 'drawings=' + n);

// ---- 2. 光标模式平移
await page.click('button[data-tool="cursor"]');
const rBefore = await range();
await page.mouse.move(...P(0.2, 0.12));
await page.mouse.down();
await page.mouse.move(...P(0.45, 0.12), { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
const rAfter = await range();
check('光标模式可平移', JSON.stringify(rBefore) !== JSON.stringify(rAfter), `${JSON.stringify(rBefore)} -> ${JSON.stringify(rAfter)}`);

// ---- 3. 选中画线
const mid = await page.evaluate(() => {
  const dl = window.KR.drawLayer, d = dl.drawings[0];
  const a = dl.xyOf(d.pts[0]), b = dl.xyOf(d.pts[1]);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, pts: d.pts };
});
await page.mouse.click(Math.round(box.x + mid.x), Math.round(box.y + mid.y));
await page.waitForTimeout(200);
const sel = await page.evaluate(() => window.KR.drawLayer.selected);
check('点击可选中画线', !!sel, 'selected=' + sel);

// ---- 4. 拖动整条线
await page.mouse.move(Math.round(box.x + mid.x), Math.round(box.y + mid.y));
await page.mouse.down();
await page.mouse.move(Math.round(box.x + mid.x + 70), Math.round(box.y + mid.y + 45), { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(300);
const moved = await page.evaluate(() => window.KR.drawLayer.drawings[0].pts);
check('拖动改变锚点', JSON.stringify(moved) !== JSON.stringify(mid.pts),
  `p0.price ${mid.pts[0].price.toFixed(2)} -> ${moved[0].price.toFixed(2)}`);

// ---- 5. 画线工具下不触发图表平移
await page.click('button[data-tool="trend"]');
const r2 = await range();
await page.mouse.move(...P(0.15, 0.2));
await page.mouse.down();
await page.mouse.move(...P(0.4, 0.2), { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(250);
const r3 = await range();
check('画线工具下不平移', JSON.stringify(r2) === JSON.stringify(r3), `${JSON.stringify(r2)} vs ${JSON.stringify(r3)}`);
await page.keyboard.press('Escape');

// ---- 6. 删除
await page.click('button[data-tool="cursor"]');
await page.mouse.click(Math.round(box.x + mid.x + 70), Math.round(box.y + mid.y + 45));
await page.waitForTimeout(150);
await page.keyboard.press('Delete');
await page.waitForTimeout(350);
n = await page.evaluate(() => window.KR.drawLayer.drawings.length);
check('Delete 删除画线', n === 0, 'drawings=' + n);

const ls = await page.evaluate(() => {
  const k = Object.keys(localStorage).filter((x) => x.startsWith('kline-replay:draw:'));
  return k.length ? JSON.parse(localStorage.getItem(k[0])).length : -1;
});
check('持久化同步', ls === 0, 'localStorage items=' + ls);

// ---- 7. 回放隐藏未来 & 未来画线
await page.click('button[data-tool="hline"]');
await page.mouse.click(...P(0.5, 0.55));
await page.waitForTimeout(200);
const total = await page.evaluate(() => window.KR.state.bars.length);
await page.evaluate(() => window.KR.api.setCursor(window.KR.state.cursor - 40));
await page.waitForTimeout(400);
const cur = await page.evaluate(() => window.KR.state.cursor);
check('回退后进入回放', cur === total - 41, `cursor=${cur} total=${total}`);

// ---- 8. 指标切换后画线仍在
await page.click('#btnIndicators');
await page.check('input[name="sub"][value="rsi"]');
await page.waitForTimeout(700);
n = await page.evaluate(() => window.KR.drawLayer.drawings.length);
check('切副图不丢画线', n === 1, 'drawings=' + n);
await page.keyboard.press('Escape');
await page.screenshot({ path: 'shots/06-interaction.png' });

console.log('通过:');
ok.forEach((s) => console.log('  ✓ ' + s));
if (bad.length) {
  console.log('失败:');
  bad.forEach((s) => console.log('  ✗ ' + s));
}
console.log('控制台错误:', errors.length ? errors.join(' | ') : '(无)');

await browser.close();
process.exitCode = bad.length || errors.length ? 1 : 0;
