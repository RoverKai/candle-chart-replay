import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8766/';
const EXE = process.env.PW_CHROME || process.env.PW_EXECUTABLE || '';
const CHANNEL = process.env.CHANNEL || 'msedge';
const browser = await chromium.launch(EXE ? { executablePath: EXE } : { channel: CHANNEL });
const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.panes[0].bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(900);

const ok = [], bad = [];
const check = (name, cond, extra = '') => (cond ? ok : bad).push(`${name}${extra ? ' :: ' + extra : ''}`);

const box = await page.locator('#chartHost').boundingBox();
const P = (fx, fy) => [Math.round(box.x + box.width * fx), Math.round(box.y + box.height * fy)];

// 趋势线: 起点靠左(回退后仍在可视区), 终点贴右边(回退后会落到"未来")
await page.click('button[data-tool="trend"]');
await page.mouse.click(...P(0.15, 0.70));
await page.mouse.click(...P(0.92, 0.35));
await page.waitForTimeout(300);

// 水平线: 画在价格区中部
await page.click('button[data-tool="hline"]');
await page.mouse.click(...P(0.50, 0.28));
await page.waitForTimeout(300);

const pre = await page.evaluate(() => {
  const dl = window.KR.drawLayer;
  return dl.drawings.map((d) => d.type);
});
check('已画出一条趋势线 + 一条水平线', pre.length === 2, pre.join(','));

// 回退 100 根: 趋势线终点进入"未来", 起点仍在可视区
await page.evaluate(() => window.KR.api.setCursor(window.KR.state.cursor - 100));
await page.waitForTimeout(700);

const geo = await page.evaluate(() => {
  const dl = window.KR.drawLayer;
  const pw = dl.plotWidth();
  const t = dl.drawings.find((d) => d.type === 'trend');
  const h = dl.drawings.find((d) => d.type === 'hline');
  const a = dl.xyOf(t.pts[0]);
  const b = dl.xyOf(t.pts[1]);
  const hp = dl.xyOf(h.pts[0]);
  return {
    plotWidth: Math.round(pw),
    a: a ? { x: Math.round(a.x), y: Math.round(a.y) } : null,
    b: b ? { x: Math.round(b.x), y: Math.round(b.y) } : null,
    h: hp ? { x: Math.round(hp.x), y: Math.round(hp.y) } : null
  };
});

check('趋势线起点仍在可视区', geo.a && geo.a.x >= 0 && geo.a.x <= geo.plotWidth, JSON.stringify(geo.a));
check('趋势线终点(未来)仍能算出坐标', geo.b !== null, JSON.stringify(geo.b));
check('终点落在可视区右侧之外', geo.b && geo.b.x > geo.plotWidth, `x=${geo.b && geo.b.x} > ${geo.plotWidth}`);
check('水平线锚点在未来也仍能定位', geo.h !== null, JSON.stringify(geo.h));

// 像素级: 趋势线在可视区内应真的画出来了
const px = await page.evaluate(() => {
  const cv = document.getElementById('drawLayer');
  const ctx = cv.getContext('2d');
  const dl = window.KR.drawLayer;
  const out = {};
  const t = dl.drawings.find((d) => d.type === 'trend');
  const a = dl.xyOf(t.pts[0]);
  const b = dl.xyOf(t.pts[1]);
  const pw = dl.plotWidth();
  out.trend = false;
  if (a && b && b.x !== a.x) {
    // 在「起点 -> 可视区右边界」之间采样, 不能取到起点左侧
    const xr = Math.min(b.x, pw - 20);
    const x = Math.round((Math.max(a.x, 20) + xr) / 2);
    const y = Math.round(a.y + (b.y - a.y) * ((x - a.x) / (b.x - a.x)));
    out.at = [x, y];
    for (let dy = -4; dy <= 4 && !out.trend; dy++) {
      const d = ctx.getImageData(x, y + dy, 1, 1).data;
      if (d[3] > 40) out.trend = true;
    }
  }

  const h = dl.drawings.find((d) => d.type === 'hline');
  const hp = dl.xyOf(h.pts[0]);
  out.hline = false;
  if (hp && hp.y >= 0 && hp.y < cv.height) {
    for (let x = 40; x < pw - 60 && !out.hline; x += 25) {
      const d = ctx.getImageData(x, Math.round(hp.y), 1, 1).data;
      if (d[3] > 40) out.hline = true;
    }
    out.hy = Math.round(hp.y);
  }
  return out;
});
check('趋势线在可视区确实被绘制', px.trend, JSON.stringify(px));
check('水平线整条被绘制', px.hline, JSON.stringify(px));

