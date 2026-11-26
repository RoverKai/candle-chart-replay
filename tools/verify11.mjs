import { chromium } from 'playwright';

/* 画线样式面板: 右键入口 / 矩形配色与透明度 / fib 自定义水平位 / 旧数据兼容 / 持久化 */

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
await page.waitForTimeout(600);

const ok = [], bad = [];
const check = (name, cond, extra = '') => (cond ? ok : bad).push(`${name}${extra ? ' :: ' + extra : ''}`);
const box = await page.locator('#chartWrap').boundingBox();
const at = (fx, fy) => [Math.round(box.x + box.width * fx), Math.round(box.y + box.height * fy)];

async function draw(type, a, b) {
  await page.click(`button[data-tool="${type}"]`);
  await page.mouse.click(...a);
  await page.mouse.click(...b);
  await page.waitForTimeout(180);
  return page.evaluate(() => window.KR.drawLayer.drawings[window.KR.drawLayer.drawings.length - 1]);
}

async function setField(sel, value) {
  await page.locator(sel).evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

try {
  // ---------- 右键入口不会被 document click 误关 ----------
  const rect = await draw('rect', at(0.22, 0.24), at(0.56, 0.6));
  const rgeo = await page.evaluate((id) => {
    const dl = window.KR.drawLayer, d = dl.drawings.find((x) => x.id === id);
    const a = dl.xyOf(d.pts[0]), b = dl.xyOf(d.pts[1]);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }, rect.id);
  await page.mouse.click(box.x + rgeo.x, box.y + rgeo.y, { button: 'right' });
  await page.waitForTimeout(150);
  const styleItem = page.locator('#ctxMenu .ctx-item', { hasText: '画线样式…' });
  check('右键画线出现“画线样式…”菜单项', await styleItem.count() === 1);
  await styleItem.click();
  await page.waitForTimeout(120);
  check('右键菜单打开样式面板后保持打开',
    await page.locator('#stylePanel').isVisible() && (await page.locator('#styleTitle').textContent()) === '矩形样式');

  // ---------- 矩形样式 ----------
  await setField('#styleBody input[data-field="color"]', '#ff0000');
  await setField('#styleBody input[data-field="fillColor"]', '#00ff00');
  await setField('#styleBody input[data-field="opacity"]', '60');
  await setField('#styleBody input[data-field="fillOpacity"]', '35');
  const rs = await page.evaluate((id) => window.KR.drawLayer.getDrawing(id), rect.id);
  check('矩形边框/填充/整体透明度/填充透明度生效',
    rs.color === '#ff0000' && rs.fillColor === '#00ff00' && rs.opacity === 0.6 && rs.fillOpacity === 0.35,
    JSON.stringify({ color: rs.color, fillColor: rs.fillColor, opacity: rs.opacity, fillOpacity: rs.fillOpacity }));
  await page.click('#styleBody [data-act="save-default"]');

  // ---------- fib 自定义水平位 ----------
  const fib = await draw('fib', at(0.3, 0.7), at(0.7, 0.2));
  const fgeo = await page.evaluate((id) => {
    const dl = window.KR.drawLayer, d = dl.drawings.find((x) => x.id === id);
    const a = dl.xyOf(d.pts[0]), b = dl.xyOf(d.pts[1]);
    return { x: (a.x + b.x) / 2, y: a.y + (b.y - a.y) * 0.5 };
  }, fib.id);
  await page.mouse.dblclick(box.x + fgeo.x, box.y + fgeo.y);
  await page.waitForTimeout(120);
  await page.click('#styleBody [data-act="fib-add"]');
  const rows = await page.locator('#styleBody .fib-row').count();
  const lastVal = await page.locator('#styleBody .fib-row').last().locator('input[type="number"]').inputValue();
  check('斐波那契添加水平位后仍为 8 行且默认 -0.5', rows === 8 && lastVal === '-0.5', `rows=${rows} last=${lastVal}`);
  await page.locator('#styleBody .fib-row').last().locator('input[type="color"]').evaluate((el) => {
    el.value = '#abcdef';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const negLv = await page.evaluate((id) => window.KR.drawLayer.getDrawing(id).levels.find((x) => x.ratio === -0.5), fib.id);
  check('-0.5 水平位可单独配色', !!negLv && negLv.color === '#abcdef', JSON.stringify(negLv));
  await page.click('#styleBody [data-act="save-default"]');

  // ---------- 刷新持久化 ----------
  await page.waitForTimeout(500);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
  await page.waitForTimeout(700);
  const persisted = await page.evaluate(() => {
    const dl = window.KR.drawLayer;
    const rect = dl.getDrawings().find((d) => d.type === 'rect');
    const defaults = JSON.parse(localStorage.getItem('kline-replay:draw-defaults') || '{}');
    return {
      rect: rect && { color: rect.color, fillColor: rect.fillColor, opacity: rect.opacity, fillOpacity: rect.fillOpacity },
      fibNeg: defaults.fib && defaults.fib.levels.some((x) => x.ratio === -0.5),
      rectDefault: defaults.rect && defaults.rect.fillColor
    };
  });
  check('刷新后画线样式保留',
    persisted.rect && persisted.rect.color === '#ff0000' && persisted.rect.fillColor === '#00ff00' &&
    persisted.rect.opacity === 0.6 && persisted.rect.fillOpacity === 0.35,
    JSON.stringify(persisted.rect));
  check('刷新后默认样式保留', persisted.fibNeg === true && persisted.rectDefault === '#00ff00',
    JSON.stringify({ fibNeg: persisted.fibNeg, rectDefault: persisted.rectDefault }));

  // ---------- 面板打开时撤销要同步, 且后续编辑建立新撤销点 ----------
  const undoGeo = await page.evaluate(() => {
    const dl = window.KR.drawLayer;
    const d = dl.getDrawings().find((x) => x.type === 'rect');
    const a = dl.xyOf(d.pts[0]), b = dl.xyOf(d.pts[1]);
    return { id: d.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  });
  await page.mouse.dblclick(box.x + undoGeo.x, box.y + undoGeo.y);
  await page.waitForTimeout(120);
  // 双击选中本身会留下撤销点, 以面板打开后的栈深度为基准
  const panelBase = await page.evaluate(() => window.KR.drawLayer.undoStack.length);
  await setField('#styleBody input[data-field="opacity"]', '30');
  await page.waitForTimeout(80);
  const afterStyleEdit = await page.evaluate((g) => ({
    opacity: window.KR.drawLayer.getDrawing(g.id).opacity,
    undo: window.KR.drawLayer.undoStack.length
  }), undoGeo);
  check('样式修改建立撤销点', afterStyleEdit.undo === panelBase + 1, JSON.stringify(afterStyleEdit));
  // 模拟真实操作: 滑块获得焦点后按 Ctrl+Z, 不能让 onKey 的 input 早退吞掉撤销
  await page.locator('#styleBody input[data-field="opacity"]').focus();
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  const afterUndo = await page.evaluate((g) => {
    const dl = window.KR.drawLayer;
    const slider = document.querySelector('#styleBody input[data-field="opacity"]');
    return { opacity: dl.getDrawing(g.id).opacity, undo: dl.undoStack.length, slider: slider ? slider.value : null };
  }, undoGeo);
  check('撤销后画线样式回滚', afterUndo.opacity === 0.6, String(afterUndo.opacity));
  check('撤销后样式面板滑块同步', afterUndo.slider === '60', String(afterUndo.slider));
  await setField('#styleBody input[data-field="opacity"]', '30');
  await page.waitForTimeout(80);
  const afterReedit = await page.evaluate((g) => ({
    undo: window.KR.drawLayer.undoStack.length,
    opacity: window.KR.drawLayer.getDrawing(g.id).opacity
  }), undoGeo);
  check('撤销后继续编辑会建立新撤销点',
    afterReedit.undo === panelBase + 1 && afterReedit.opacity === 0.3,
    JSON.stringify(afterReedit));

  // ---------- 旧版纯数字 levels 兼容 ----------
  const legacy = await page.evaluate(() => {
    const dl = window.KR.drawLayer;
    const d = dl.getDrawings().find((x) => x.type === 'fib');
    const a = dl.xyOf(d.pts[0]), b = dl.xyOf(d.pts[1]);
    d.levels = [0, 0.236, 0.5, 0.618, 1];
    dl.setDrawings([d]);
    const got = dl.getDrawing(d.id);
    return {
      normalized: got.levels.every((lv) => lv && typeof lv === 'object' && typeof lv.ratio === 'number'),
      palette: got.levels.find((lv) => lv.ratio === 0.5).color === '#4caf50' &&
        got.levels.find((lv) => lv.ratio === 0).color === '#787b86',
      x: (a.x + b.x) / 2,
      yLine: a.y + (b.y - a.y) * 0.5,
      yGap: a.y + (b.y - a.y) * 0.45,
      id: d.id
    };
  });
  check('纯数字 levels 载入后归一化为对象', legacy.normalized === true);
  check('纯数字 levels 沿用默认彩色调色板', legacy.palette === true);
  const px = await page.evaluate((g) => {
    const dl = window.KR.drawLayer;
    const c = document.getElementById('drawLayer');
    const dpr = window.devicePixelRatio || 1;
    const ctx = c.getContext('2d');
    const alphaAt = (x, y) => ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data[3];
    const hit = dl.hitAt(g.x, g.yLine);
    const lineAlpha = Math.max(alphaAt(g.x, g.yLine - 1), alphaAt(g.x, g.yLine), alphaAt(g.x, g.yLine + 1));
    return { line: lineAlpha, gap: alphaAt(g.x, g.yGap), hit: !!hit && hit.id === g.id };
  }, legacy);
  check('纯数字 levels 实际绘制水平位', px.line > 60, `alpha=${px.line}`);
  check('水平位之间不误画', px.gap === 0, `alpha=${px.gap}`);
  check('纯数字 levels 可命中选择画线', px.hit === true);

  // ---------- 测量线不应出现无效样式入口 ----------
  await page.click('button[data-tool="measure"]');
  const m0 = at(0.14, 0.78), m1 = at(0.24, 0.72);
  await page.mouse.move(...m0);
  await page.mouse.down();
  await page.mouse.move(...m1, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  const midX = (m0[0] + m1[0]) / 2, midY = (m0[1] + m1[1]) / 2;
  await page.mouse.click(midX, midY, { button: 'right' });
  await page.waitForTimeout(120);
  const measureStyleItems = await page.locator('#ctxMenu .ctx-item', { hasText: '画线样式…' }).count();
  check('测量线右键不出现画线样式入口', measureStyleItems === 0, `count=${measureStyleItems}`);
  await page.keyboard.press('Escape');
  await page.mouse.dblclick(midX, midY);
  await page.waitForTimeout(120);
  check('测量线双击不打开样式面板', await page.locator('#stylePanel').isHidden());
  await page.click('button[data-tool="cursor"]');

  // ---------- localStorage 写入失败时不谎报已保存 ----------
  await page.mouse.dblclick(box.x + legacy.x, box.y + legacy.yLine);
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    localStorage.removeItem('kline-replay:draw-defaults');
    window.__origSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key) {
      if (String(key).indexOf('kline-replay:draw-defaults') === 0) {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      }
      return window.__origSetItem.apply(this, arguments);
    };
  });
  await page.click('#styleBody [data-act="save-default"]');
  await page.waitForTimeout(120);
  const failState = await page.evaluate(() => {
    const stored = localStorage.getItem('kline-replay:draw-defaults');
    const text = document.getElementById('hint') ? document.getElementById('hint').textContent : '';
    Storage.prototype.setItem = window.__origSetItem;
    delete window.__origSetItem;
    return { stored, text };
  });
  check('存储写入失败时默认样式没有落盘', failState.stored === null, JSON.stringify(failState.stored));
  check('存储写入失败时提示仅本次有效',
    failState.text.indexOf('仅本次会话有效') >= 0 && failState.text.indexOf('已保存为') < 0,
    failState.text);

  // ---------- 空撤销栈不应重绘面板, 也不应吞掉输入框原生撤销 ----------
  await page.evaluate(() => {
    const dl = window.KR.drawLayer;
    dl.undoStack = [];
    const input = document.querySelector('#styleBody .fib-row input[type="number"]');
    input.dataset.keep = '1';
    input.value = '-';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(120);
  const emptyUndo = await page.evaluate(() => {
    const input = document.querySelector('#styleBody .fib-row input[type="number"]');
    return {
      keep: input && input.dataset.keep,
      panel: !document.getElementById('stylePanel').hidden
    };
  });
  check('空撤销栈不重绘样式面板',
    emptyUndo.keep === '1' && emptyUndo.panel === true,
    JSON.stringify(emptyUndo));

  // ---------- fib 非法比例失焦后回填 ----------
  const ratioInput = page.locator('#styleBody .fib-row input[type="number"]').last();
  const ratioBefore = await ratioInput.inputValue();
  await ratioInput.fill('');
  await ratioInput.blur();
  await page.waitForTimeout(100);
  const ratioAfter = await ratioInput.inputValue();
  check('非法 fib 比例失焦后回填',
    ratioAfter === ratioBefore && ratioAfter !== '',
    `${ratioBefore} -> ${ratioAfter}`);

  // ---------- 旧矩形只改边框色时, 填充色块同步 ----------
  await page.click('#btnStyleClose');
  const legacyRect = await page.evaluate(() => {
    const dl = window.KR.drawLayer;
    const bars = window.KR.state.bars;
    const i0 = Math.max(0, window.KR.state.cursor - 60);
    const i1 = Math.max(0, window.KR.state.cursor - 20);
    const d = {
      id: 'legacy-rect', type: 'rect',
      pts: [{ time: bars[i0].time, price: bars[i0].close }, { time: bars[i1].time, price: bars[i1].high }],
      color: '#26a69a', width: 1.4, opacity: 1, fillOpacity: 0.1
    };
    dl.setDrawings([d]);
    const a = dl.xyOf(d.pts[0]), b = dl.xyOf(d.pts[1]);
    return { id: d.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  });
  await page.mouse.dblclick(box.x + legacyRect.x, box.y + legacyRect.y);
  await page.waitForTimeout(150);
  const fillBefore = await page.locator('#styleBody input[data-field="fillColor"]').inputValue();
  await page.locator('#styleBody input[data-field="color"]').evaluate((el) => {
    el.value = '#ff0000';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(100);
  const legacyAfter = await page.evaluate((id) => {
    const d = window.KR.drawLayer.getDrawing(id);
    const fill = document.querySelector('#styleBody input[data-field="fillColor"]');
    return { color: d.color, fillColor: d.fillColor, fillInput: fill && fill.value };
  }, legacyRect.id);
  check('旧矩形改边框色时同步填充色块',
    fillBefore === '#26a69a' && legacyAfter.color === '#ff0000' &&
    legacyAfter.fillColor === '#ff0000' && legacyAfter.fillInput === '#ff0000',
    JSON.stringify({ fillBefore, after: legacyAfter }));
} catch (e) {
  bad.push('EXCEPTION :: ' + e.message + '\n' + e.stack);
}

console.log('== 画线样式验证 ==');
console.log('通过 ' + ok.length + '\n' + ok.map((x) => '  ✓ ' + x).join('\n'));
if (bad.length) console.log('失败 ' + bad.length + '\n' + bad.map((x) => '  ✗ ' + x).join('\n'));
if (errors.length) console.log('控制台错误\n' + errors.map((x) => '  ! ' + x).join('\n'));
await browser.close();
process.exit(bad.length || errors.length ? 1 : 0);
