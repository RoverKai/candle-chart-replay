import { chromium } from 'playwright';

/* Shift 横向锁定 / Ctrl 吸附 OHLC / 光标模式 Ctrl 复制, 三者互不打架 */

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
await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(800);

const ok = [], bad = [];
const check = (name, cond, extra = '') => (cond ? ok : bad).push(`${name}${extra ? ' :: ' + extra : ''}`);

const box = await page.locator('#chartWrap').boundingBox();
const P = (fx, fy) => [Math.round(box.x + box.width * fx), Math.round(box.y + box.height * fy)];
const at = (x, y) => [Math.round(box.x + x), Math.round(box.y + y)];

async function reset() {
  await page.evaluate(() => {
    const dl = window.KR.drawLayer;
    dl.setTool('cursor');
    dl.setDrawings([]);
  });
  await page.waitForTimeout(120);
}

async function drawTrend(p0, p1) {
  await page.click('button[data-tool="trend"]');
  await page.mouse.click(...p0);
  await page.mouse.click(...p1);
  await page.waitForTimeout(200);
  return page.evaluate(() => window.KR.drawLayer.drawings[window.KR.drawLayer.drawings.length - 1]);
}

/* 在可视区里找一根 K 线, 让 H 明显离其它三个价位更近, 便于断言吸附结果 */
async function pickHighTarget(afterX) {
  return page.evaluate((afterX) => {
    const dl = window.KR.drawLayer, ts = window.KR.chart.timeScale();
    const bars = window.KR.state.bars;
    const r = ts.getVisibleLogicalRange();
    const limit = Math.min(window.KR.state.cursor, bars.length - 1);
    const from = Math.max(0, Math.ceil(r.from)), to = Math.min(limit, Math.floor(r.to));
    for (let i = Math.floor((from + to) / 2); i <= to; i++) {
      const b = bars[i];
      if (!b) continue;
      const x = ts.logicalToCoordinate(i);
      if (x == null || x < afterX + 40) continue;
      const ys = { O: dl.yOf(b.open), H: dl.yOf(b.high), L: dl.yOf(b.low), C: dl.yOf(b.close) };
      if (Object.values(ys).some((v) => v == null)) continue;
      const y = ys.H + 2;
      const dists = Object.entries(ys).map(([k, v]) => [k, Math.abs(y - v)]).sort((a, b) => a[1] - b[1]);
      if (dists[0][0] === 'H' && dists[1][1] - dists[0][1] > 3) {
        return { x, y, time: b.time, price: b.high };
      }
    }
    return null;
  }, afterX);
}

