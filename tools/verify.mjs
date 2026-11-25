import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8766/';
const OUT = path.resolve('shots');
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(...a);
const errors = [];

const browser = await chromium.launch({ channel: process.env.CHANNEL || 'msedge' });
const page = await browser.newPage({ viewport: { width: 1680, height: 950 }, deviceScaleFactor: 1 });

page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });

// 等 K 线渲染出来
await page.waitForFunction(() => {
  const el = document.querySelector('#legend');
  return el && el.textContent.includes('XAUUSD');
}, { timeout: 20000 });

await page.waitForTimeout(1200);

const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, name) });
  log('  shot ->', name);
};

const pos = () => page.textContent('#barPos');
log('初始状态:', await pos(), '|', await page.textContent('#barTime'));
await shot('01-load.png');

// --- 回放: 后退 5 根
for (let i = 0; i < 5; i++) await page.click('#btnPrev');
await page.waitForTimeout(400);
log('后退5根:', await pos(), '|', await page.textContent('#barTime'), '| 回放角标可见:', await page.isVisible('#replayBadge'));

// --- 画图: 趋势线
const box = await page.locator('#chartHost').boundingBox();
const cx = (fx) => Math.round(box.x + box.width * fx);
const cy = (fy) => Math.round(box.y + box.height * fy);

await page.click('button[data-tool="trend"]');
await page.mouse.click(cx(0.35), cy(0.62));
await page.mouse.move(cx(0.55), cy(0.45));
await page.waitForTimeout(150);
await page.mouse.click(cx(0.55), cy(0.45));
await page.waitForTimeout(200);

// --- 水平线
await page.click('button[data-tool="hline"]');
await page.mouse.click(cx(0.62), cy(0.3));
await page.waitForTimeout(150);

// --- 矩形
await page.click('button[data-tool="rect"]');
await page.mouse.click(cx(0.30), cy(0.55));
await page.mouse.click(cx(0.50), cy(0.75));
await page.waitForTimeout(200);

// --- 斐波那契
await page.click('button[data-tool="fib"]');
await page.mouse.click(cx(0.60), cy(0.72));
await page.mouse.click(cx(0.78), cy(0.40));
await page.waitForTimeout(300);

await shot('02-drawings.png');

const drawCount = await page.evaluate(() => {
  const keys = Object.keys(localStorage).filter((k) => k.startsWith('kline-replay:draw:'));
  if (!keys.length) return { keys: 0, items: 0 };
  return { keys: keys.length, items: JSON.parse(localStorage.getItem(keys[0])).length };
});
log('画线已持久化:', JSON.stringify(drawCount));

// --- 副图 MACD
await page.click('#btnIndicators');
await page.waitForTimeout(150);
await page.check('input[name="sub"][value="macd"]');
await page.waitForTimeout(800);
await shot('03-macd.png');

// --- 播放
await page.click('#btnRewind');
await page.waitForTimeout(300);
const before = await pos();
await page.click('#btnPlay');
await page.waitForTimeout(1600);
await page.click('#btnPlay');
const after = await pos();
log('播放测试:', before, '->', after, before !== after ? 'OK' : '无变化(异常)');
await shot('04-replay.png');

// --- 切周期 H1
await page.click('#periodBar button:nth-child(5)');
await page.waitForTimeout(1500);
log('切到 H1:', await pos(), '|', await page.textContent('#legend'));
await shot('05-h1.png');

// --- 选择并删除画线
await page.click('button[data-tool="cursor"]');
await page.mouse.click(cx(0.35), cy(0.62));
await page.waitForTimeout(200);

const summary = {
  errors,
  finalPos: await pos(),
  legend: (await page.textContent('#legend')).slice(0, 120)
};
log('\n=== 控制台错误 ===');
log(errors.length ? errors.join('\n') : '(无)');
log(JSON.stringify(summary, null, 2));

await browser.close();
if (errors.length) process.exitCode = 1;