// ---- 回放时端点可以落在游标之后的空白未来区 ----
// 先露出更多右侧未来空白 (等价于用户把图表往左拖): 截图更直观, 也能验证较远的未来落点
await page.evaluate(() => {
  const n = window.KR.state.cursor + 1;
  window.KR.chart.timeScale().setVisibleLogicalRange({ from: n - 140, to: n + 80 });
});
await page.waitForTimeout(500);
const futureGeom = await page.evaluate(() => {
  const dl = window.KR.drawLayer, ts = window.KR.chart.timeScale();
  const bars = window.KR.state.bars, cur = window.KR.state.cursor;
  const x = Math.min(ts.width(), dl.plotWidth()) - 3;
  const y = window.KR.chart.panes()[0].getHeight() * 0.55;
  const pt = dl.pointOf(x, y);
  const idx = pt ? bars.findIndex((b) => b.time === pt.time) : -1;
  return { cur, total: bars.length, x, y, idx, time: pt && pt.time };
});
check('游标右侧空白区可落点为未来 K 线', futureGeom.idx > futureGeom.cur,
  `idx=${futureGeom.idx} cursor=${futureGeom.cur}`);
check('未来落点不超过完整数据最后一根', futureGeom.idx >= 0 && futureGeom.idx < futureGeom.total,
  `idx=${futureGeom.idx} total=${futureGeom.total}`);

// 两点工具的第一点直接落在未来空白区
await page.click('button[data-tool="trend"]');
await page.mouse.click(box.x + futureGeom.x, box.y + futureGeom.y);
await page.waitForTimeout(200);
const pendingFuture = await page.evaluate(() => {
  const dl = window.KR.drawLayer, bars = window.KR.state.bars;
  const p = dl.pending;
  return p ? { idx: bars.findIndex((b) => b.time === p.time), tool: dl.tool } : null;
});
check('两点工具的第一点也能落在未来区',
  pendingFuture && pendingFuture.tool === 'trend' && pendingFuture.idx > futureGeom.cur,
  JSON.stringify(pendingFuture));
await page.keyboard.press('Escape');   // 取消 pending
await page.keyboard.press('Escape');   // 回光标模式
await page.waitForTimeout(150);

// 起点在已播放区、终点在空白未来区, 完整画一条趋势线
await page.click('button[data-tool="trend"]');
const plan = await page.evaluate(() => {
  const dl = window.KR.drawLayer, ts = window.KR.chart.timeScale();
  const bars = window.KR.state.bars, cur = window.KR.state.cursor;
  const from = Math.max(0, cur - 40);
  const height = window.KR.chart.panes()[0].getHeight();
  const y0 = dl.yOf(bars[from].low);
  return {
    x0: ts.logicalToCoordinate(from), y0: y0 == null ? height * 0.6 : y0,
    x1: dl.plotWidth() - 4, y1: height * 0.3
  };
});
await page.mouse.click(box.x + plan.x0, box.y + plan.y0);
await page.mouse.move(box.x + plan.x1, box.y + plan.y1, { steps: 8 });
await page.waitForTimeout(150);
await page.mouse.click(box.x + plan.x1, box.y + plan.y1);
await page.waitForTimeout(350);
const futureDraw = await page.evaluate(() => {
  const dl = window.KR.drawLayer, bars = window.KR.state.bars;
  const d = dl.drawings[dl.drawings.length - 1];
  const indices = d.pts.map((p) => bars.findIndex((b) => b.time === p.time));
  const a = dl.xyOf(d.pts[0]), b = dl.xyOf(d.pts[1]);
  const pw = dl.plotWidth();
  const ctx = document.getElementById('drawLayer').getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  let painted = false, sample = null;
  if (a && b && b.x !== a.x) {
    const ratio = 0.9;
    const sx = Math.round((a.x + (b.x - a.x) * ratio) * dpr);
    const sy = Math.round((a.y + (b.y - a.y) * ratio) * dpr);
    sample = { x: Math.round(sx / dpr), y: Math.round(sy / dpr) };
    for (let dx = -4; dx <= 4 && !painted; dx++) {
      for (let dy = -4; dy <= 4 && !painted; dy++) {
        const px = ctx.getImageData(sx + dx, sy + dy, 1, 1).data;
        if (px[3] > 40) painted = true;
      }
    }
  }
  return { type: d.type, indices, a, b, pw, tool: dl.tool, painted, sample };
});
check('起点在已播放区、终点在未来区的趋势线可完成',
  futureDraw.type === 'trend' && futureDraw.tool === 'cursor' &&
    futureDraw.indices[0] <= futureGeom.cur && futureDraw.indices[1] > futureGeom.cur,
  JSON.stringify(futureDraw.indices) + ' tool=' + futureDraw.tool);