try {
  // ================= 0. 四档价位都能被正确判定 =================
  const nearest = await page.evaluate(() => {
    const dl = window.KR.drawLayer, ts = window.KR.chart.timeScale();
    const bars = window.KR.state.bars;
    const r = ts.getVisibleLogicalRange();
    const from = Math.max(0, Math.ceil(r.from)), to = Math.min(window.KR.state.cursor, bars.length - 1);
    for (let i = from; i <= to; i++) {
      const b = bars[i];
      if (!b || new Set([b.open, b.high, b.low, b.close]).size < 4) continue;
      const ys = [dl.yOf(b.open), dl.yOf(b.high), dl.yOf(b.low), dl.yOf(b.close)];
      if (ys.some((v) => v == null)) continue;
      let sep = true;
      for (let a = 0; a < 4 && sep; a++) {
        for (let c = a + 1; c < 4; c++) if (Math.abs(ys[a] - ys[c]) < 3) { sep = false; break; }
      }
      if (!sep) continue;
      const kinds = ['open', 'high', 'low', 'close'].map((k) => dl._nearestOHLC(b, dl.yOf(b[k])).kind).join('');
      return { kinds, t: b.time };
    }
    return null;
  });
  check('O/H/L/C 四档吸附判定正确', nearest && nearest.kinds === 'OHLC',
    nearest ? `kinds=${nearest.kinds}` : '找不到价位分离的可视 K 线');

  // ================= 1. 画线第二点 Ctrl 吸附 =================
  await reset();
  await page.click('button[data-tool="trend"]');
  await page.mouse.click(...P(0.28, 0.72));
  const target = await pickHighTarget(80);
  check('找到可吸附的目标 K 线', !!target, target ? `t=${target.time} H=${target.price}` : 'none');
  if (target) {
    await page.keyboard.down('Control');
    await page.mouse.move(...at(target.x, target.y), { steps: 10 });
    await page.waitForTimeout(150);
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.up('Control');
    await page.waitForTimeout(250);

    const d = await page.evaluate(() => {
      const dl = window.KR.drawLayer;
      return { pts: dl.drawings[dl.drawings.length - 1].pts, tool: dl.tool };
    });
    check('第二点吸附到 H 价', Math.abs(d.pts[1].price - target.price) < 1e-9,
      `期望 ${target.price} 实际 ${d.pts[1].price}`);
    check('第二点吸附到目标 K 线', d.pts[1].time === target.time,
      `期望 ${target.time} 实际 ${d.pts[1].time}`);
    check('落点后回光标模式', d.tool === 'cursor', d.tool);
  }

  // ================= 1b. 单点工具同样支持 Ctrl 吸附 =================
  await reset();
  await page.click('button[data-tool="hline"]');
  const t2 = await pickHighTarget(80);
  if (t2) {
    await page.keyboard.down('Control');
    await page.mouse.move(...at(t2.x, t2.y), { steps: 6 });
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.up('Control');
    await page.waitForTimeout(200);
    const h = await page.evaluate(() => {
      const d = window.KR.drawLayer.drawings[0];
      return d ? d.pts[0] : null;
    });
    check('单点工具 Ctrl 吸附', h && Math.abs(h.price - t2.price) < 1e-9,
      h ? `期望 ${t2.price} 实际 ${h.price}` : 'missing');
  }

  // ================= 2. Shift 画线只横向移动 =================
  await reset();
  await page.click('button[data-tool="trend"]');
  await page.mouse.click(...P(0.25, 0.65));
  await page.keyboard.down('Shift');
  await page.mouse.move(...P(0.55, 0.35), { steps: 10 });
  await page.waitForTimeout(100);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(250);

  const shiftLine = await page.evaluate(() => {
    const dl = window.KR.drawLayer;
    return { id: dl.drawings[dl.drawings.length - 1].id, pts: dl.drawings[dl.drawings.length - 1].pts, count: dl.drawings.length };
  });
  check('Shift 画线价格锁定', Math.abs(shiftLine.pts[1].price - shiftLine.pts[0].price) < 1e-9,
    `p0=${shiftLine.pts[0].price} p1=${shiftLine.pts[1].price}`);
  check('Shift 画线时间变化', shiftLine.pts[1].time !== shiftLine.pts[0].time);

  // ================= 3. Shift 拖端点只横向移动 =================
  const endXY = await page.evaluate((id) => {
    const dl = window.KR.drawLayer;
    const d = dl.drawings.find((x) => x.id === id);
    return { p: dl.xyOf(d.pts[1]), time: d.pts[1].time, price: d.pts[1].price };
  }, shiftLine.id);
  await page.keyboard.down('Shift');
  await page.mouse.move(...at(endXY.p.x, endXY.p.y));
  await page.mouse.down();
  await page.mouse.move(...at(endXY.p.x - 45, endXY.p.y + 35), { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(250);

  const dragged = await page.evaluate((id) => {
    const dl = window.KR.drawLayer;
    const d = dl.drawings.find((x) => x.id === id);
    return { pts: d.pts, count: dl.drawings.length };
  }, shiftLine.id);
  check('Shift 拖端点价格锁定', Math.abs(dragged.pts[1].price - endXY.price) < 1e-9,
    `原 ${endXY.price} 现 ${dragged.pts[1].price}`);
  check('Shift 拖端点时间变化', dragged.pts[1].time !== endXY.time);
  check('拖端点没有意外复制', dragged.count === shiftLine.count, `count=${dragged.count}`);

  // ================= 4. Shift 拖整条水平平移 =================
  await reset();
  const fresh = await drawTrend(P(0.30, 0.45), P(0.60, 0.52));
  const body = await page.evaluate((id) => {
    const dl = window.KR.drawLayer;
    const d = dl.drawings.find((x) => x.id === id);
    const a = dl.xyOf(d.pts[0]), b = dl.xyOf(d.pts[1]);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, pts: d.pts, id: d.id };
  }, fresh.id);
  await page.keyboard.down('Shift');
  await page.mouse.move(...at(body.x, body.y));
  await page.mouse.down();
  await page.mouse.move(...at(body.x + 35, body.y + 25), { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(250);

  const bodyAfter = await page.evaluate((id) => {
    return window.KR.drawLayer.drawings.find((x) => x.id === id).pts;
  }, body.id);
  check('Shift 拖整条价格不变',
    Math.abs(bodyAfter[0].price - body.pts[0].price) < 1e-9 && Math.abs(bodyAfter[1].price - body.pts[1].price) < 1e-9,
    `${body.pts.map((p) => p.price)} -> ${bodyAfter.map((p) => p.price)}`);
  check('Shift 拖整条时间改变',
    bodyAfter[0].time !== body.pts[0].time && bodyAfter[1].time !== body.pts[1].time);

  // ================= 5. 光标模式 Ctrl 仍然复制 =================
  await reset();
  const line5 = await drawTrend(P(0.30, 0.50), P(0.60, 0.40));
  const mid = await page.evaluate((id) => {
    const dl = window.KR.drawLayer, d = dl.drawings.find((x) => x.id === id);
    const a = dl.xyOf(d.pts[0]), b = dl.xyOf(d.pts[1]);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, count: dl.drawings.length };
  }, line5.id);
  await page.keyboard.down('Control');
  await page.mouse.move(...at(mid.x, mid.y));
  await page.mouse.down();
  await page.mouse.move(...at(mid.x + 55, mid.y + 30), { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Control');
  await page.waitForTimeout(300);
  const n1 = await page.evaluate(() => window.KR.drawLayer.drawings.length);
  check('光标模式 Ctrl 拖动复制', n1 === mid.count + 1, `count=${n1} 期望 ${mid.count + 1}`);

  // 端点也是复制, 不是吸附
  const ep = await page.evaluate(() => {
    const dl = window.KR.drawLayer, d = dl.drawings[dl.drawings.length - 1];
    return { p: dl.xyOf(d.pts[1]), count: dl.drawings.length };
  });
  await page.keyboard.down('Control');
  await page.mouse.move(...at(ep.p.x, ep.p.y));
  await page.mouse.down();
  await page.mouse.move(...at(ep.p.x - 40, ep.p.y - 30), { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Control');
  await page.waitForTimeout(300);
  const n2 = await page.evaluate(() => window.KR.drawLayer.drawings.length);
  check('光标模式 Ctrl 拖端点仍是复制', n2 === ep.count + 1, `count=${n2} 期望 ${ep.count + 1}`);

  // ================= 6. 回放游标之后不参与吸附 =================
  await page.evaluate(() => {
    const idx = Math.max(1, Math.floor(window.KR.state.bars.length * 0.6));
    window.KR.api.setCursor(idx);
  });
  await page.waitForTimeout(900);
  const replay = await page.evaluate(() => {
    const dl = window.KR.drawLayer, bars = window.KR.state.bars, cur = window.KR.state.cursor;
    const b = bars[cur], future = bars[cur + 1] || null;
    const old = { shift: dl.mods.shift, ctrl: dl.mods.ctrl };
    dl.mods.shift = false;
    dl.mods.ctrl = true;
    const futureHit = future ? dl._barForTime(future.time) : null;
    const yHigh = dl.yOf(b.high);
    const y = yHigh == null ? window.KR.chart.panes()[0].getHeight() / 2 : yHigh;
    const res = dl._resolvePoint(window.KR.chart.timeScale().width() - 2, y, null, true);
    dl.mods.shift = old.shift;
    dl.mods.ctrl = old.ctrl;
    return {
      cursor: cur,
      barTime: b.time,
      futureTime: future && future.time,
      futureHit: !!futureHit,
      pt: res && res.pt,
      levels: [b.open, b.high, b.low, b.close]
    };
  });
  check('游标之后的 K 线不参与吸附', replay.futureHit === false,
    `cursor=${replay.cursor} future=${replay.futureTime}`);
  check('游标右侧 Ctrl 落点仍钳在游标内',
    replay.pt && replay.pt.time === replay.barTime &&
      replay.levels.some((p) => Math.abs(p - replay.pt.price) < 1e-9),
    replay.pt ? `t=${replay.pt.time} p=${replay.pt.price}` : 'null');

  const fallback = await page.evaluate(() => {
    const dl = window.KR.drawLayer, bars = window.KR.state.bars;
    const saved = dl.getCursor;
    dl.getCursor = () => null;
    const hit = dl._barForTime(bars[bars.length - 1].time);
    dl.getCursor = saved;
    return { hit: !!hit, last: bars[bars.length - 1].time };
  });
  check('getCursor 无效时吸附范围不退化', fallback.hit, `last=${fallback.last}`);

  // ================= 7. 销毁窗格时释放监听 =================
  const disposeCheck = await page.evaluate(async () => {
    window.KR.api.setLayout(2);
    await new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const panes = window.KR.state.panes;
        if ((panes.length === 2 && panes[1].bars.length) || Date.now() - started > 8000) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
    const victimPane = window.KR.state.panes[1];
    const victim = victimPane && victimPane.drawLayer;
    window.KR.api.setLayout(1);
    await new Promise((r) => setTimeout(r, 1200));
    return victim ? {
      disposed: !!victim._disposed,
      stopped: !!victim._syncStopped,
      connected: victim.host.isConnected,
      observerReleased: victimPane.resizeObserver === null,
      panes: window.KR.state.panes.length
    } : null;
  });
  check('销毁窗格后旧画布层已释放', !!disposeCheck && disposeCheck.disposed && disposeCheck.stopped &&
    disposeCheck.connected === false && disposeCheck.observerReleased && disposeCheck.panes === 1,
    JSON.stringify(disposeCheck));
} catch (e) {
  bad.push('EXCEPTION: ' + (e && e.message ? e.message : String(e)));
}

console.log('\n== 通过 ==');
ok.forEach((s) => console.log('  ✓ ' + s));
console.log('\n== 失败 ==');
bad.forEach((s) => console.log('  ✗ ' + s));
if (errors.length) {
  console.log('\n== 页面错误 ==');
  errors.forEach((e) => console.log('  ! ' + e));
}
await browser.close();
process.exit(bad.length || errors.length ? 1 : 0);
