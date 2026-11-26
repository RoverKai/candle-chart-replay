import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: process.env.CHANNEL || 'msedge' });
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

// 每个窗格只能显示「结束时间 <= 驱动窗格当前 K 线结束时间」的 K 线
const alignment = () => page.evaluate(() => {
  var ps = window.KR.state.panes.filter(function (p) { return p.bars.length; });
  var d = ps.slice().sort(function (a, b) { return a.period - b.period; })[0];
  if (!d || d.cursor < 0 || !d.bars[d.cursor]) return { ok: false, bad: ['没有驱动窗格'] };
  var end = d.bars[d.cursor].time + d.period * 60;
  var bad = [];
  ps.forEach(function (p) {
    if (p.cursor < 0) {
      var first = p.bars[0];
      if (first && first.time + p.period * 60 <= end) bad.push('M' + p.period + ' 漏画已完成 K 线');
      return;
    }
    var cur = p.bars[p.cursor], nxt = p.bars[p.cursor + 1];
    if (!cur || cur.time + p.period * 60 > end) bad.push('M' + p.period + ' 提前显示未完成 K 线');
    if (nxt && nxt.time + p.period * 60 <= end) bad.push('M' + p.period + ' 漏画已完成 K 线');
  });
  return { ok: !bad.length, bad: bad };
});

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
const beforeAlign = await alignment();
check('回退后所有窗格只显示已收完的 K 线', beforeAlign.ok, beforeAlign.bad.join(' | '));

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

// ---- 5. 所有窗格只显示已收完的 K 线
const aligned = await alignment();
check('所有窗格只显示已收完的 K 线', aligned.ok, aligned.bad.join(' | '));

// ---- 5b. M1 走完 5 根之前, M5 不能提前出现新 K 线
const boundary = await page.evaluate(() => {
  var p = window.KR.state.panes.filter(function (x) { return x.period === 1; })[0];
  for (var i = p.bars.length - 20; i > 10; i--) {
    if (p.bars[i].time % 300 === 0) return { index: i, time: p.bars[i].time };
  }
  return null;
});
check('找到 M1/M5 周期边界', !!boundary);
if (boundary) {
  await page.evaluate((idx) => window.KR.api.setCursor(idx, { force: true }), boundary.index);
  await page.waitForTimeout(400);

  const m5Of = (x) => x.panes.filter((p) => p.period === 5)[0];
  const m5Start = m5Of(await snap());
  check('边界处 M5 停在上一根已收完的 K 线', m5Start.time === boundary.time - 300,
    `M5=${m5Start.time} / 边界=${boundary.time}`);

  let early = false;
  for (let i = 1; i <= 3; i++) {
    await page.click('#btnNext');
    await page.waitForTimeout(180);
    const cur = m5Of(await snap());
    if (cur.cursor !== m5Start.cursor) early = true;
  }
  check('M1 走 1~3 根时 M5 不提前出现', !early,
    `M5 cursor ${m5Start.cursor} -> ${m5Of(await snap()).cursor}`);

  await page.click('#btnNext');   // M1 第 5 根, 12:04
  await page.waitForTimeout(250);
  const at4 = await snap();
  const m5At4 = m5Of(at4);
  check('M1 走完第 5 根后 M5 才出现',
    at4.driver.time === boundary.time + 240 && m5At4.time === boundary.time,
    `M1=${at4.driver.time} / M5=${m5At4.time}`);

  await page.click('#btnNext');   // 12:05, 下一根 M5 还没收完
  await page.waitForTimeout(250);
  const m5At5 = m5Of(await snap());
  check('M1 再走一根, M5 仍停在已收完的 K 线', m5At5.cursor === m5At4.cursor,
    `M5 cursor ${m5At4.cursor} -> ${m5At5.cursor}`);
}

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

// ---- 8. 双窗格方向切换 + 可拖动分隔线
const paneBoxes = () => page.evaluate(() => {
  return window.KR.state.panes.map(function (p) {
    var r = p.els.section.getBoundingClientRect();
    return {
      x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom,
      chartW: p.chart.timeScale().width()
    };
  });
});

check('双窗格显示方向切换', await page.isVisible('#splitSwitch'));
check('双窗格显示分隔线', await page.isVisible('#paneResizer'));
check('默认上下分屏', (await page.getAttribute('#chartGrid', 'data-split')) === 'col');

await page.click('#splitSwitch button[data-split="row"]');
await page.waitForTimeout(500);
let boxes = await paneBoxes();
check('切换为左右分屏', (await page.getAttribute('#chartGrid', 'data-split')) === 'row');
check('左右分屏窗格并排',
  boxes[0].right <= boxes[1].x && Math.abs(boxes[0].y - boxes[1].y) < 1,
  `${boxes[0].right} / ${boxes[1].x}`);

