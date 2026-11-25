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

const box = await page.locator('#chartHost').boundingBox();
const P = (fx, fy) => [Math.round(box.x + box.width * fx), Math.round(box.y + box.height * fy)];

// ================= 1. Ctrl + 拖动 = 复制 =================
await page.click('button[data-tool="trend"]');
await page.mouse.click(...P(0.30, 0.70));
await page.mouse.click(...P(0.60, 0.45));
await page.waitForTimeout(300);

const before = await page.evaluate(() => {
  const d = window.KR.drawLayer.drawings[0];
  return { count: window.KR.drawLayer.drawings.length, id: d.id, pts: d.pts };
});
check('画出一条趋势线', before.count === 1, 'count=' + before.count);

const mid = await page.evaluate(() => {
  const dl = window.KR.drawLayer, d = dl.drawings[0];
  const a = dl.xyOf(d.pts[0]), b = dl.xyOf(d.pts[1]);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
});

// Ctrl + 拖动
await page.keyboard.down('Control');
await page.mouse.move(box.x + mid.x, box.y + mid.y);
await page.mouse.down();
await page.mouse.move(box.x + mid.x + 90, box.y + mid.y + 50, { steps: 12 });
await page.mouse.up();
await page.keyboard.up('Control');
await page.waitForTimeout(400);

const after = await page.evaluate(() => ({
  count: window.KR.drawLayer.drawings.length,
  items: window.KR.drawLayer.drawings.map((d) => ({ id: d.id, pts: d.pts })),
  selected: window.KR.drawLayer.selected
}));
check('Ctrl+拖动复制出新对象', after.count === 2, 'count=' + after.count);

const orig = after.items.find((d) => d.id === before.id);
check('原对象留在原位', orig && Math.abs(orig.pts[0].price - before.pts[0].price) < 1e-9,
  orig ? `p0 ${before.pts[0].price.toFixed(2)} -> ${orig.pts[0].price.toFixed(2)}` : 'missing');

const copy = after.items.find((d) => d.id !== before.id);
check('副本被拖走', copy && Math.abs(copy.pts[0].price - before.pts[0].price) > 1e-6,
  copy ? `副本 p0 = ${copy.pts[0].price.toFixed(2)}` : 'missing');
check('选中项是副本', after.selected === (copy && copy.id));

// Ctrl + 单击（不移动）不应该复制
const mid2 = await page.evaluate(() => {
  const dl = window.KR.drawLayer, d = dl.drawings[0];
  const a = dl.xyOf(d.pts[0]), b = dl.xyOf(d.pts[1]);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
});
await page.keyboard.down('Control');
await page.mouse.click(box.x + mid2.x, box.y + mid2.y);
await page.keyboard.up('Control');
await page.waitForTimeout(300);
const afterClick = await page.evaluate(() => window.KR.drawLayer.drawings.length);
check('Ctrl+单击不复制', afterClick === 2, 'count=' + afterClick);

// 普通拖动仍只是移动、不复制
await page.click('button[data-tool="cursor"]');
const mid3 = await page.evaluate(() => {
  const dl = window.KR.drawLayer, d = dl.drawings[0];
  const a = dl.xyOf(d.pts[0]), b = dl.xyOf(d.pts[1]);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
});
await page.mouse.move(box.x + mid3.x, box.y + mid3.y);
await page.mouse.down();
await page.mouse.move(box.x + mid3.x + 40, box.y + mid3.y + 20, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
const afterPlain = await page.evaluate(() => window.KR.drawLayer.drawings.length);
check('普通拖动不复制', afterPlain === 2, 'count=' + afterPlain);

// ================= 2. 记住播放位置 =================
const setTo = 5000;
await page.evaluate((i) => window.KR.api.setCursor(i), setTo);
await page.waitForTimeout(700);   // 等 400ms 防抖落盘

const saved = await page.evaluate(() => {
  const k = Object.keys(localStorage).filter((x) => x.startsWith('kline-replay:pos:'));
  return k.length ? JSON.parse(localStorage.getItem(k[0])) : null;
});
check('播放位置已写入', saved && saved.cursor > 0, JSON.stringify(saved));

await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(1200);

const restored = await page.evaluate(() => ({
  cursor: window.KR.state.cursor,
  total: window.KR.state.bars.length,
  time: window.KR.state.bars[window.KR.state.cursor].time
}));
check('刷新后回到原位置', restored.cursor === setTo, `cursor=${restored.cursor} 期望 ${setTo}`);
check('仍处于回放态', restored.cursor < restored.total - 1);
check('回放角标可见', await page.isVisible('#replayBadge'));

// 位置按周期独立：切到 M15 应该是最新一根
await page.click('#periodBar button:nth-child(3)');
await page.waitForTimeout(1800);
const other = await page.evaluate(() => ({ cursor: window.KR.state.cursor, total: window.KR.state.bars.length }));
check('其它周期不受影响', other.cursor === other.total - 1, `${other.cursor}/${other.total}`);

// 切回 M5 应恢复
await page.click('#periodBar button:nth-child(2)');
await page.waitForTimeout(1800);
const back = await page.evaluate(() => window.KR.state.cursor);
check('切回原周期恢复位置', back === setTo, 'cursor=' + back);

await page.screenshot({ path: 'shots/14-restore.png' });

console.log('通过:');
ok.forEach((s) => console.log('  ✓ ' + s));
if (bad.length) { console.log('失败:'); bad.forEach((s) => console.log('  ✗ ' + s)); }
console.log('控制台错误:', errors.length ? errors.join(' | ') : '(无)');

await browser.close();
process.exitCode = bad.length || errors.length ? 1 : 0;
