import { chromium } from 'playwright';

/* 图表设置: 外观 / K线 / 十字光标 / 预设 / 实时预览 / 持久化 / 多窗格继承 */

const BASE = process.env.BASE || 'http://127.0.0.1:8766/';
const EXE = process.env.PW_CHROME || process.env.PW_EXECUTABLE || '';
const CHANNEL = process.env.CHANNEL || 'msedge';
const browser = await chromium.launch(EXE ? { executablePath: EXE } : { channel: CHANNEL });
const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

const ok = [], bad = [];
const check = (name, cond, extra = '') => (cond ? ok : bad).push(`${name}${extra ? ' :: ' + extra : ''}`);

async function boot() {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
  await page.waitForTimeout(500);
}

async function openSettings() {
  await page.click('#btnChartSettings');
  await page.waitForTimeout(180);
  return page.locator('#chartSettings').isVisible();
}

async function setField(name, value) {
  await page.locator(`#csBody [data-field="${name}"]`).evaluate((el, v) => {
    if (el.type === 'checkbox') el.checked = v;
    else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await page.waitForTimeout(80);
}

/** 实时预览走 rAF + 图表重绘, 断言前等目标值真正落到图表选项上 */
async function waitChart(fn, arg) {
  await page.waitForFunction(fn, arg, { timeout: 5000 });
}

async function chartState() {
  return page.evaluate(() => {
    const chart = window.KR.chart;
    const candle = window.KR.candle;
    const o = chart.options();
    const c = candle.options();
    return {
      bg: o.layout.background.color,
      text: o.layout.textColor,
      fontSize: o.layout.fontSize,
      gridVert: { color: o.grid.vertLines.color, visible: o.grid.vertLines.visible, style: o.grid.vertLines.style },
      gridHorz: { color: o.grid.horzLines.color, visible: o.grid.horzLines.visible, style: o.grid.horzLines.style },
      cross: {
        vert: o.crosshair.vertLine, horz: o.crosshair.horzLine
      },
      up: c.upColor, down: c.downColor,
      borderVisible: c.borderVisible,
      borderUp: c.borderUpColor, borderDown: c.borderDownColor,
      wickVisible: c.wickVisible,
      wickUp: c.wickUpColor, wickDown: c.wickDownColor,
      priceLineVisible: c.priceLineVisible,
      priceLineColor: c.priceLineColor
    };
  });
}

try {
  await boot();

  // ---------- 入口与默认值 ----------
  const before = await chartState();
  check('默认背景 / 网格 / K线外观与旧版一致',
    before.bg === '#131722' && before.gridVert.visible === true &&
    before.up === '#26a69a' && before.down === '#ef5350' &&
    before.borderVisible === false && before.wickVisible === true,
    JSON.stringify({ bg: before.bg, up: before.up, border: before.borderVisible }));

  check('齿轮按钮打开图表设置', await openSettings());
  check('设置弹窗包含三个分类',
    JSON.stringify(await page.locator('#csNav button').allTextContents()) === JSON.stringify(['外观', 'K线', '十字光标']));
  check('默认选中“外观”分类',
    (await page.locator('#csNav button.active').textContent()) === '外观');
  check('预设下拉包含深色 / 浅色 / 午夜蓝 / 自定义',
    JSON.stringify(await page.locator('#csPreset option').allTextContents())
      === JSON.stringify(['深色（默认）', '浅色', '午夜蓝', '自定义']));

  const previewPixel = await page.evaluate(() => {
    const c = document.getElementById('csPreview');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const d = c.getContext('2d').getImageData(Math.round(3 * dpr), Math.round(3 * dpr), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  });
  check('预览画布按当前背景绘制', previewPixel[0] === 19 && previewPixel[1] === 23 && previewPixel[2] === 34,
    JSON.stringify(previewPixel));

  // ---------- 网格 ----------
  await setField('gridVisible', false);
  await waitChart(() => {
    const g = window.KR.chart.options().grid;
    return g.vertLines.visible === false && g.horzLines.visible === false;
  });
  let st = await chartState();
  check('关闭网格后横竖网格线同时隐藏', st.gridVert.visible === false && st.gridHorz.visible === false);
  await setField('gridColor', '#ff0000');
  await setField('gridOpacity', 0.5);
  await page.selectOption('#csBody [data-field="gridStyle"]', '2');
  await waitChart(() => {
    const g = window.KR.chart.options().grid.vertLines;
    return g.color === 'rgba(255, 0, 0, 0.5)' && g.style === 2;
  });
  st = await chartState();
  check('网格颜色 / 透明度 / 线型实时生效',
    st.gridVert.color === 'rgba(255, 0, 0, 0.5)' && st.gridHorz.color === 'rgba(255, 0, 0, 0.5)' &&
    st.gridVert.style === 2 && st.gridHorz.style === 2,
    JSON.stringify(st.gridVert));
  await setField('gridVisible', true);

  // ---------- 背景 + 取消回滚 ----------
  await setField('background', '#ffffff');
  await waitChart(() => window.KR.chart.options().layout.background.color === '#ffffff');
  st = await chartState();
  const cssBg = await page.evaluate(() => getComputedStyle(document.getElementById('chartGrid')).getPropertyValue('--chart-bg').trim());
  check('背景色实时生效并同步窗格底色', st.bg === '#ffffff' && cssBg === '#ffffff', `${st.bg} / ${cssBg}`);
  await page.click('#csCancel');
  await waitChart(() => window.KR.chart.options().layout.background.color === '#131722');
  st = await chartState();
  const storedAfterCancel = await page.evaluate(() => localStorage.getItem('kline-replay:chart-style'));
  check('取消后恢复原样式且不落盘',
    (await page.locator('#chartSettings').isHidden()) && st.bg === '#131722' && storedAfterCancel === null,
    JSON.stringify({ bg: st.bg, stored: storedAfterCancel }));

  // ---------- K线实体 / 边框 / 影线 ----------
  await openSettings();
  await page.click('#csNav button[data-tab="candles"]');
  await page.waitForTimeout(120);
  check('K线分类包含实体 / 边框 / 影线设置',
    (await page.locator('#csBody [data-field="upColor"]').count()) === 1 &&
    (await page.locator('#csBody [data-field="upOpacity"]').count()) === 1 &&
    (await page.locator('#csBody [data-field="borderColor"]').count()) === 1 &&
    (await page.locator('#csBody [data-field="wickColor"]').count()) === 1 &&
    (await page.locator('#csBody [data-field="volumeOpacity"]').count()) === 1);

  await setField('upColor', '#00ff00');
  await setField('upOpacity', 0.4);
  await setField('downColor', '#0000ff');
  await setField('downOpacity', 0.6);
  await setField('borderVisible', true);
  await setField('borderFollow', false);
  await setField('borderColor', '#ff00ff');
  await setField('borderOpacity', 0.5);
  await setField('wickFollow', false);
  await setField('wickColor', '#00ffff');
  await setField('wickOpacity', 0.25);
  await waitChart(() => {
    const c = window.KR.candle.options();
    return c.upColor === 'rgba(0, 255, 0, 0.4)' &&
      c.borderUpColor === 'rgba(255, 0, 255, 0.5)' &&
      c.wickUpColor === 'rgba(0, 255, 255, 0.25)';
  });
  st = await chartState();
  check('K线实体支持独立颜色 + 透明度',
    st.up === 'rgba(0, 255, 0, 0.4)' && st.down === 'rgba(0, 0, 255, 0.6)',
    `${st.up} / ${st.down}`);
  check('边框颜色 + 透明度独立生效',
    st.borderVisible === true && st.borderUp === 'rgba(255, 0, 255, 0.5)' &&
    st.borderDown === 'rgba(255, 0, 255, 0.5)',
    `${st.borderUp} / ${st.borderDown}`);
  check('影线颜色 + 透明度独立生效',
    st.wickVisible === true && st.wickUp === 'rgba(0, 255, 255, 0.25)' &&
    st.wickDown === 'rgba(0, 255, 255, 0.25)',
    `${st.wickUp} / ${st.wickDown}`);

  await setField('volumeOpacity', 0.2);
  await page.waitForTimeout(350);
  const vol = await page.evaluate(() => {
    const p = window.KR.state.panes[0];
    const data = window.KR.volume.data();
    const bar = p.bars[p.cursor];
    return { color: data[data.length - 1].color, up: bar.close >= bar.open };
  });
  check('成交量柱颜色跟随涨跌色并使用独立透明度',
    vol.color === (vol.up ? 'rgba(0, 255, 0, 0.2)' : 'rgba(0, 0, 255, 0.2)'),
    JSON.stringify(vol));

  await page.click('#csApply');
  await page.waitForTimeout(250);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('kline-replay:chart-style')));
  const committed = await page.evaluate(() => window.KR.chartStyle);
  check('应用后关闭弹窗并写入 localStorage',
    (await page.locator('#chartSettings').isHidden()) && saved.background === '#131722' &&
    saved.upColor === '#00ff00' && saved.upOpacity === 0.4 &&
    committed.borderFollow === false,
    JSON.stringify({ up: saved && saved.upColor, follow: committed && committed.borderFollow }));

  // ---------- 刷新后保持 ----------
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
  await page.waitForTimeout(600);
  st = await chartState();
  check('刷新后 K 线外观从本地存储恢复',
    st.up === 'rgba(0, 255, 0, 0.4)' && st.borderUp === 'rgba(255, 0, 255, 0.5)' &&
    st.wickUp === 'rgba(0, 255, 255, 0.25)',
    `${st.up} / ${st.borderUp} / ${st.wickUp}`);

  // ---------- 十字光标 ----------
  check('刷新后仍可打开设置', await openSettings());
  await page.click('#csNav button[data-tab="crosshair"]');
  await page.waitForTimeout(120);
  await setField('crosshairVisible', false);
  await setField('crosshairColor', '#123456');
  await setField('crosshairOpacity', 0.5);
  await page.selectOption('#csBody [data-field="crosshairStyle"]', '2');
  await setField('crosshairLabelBg', '#abcdef');
  await waitChart(() => {
    const v = window.KR.chart.options().crosshair.vertLine;
    return v.color === 'rgba(18, 52, 86, 0.5)' && v.visible === false &&
      v.style === 2 && v.labelBackgroundColor === '#abcdef';
  });
  st = await chartState();
  check('十字光标显隐 / 颜色透明度 / 线型 / 标签背景实时生效',
    st.cross.vert.visible === false && st.cross.horz.visible === false &&
    st.cross.vert.labelVisible === false &&
    st.cross.vert.color === 'rgba(18, 52, 86, 0.5)' && st.cross.vert.style === 2 &&
    st.cross.vert.labelBackgroundColor === '#abcdef',
    JSON.stringify(st.cross.vert));
  await page.click('#csApply');
  await page.waitForTimeout(200);

  // ---------- 恢复默认 ----------
  await openSettings();
  await page.click('#csReset');
  await waitChart(() => window.KR.candle.options().upColor === '#26a69a');
  st = await chartState();
  check('恢复默认只改预览，点应用前不落盘',
    st.bg === '#131722' && st.up === '#26a69a' &&
    (await page.evaluate(() => window.KR.chartStyle.upColor)) === '#00ff00',
    JSON.stringify({ live: st.up, committed: await page.evaluate(() => window.KR.chartStyle.upColor) }));
  await page.click('#csApply');
  await page.waitForTimeout(200);
  const defaultStored = await page.evaluate(() => JSON.parse(localStorage.getItem('kline-replay:chart-style')));
  check('恢复默认并应用后完全回到默认样式',
    defaultStored.background === '#131722' && defaultStored.upColor === '#26a69a' &&
    defaultStored.borderVisible === false && defaultStored.crosshairVisible === true,
    JSON.stringify(defaultStored));

  // ---------- 播放中应用样式: 回放推进不能把成交量刷回旧色 ----------
  await page.selectOption('#speedSelect', '16');
  await page.evaluate(() => window.KR.api.setCursor(120));
  await page.click('#btnPlay');
  await page.waitForFunction(() => window.KR.state.playing && window.KR.state.cursor > 120, { timeout: 5000 });
  await openSettings();
  await page.click('#csNav button[data-tab="candles"]');
  await setField('upColor', '#ff0000');
  await setField('downColor', '#ffff00');
  await setField('volumeOpacity', 0.3);
  await waitChart(() => window.KR.candle.options().upColor === '#ff0000');
  const cursorBefore = await page.evaluate(() => {
    const p = window.KR.state.panes[0];
    return p.cursor;
  });
  // 等实时成交量重算完成, 再让回放多推进几根, 模拟「预览后又被 updatePane 覆盖」
  await page.waitForTimeout(350);
  await page.waitForFunction((n) => window.KR.state.panes[0].cursor > n, cursorBefore, { timeout: 5000 });
  await page.click('#csApply');
  await page.waitForTimeout(80);
  if (await page.evaluate(() => window.KR.state.playing)) await page.click('#btnPlay');
  await page.waitForFunction(() => !window.KR.state.playing, { timeout: 3000 });
  await page.waitForTimeout(150);
  const volAfterPlay = await page.evaluate(() => {
    const p = window.KR.state.panes[0];
    const data = window.KR.volume.data();
    let bad = 0, sample = '';
    for (let i = 0; i < data.length; i++) {
      const b = p.bars[i];
      if (!b) continue;
      const expected = b.close >= b.open ? 'rgba(255, 0, 0, 0.3)' : 'rgba(255, 255, 0, 0.3)';
      if (data[i].color !== expected) {
        bad++;
        if (!sample) sample = data[i].color;
      }
    }
    return { bad, sample, len: data.length, cursor: p.cursor, playing: window.KR.state.playing };
  });
  check('播放中应用设置后成交量柱全部换成新颜色',
    volAfterPlay.bad === 0 && volAfterPlay.playing === false,
    JSON.stringify(volAfterPlay));

  // ---------- 浅色预设 ----------
  await openSettings();
  await page.selectOption('#csPreset', 'light');
  await waitChart(() => {
    const o = window.KR.chart.options();
    const c = window.KR.candle.options();
    return o.layout.background.color === '#ffffff' && c.upColor === '#089981' &&
      o.layout.textColor === '#131722';
  });
  st = await chartState();
  check('浅色预设实时切换背景与涨跌色',
    st.bg === '#ffffff' && st.up === '#089981' && st.down === '#f23645' &&
    st.text === '#131722',
    JSON.stringify({ bg: st.bg, up: st.up, text: st.text }));
  const legendColor = await page.evaluate(() => getComputedStyle(document.querySelector('.legend .sym')).color);
  check('图例文字颜色跟随浅色背景', legendColor === 'rgb(19, 23, 34)', legendColor);
  await page.click('#csApply');
  await page.waitForTimeout(200);

  // ---------- 多窗格继承 ----------
  await page.click('#layoutSwitch button[data-layout="2"]');
  await page.waitForFunction(() => window.KR.state.panes.length === 2 && window.KR.state.panes[1].bars.length > 0,
    { timeout: 20000 });
  await page.waitForTimeout(300);
  const panes = await page.evaluate(() => window.KR.state.panes.map((p) => ({
    bg: p.chart.options().layout.background.color,
    up: p.candle.options().upColor
  })));
  check('新窗格自动继承当前样式',
    panes.length === 2 && panes.every((p) => p.bg === '#ffffff' && p.up === '#089981'),
    JSON.stringify(panes));

  // ---------- 右键菜单入口 ----------
  const box = await page.locator('#chartWrap').boundingBox();
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.5, { button: 'right' });
  await page.waitForTimeout(150);
  const menuItem = page.locator('#ctxMenu .ctx-item', { hasText: '图表设置…' });
  check('图表右键菜单包含“图表设置…”', await menuItem.count() === 1);
  await menuItem.click();
  await page.waitForTimeout(180);
  check('右键菜单可打开设置弹窗', await page.locator('#chartSettings').isVisible());

  // ---------- Esc 取消 ----------
  await setField('background', '#00ff00');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.KR.chart.options().layout.background.color === '#ffffff', { timeout: 5000 });
  st = await chartState();
  check('Esc 关闭设置并回滚未应用的改动',
    (await page.locator('#chartSettings').isHidden()) && st.bg === '#ffffff',
    JSON.stringify({ bg: st.bg }));

  // ---------- 脏数据清洗 ----------
  await page.evaluate(() => {
    localStorage.setItem('kline-replay:chart-style', JSON.stringify({
      background: 'red', upOpacity: 5, fontSize: 99,
      volumeOpacity: null, borderOpacity: '', crosshairOpacity: [],
      gridVisible: 'no', borderVisible: null, crosshairStyle: 9
    }));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0, { timeout: 20000 });
  await page.waitForTimeout(500);
  const dirty = await chartState();
  const dirtyStyle = await page.evaluate(() => window.KR.chartStyle);
  check('非法本地样式回退默认并夹紧数值',
    dirty.bg === '#131722' && dirty.up === '#26a69a' &&
    dirtyStyle.upOpacity === 1 && dirtyStyle.fontSize === 16 &&
    dirtyStyle.volumeOpacity === 0.42 && dirtyStyle.borderOpacity === 1 &&
    dirtyStyle.crosshairOpacity === 1 &&
    dirty.gridVert.visible === true && dirty.borderVisible === false &&
    dirtyStyle.crosshairStyle === 4,
    JSON.stringify({
      bg: dirty.bg, upOpacity: dirtyStyle.upOpacity, fontSize: dirtyStyle.fontSize,
      volumeOpacity: dirtyStyle.volumeOpacity, borderOpacity: dirtyStyle.borderOpacity,
      crosshairOpacity: dirtyStyle.crosshairOpacity, border: dirty.borderVisible
    }));
} catch (e) {
  bad.push('EXCEPTION :: ' + e.message + '\n' + e.stack);
}

console.log('== 图表设置验证 ==');
console.log('通过 ' + ok.length + '\n' + ok.map((x) => '  ✓ ' + x).join('\n'));
if (bad.length) console.log('失败 ' + bad.length + '\n' + bad.map((x) => '  ✗ ' + x).join('\n'));
if (errors.length) console.log('控制台错误\n' + errors.map((x) => '  ! ' + x).join('\n'));
await browser.close();
process.exit(bad.length || errors.length ? 1 : 0);
