import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto('http://127.0.0.1:8766/', { waitUntil: 'networkidle' });
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