check('未来段落在画布上可见',
  futureDraw.painted && futureDraw.b && futureDraw.b.x <= futureDraw.pw,
  JSON.stringify(futureDraw.sample));

// 两端都落在未来空白区的趋势线: 整条都在游标之后, 也必须真的画出来
await page.click('button[data-tool="trend"]');
const futureOnlyPlan = await page.evaluate(() => {
  const dl = window.KR.drawLayer;
  const height = window.KR.chart.panes()[0].getHeight();
  const pw = dl.plotWidth();
  return { x0: Math.round(pw * 0.72), y0: Math.round(height * 0.62),
           x1: Math.round(pw * 0.9), y1: Math.round(height * 0.42) };
});
await page.mouse.click(box.x + futureOnlyPlan.x0, box.y + futureOnlyPlan.y0);
await page.mouse.move(box.x + futureOnlyPlan.x1, box.y + futureOnlyPlan.y1, { steps: 6 });
await page.waitForTimeout(120);
await page.mouse.click(box.x + futureOnlyPlan.x1, box.y + futureOnlyPlan.y1);
await page.waitForTimeout(350);
const futureOnly = await page.evaluate(() => {
  const dl = window.KR.drawLayer, bars = window.KR.state.bars;
  const d = dl.drawings[dl.drawings.length - 1];
  const indices = d.pts.map((p) => bars.findIndex((b) => b.time === p.time));
  const a = dl.xyOf(d.pts[0]), b = dl.xyOf(d.pts[1]);
  const ctx = document.getElementById('drawLayer').getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  let painted = false, sample = null;
  if (a && b && b.x !== a.x) {
    const ratio = 0.5;
    const sx = Math.round((a.x + (b.x - a.x) * ratio) * dpr);
    const sy = Math.round((a.y + (b.y - a.y) * ratio) * dpr);
    sample = { x: Math.round(sx / dpr), y: Math.round(sy / dpr) };
    for (let dx = -4; dx <= 4 && !painted; dx++) {
      for (let dy = -4; dy <= 4 && !painted; dy++) {
        const px = ctx.getImageData(sx + dx, sy + dy, 1, 1).data;
        if (px[3] > 40) painted = true;
      }
    }
  }
  return { type: d.type, indices, cursor: window.KR.state.cursor, a, b, painted, sample, tool: dl.tool };
});
check('两端都在未来区的趋势线可完成',
  futureOnly.type === 'trend' && futureOnly.tool === 'cursor' &&
    futureOnly.indices[0] > futureOnly.cursor && futureOnly.indices[1] > futureOnly.cursor,
  JSON.stringify(futureOnly.indices) + ' cursor=' + futureOnly.cursor);
check('纯未来趋势线在画布上可见',
  futureOnly.painted && futureOnly.a && futureOnly.b && futureOnly.b.x <= futureGeom.x + 1,
  JSON.stringify(futureOnly.sample));
await page.screenshot({ path: 'shots/20-future-endpoint.png' });

// 大幅回退后坐标依然可算（不再变 null）
await page.evaluate(() => window.KR.api.setCursor(300));
await page.waitForTimeout(700);
const far = await page.evaluate(() => {
  const dl = window.KR.drawLayer;
  return dl.drawings.map((d) => ({
    type: d.type,
    pts: d.pts.map((p) => dl.xyOf(p)),
    allOk: d.pts.every((p) => dl.xyOf(p) !== null)
  })).map((x) => x.allOk);
});
check('大幅回退后锚点不再返回 null', far.every(Boolean), JSON.stringify(far));

await page.evaluate(() => window.KR.api.setCursor(window.KR.state.cursor + 60));
await page.waitForTimeout(600);
await page.screenshot({ path: 'shots/16-future-drawings.png' });

console.log('通过:');
ok.forEach((s) => console.log('  ✓ ' + s));
if (bad.length) { console.log('失败:'); bad.forEach((s) => console.log('  ✗ ' + s)); }
console.log('控制台错误:', errors.length ? errors.join(' | ') : '(无)');

await browser.close();
process.exitCode = bad.length || errors.length ? 1 : 0;
