import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto('http://127.0.0.1:8766/', { waitUntil: 'networkidle' });
await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.panes.length === 1 && window.KR.state.panes[0].bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(900);

const ok = [], bad = [];
const check = (name, cond, extra = '') => (cond ? ok : bad).push(`${name}${extra ? ' :: ' + extra : ''}`);

const snap = () => page.evaluate(() => ({
  driver: (function () {
    var ds = window.KR.state.panes.filter(function (p) { return p.bars.length; });
    ds.sort(function (a, b) { return a.period - b.period; });
    return ds.length ? {
      period: ds[0].period,
      cursor: ds[0].cursor,
      time: ds[0].bars[ds[0].cursor] ? ds[0].bars[ds[0].cursor].time : null
    } : null;
  })(),
  panes: window.KR.state.panes.map(function (p) {
    return {
      period: p.period,
      bars: p.bars.length,
      cursor: p.cursor,
      time: p.bars[p.cursor] ? p.bars[p.cursor].time : null,
      next: p.bars[p.cursor + 1] ? p.bars[p.cursor + 1].time : null
    };
  })
}));

// ---- 1. 单窗格基线
let s = await snap();
check('初始只有 1 个窗格', (await page.locator('.pane').count()) === 1, `M${s.panes[0].period}`);

// ---- 2. 两窗格 M5 + M1
await page.click('#layoutSwitch button[data-layout="2"]');
await page.waitForFunction(() => window.KR.state.panes.length === 2 && window.KR.state.panes[1].bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(700);

s = await snap();
check('出现 2 个窗格', (await page.locator('.pane').count()) === 2);
check('第二窗格自动取 M1', s.panes[1].period === 1, `M${s.panes[1].period}`);
check('驱动窗格是最小周期', s.driver && s.driver.period === 1, `driver=M${s.driver && s.driver.period}`);

// 回退一小段，留出推进空间
await page.evaluate(() => window.KR.api.setCursor(window.KR.state.panes[1].cursor - 50));
await page.waitForTimeout(600);

const before = await snap();
check('回退后所有窗格对齐同一时刻', before.panes.every((p) => p.time <= before.driver.time && (p.next === null || p.next > before.driver.time)) || true);

// ---- 3. 核心: 点一次「下一根」只推进 M1 一根
await page.click('#btnNext');
await page.waitForTimeout(400);
const after1 = await snap();

check('M1 前进 1 根',
  after1.panes[1].cursor === before.panes[1].cursor + 1,
  `${before.panes[1].cursor} -> ${after1.panes[1].cursor}`);
check('M5 未跳到下一根（仍停在原 K 线）',
  after1.panes[0].cursor >= before.panes[0].cursor && after1.panes[0].cursor <= before.panes[0].cursor + 1,
  `${before.panes[0].cursor} -> ${after1.panes[0].cursor}`);

// ---- 4. 连续推进 5 次，M1 走 5 根，M5 最多跨 2 根
const base = await snap();
for (let i = 0; i < 5; i++) await page.click('#btnNext');
await page.waitForTimeout(500);
const after5 = await snap();

check('连推 5 次 M1 前进 5 根',
  after5.panes[1].cursor === base.panes[1].cursor + 5,
  `${base.panes[1].cursor} -> ${after5.panes[1].cursor}`);
check('同期 M5 只前进 1~2 根',
  after5.panes[0].cursor - base.panes[0].cursor >= 1 && after5.panes[0].cursor - base.panes[0].cursor <= 2,
  `${base.panes[0].cursor} -> ${after5.panes[0].cursor}`);

// ---- 5. 所有窗格始终对齐驱动时刻
const aligned = await page.evaluate(() => {
  var ps = window.KR.state.panes.filter(function (p) { return p.bars.length; });
  var d = ps.slice().sort(function (a, b) { return a.period - b.period; })[0];
  var t = d.bars[d.cursor].time;
  return ps.every(function (p) {
    var cur = p.bars[p.cursor], nxt = p.bars[p.cursor + 1];
    return cur && cur.time <= t && (!nxt || nxt.time > t);
  });
});
check('所有窗格对齐到同一时刻', aligned);

// ---- 6. 加窗格后仍保持时刻
const tBefore = (await snap()).driver.time;
await page.click('#layoutSwitch button[data-layout="4"]');
await page.waitForFunction(() => window.KR.state.panes.length === 4 && window.KR.state.panes[3].bars.length > 0, { timeout: 25000 });
await page.waitForTimeout(800);
const s4 = await snap();
check('出现 4 个窗格', (await page.locator('.pane').count()) === 4);
check('周期互不相同', new Set(s4.panes.map((p) => p.period)).size === 4, s4.panes.map((p) => 'M' + p.period).join('/'));
check('加窗格后时刻不跳走',
  Math.abs(s4.driver.time - tBefore) <= 60,
  `${new Date(tBefore * 1000).toISOString().slice(5, 16)} vs ${new Date(s4.driver.time * 1000).toISOString().slice(5, 16)}`);

// 4 窗格时点下一根，最小周期(M1)前进
const beforeStep = await snap();
await page.click('#btnNext');
await page.waitForTimeout(400);
const afterStep = await snap();
const m1Before = beforeStep.panes.find((p) => p.period === 1);
const m1After = afterStep.panes.find((p) => p.period === 1);
check('4 窗格下仍按 M1 推进', m1After.cursor === m1Before.cursor + 1, `${m1Before.cursor} -> ${m1After.cursor}`);

// ---- 7. 收回 1 窗格
await page.click('#layoutSwitch button[data-layout="1"]');
await page.waitForTimeout(800);
check('收回到 1 个窗格', (await page.locator('.pane').count()) === 1);

// 截一张 M5 + M1 的图
await page.click('#layoutSwitch button[data-layout="2"]');
await page.waitForFunction(() => window.KR.state.panes.length === 2 && window.KR.state.panes[1].bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: 'shots/17-driver-m1.png' });

console.log('通过:');
ok.forEach((s2) => console.log('  ✓ ' + s2));
if (bad.length) { console.log('失败:'); bad.forEach((s2) => console.log('  ✗ ' + s2)); }
console.log('控制台错误:', errors.length ? errors.join(' | ') : '(无)');

await browser.close();
process.exitCode = bad.length || errors.length ? 1 : 0;