const leftW0 = boxes[0].w, rightW0 = boxes[1].w, chartW0 = boxes[0].chartW;
const divider = await page.locator('#paneResizer').boundingBox();
await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
await page.mouse.down();
await page.mouse.move(divider.x + divider.width / 2 - 160, divider.y + divider.height / 2, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(600);
boxes = await paneBoxes();

check('向左拖分隔线压缩左窗格', boxes[0].w < leftW0 - 100, `${leftW0} -> ${boxes[0].w}`);
check('左窗格压缩后右窗格变宽', boxes[1].w > rightW0 + 100, `${rightW0} -> ${boxes[1].w}`);
check('图表随分隔线重排', boxes[0].chartW < chartW0 - 80, `${chartW0} -> ${boxes[0].chartW}`);
check('左右分屏仍保持并排', boxes[0].right <= boxes[1].x, `${boxes[0].right} / ${boxes[1].x}`);
await page.screenshot({ path: 'shots/18-split-row.png' });

await page.click('#splitSwitch button[data-split="col"]');
await page.waitForTimeout(500);
boxes = await paneBoxes();
check('切回上下分屏',
  (await page.getAttribute('#chartGrid', 'data-split')) === 'col' && boxes[0].bottom <= boxes[1].y,
  `${boxes[0].bottom} / ${boxes[1].y}`);

const topH0 = boxes[0].h, bottomH0 = boxes[1].h;
const divider2 = await page.locator('#paneResizer').boundingBox();
await page.mouse.move(divider2.x + divider2.width / 2, divider2.y + divider2.height / 2);
await page.mouse.down();
await page.mouse.move(divider2.x + divider2.width / 2, divider2.y + divider2.height / 2 - 80, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(600);
boxes = await paneBoxes();
check('上下分屏拖动分隔线同样生效',
  boxes[0].h < topH0 - 40 && boxes[1].h > bottomH0 + 40,
  `${topH0.toFixed(0)}/${bottomH0.toFixed(0)} -> ${boxes[0].h.toFixed(0)}/${boxes[1].h.toFixed(0)}`);

await page.dblclick('#paneResizer');
await page.waitForTimeout(400);
boxes = await paneBoxes();
check('双击分隔线恢复 50/50', Math.abs(boxes[0].h - boxes[1].h) < 4,
  `${boxes[0].h.toFixed(0)} / ${boxes[1].h.toFixed(0)}`);

await page.click('#layoutSwitch button[data-layout="1"]');
await page.waitForTimeout(500);
check('单窗格隐藏方向切换和分隔线',
  !(await page.isVisible('#splitSwitch')) && !(await page.isVisible('#paneResizer')));

// ---- 8. 顶栏统一周期条 + 窄屏可用性
check('周期条位于顶栏', await page.evaluate(() => !!document.querySelector('.topbar #periodBar')));
check('窗格内不再有独立周期 header', (await page.locator('.pane-head').count()) === 0);

await page.setViewportSize({ width: 900, height: 800 });
await page.click('#layoutSwitch button[data-layout="2"]');
await page.waitForFunction(() => window.KR.state.panes.length === 2 && window.KR.state.panes[1].bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(500);
const narrow = await page.evaluate(() => {
  const bar = document.querySelector('.topbar');
  const period = document.getElementById('periodBar');
  const ids = ['btnChartSettings', 'btnIndicators', 'btnDrawMenu', 'btnTradePanel'];
  return {
    topbarFits: bar.scrollWidth <= bar.clientWidth + 1,
    actionsInView: ids.every(function (id) {
      const r = document.getElementById(id).getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth;
    }),
    periodScrolls: period.scrollWidth > period.clientWidth
  };
});
check('900px 双窗格顶栏不横向溢出', narrow.topbarFits);
check('900px 下右侧操作按钮仍在视口内', narrow.actionsInView);
check('900px 下周期条自身可横向滚动', narrow.periodScrolls);

await page.click('#periodBar button[data-period="60"]');
await page.waitForFunction(() => window.KR.state.panes.some(function (p) { return p.period === 60; }), { timeout: 15000 });
await page.waitForTimeout(600);
check('窄屏滚动周期条后仍能切周期',
  await page.evaluate(() => !!document.querySelector('#periodBar button.active[data-period="60"]')));

await page.click('#btnDrawMenu');
await page.waitForTimeout(200);
const menu = await page.evaluate(() => {
  const p = document.getElementById('drawPanel');
  const r = p.getBoundingClientRect();
  return { visible: !p.hidden, inView: r.top >= 0 && r.bottom <= innerHeight };
});
check('窄屏下画线菜单完整可见', menu.visible && menu.inView);
await page.click('#btnDrawMenu');

console.log('通过:');
ok.forEach((s2) => console.log('  ✓ ' + s2));
if (bad.length) { console.log('失败:'); bad.forEach((s2) => console.log('  ✗ ' + s2)); }
console.log('控制台错误:', errors.length ? errors.join(' | ') : '(无)');

await browser.close();
process.exitCode = bad.length || errors.length ? 1 : 0;
