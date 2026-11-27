import { chromium } from 'playwright';

/* 悬浮绘图工具栏: 默认显示 / 只渲染勾选工具 / 拖动与位置持久化 / 显隐 / 菜单入口 / 活动窗格 */

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

const ALL_TOOLS = ['cursor', 'trend', 'ray', 'hline', 'vline', 'rect', 'fib', 'text', 'measure'];

async function boot() {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0 && window.FloatTools, { timeout: 20000 });
  await page.waitForTimeout(600);
}

const toolbarInfo = () => page.evaluate(() => {
  const box = document.getElementById('floatTools');
  const grid = document.getElementById('chartGrid');
  const r = box.getBoundingClientRect();
  const g = grid.getBoundingClientRect();
  return {
    hidden: box.hidden,
    display: getComputedStyle(box).display,
    tools: [...box.querySelectorAll('.ft-btn')].map((b) => b.dataset.tool),
    active: [...box.querySelectorAll('.ft-btn.active')].map((b) => b.dataset.tool),
    state: window.FloatTools.state,
    inside: r.x >= g.x && r.y >= g.y && r.right <= g.right && r.bottom <= g.bottom,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    grid: { x: Math.round(g.x), y: Math.round(g.y), w: Math.round(g.width), h: Math.round(g.height) }
  };
});

const panelInfo = () => page.evaluate(() => {
  const p = document.getElementById('floatToolSettings');
  const r = p.getBoundingClientRect();
  return {
    hidden: p.hidden,
    count: p.querySelectorAll('input[data-tool]').length,
    checked: [...p.querySelectorAll('input[data-tool]')].filter((i) => i.checked).map((i) => i.dataset.tool),
    inView: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  };
});

try {
  await boot();

  // ---------- 默认形态 ----------
  let info = await toolbarInfo();
  check('默认显示悬浮工具栏', !info.hidden && info.display === 'flex');
  check('默认列出全部画线工具', JSON.stringify(info.tools) === JSON.stringify(ALL_TOOLS), JSON.stringify(info.tools));
  check('默认高亮光标工具', JSON.stringify(info.active) === JSON.stringify(['cursor']));
  check('工具栏完整落在图表区域内', info.inside, JSON.stringify({ rect: info.rect, grid: info.grid }));
  check('默认停靠右上角', info.rect.x + info.rect.w > info.grid.x + info.grid.w - 60 &&
    info.rect.y < info.grid.y + 80 && info.rect.h <= 50,
    JSON.stringify(info.rect));
  check('未创建任何画线', (await page.evaluate(() => window.KR.state.panes[0].drawLayer.drawings.length)) === 0);
  check('app.js 暴露统一 hint 入口', await page.evaluate(() => typeof window.KR.api.hint === 'function'));
  await page.screenshot({ path: 'shots/23-float-tools.png' });

  // ---------- 设置面板 ----------
  await page.click('#btnFloatSettings');
  await page.waitForTimeout(200);
  let panel = await panelInfo();
  check('齿轮打开设置面板', !panel.hidden && panel.count === 9);
  check('设置面板默认全选', JSON.stringify(panel.checked) === JSON.stringify(ALL_TOOLS), JSON.stringify(panel.checked));
  check('设置面板留在视口内', panel.inView, JSON.stringify(panel.rect));
  check('设置面板在工具栏左侧且不重叠', panel.rect.x + panel.rect.w <= info.rect.x,
    JSON.stringify({ panel: panel.rect, toolbar: info.rect }));
  await page.screenshot({ path: 'shots/24-float-tool-settings.png' });

  await page.locator('#floatToolOptions input[data-tool="ray"]').uncheck();
  await page.locator('#floatToolOptions input[data-tool="measure"]').uncheck();
  await page.waitForTimeout(150);
  info = await toolbarInfo();
  panel = await panelInfo();
  check('取消勾选后只渲染剩余工具',
    JSON.stringify(info.tools) === JSON.stringify(['cursor', 'trend', 'hline', 'vline', 'rect', 'fib', 'text']),
    JSON.stringify(info.tools));
  check('被隐藏的工具从 DOM 移除', !info.tools.includes('ray') && !info.tools.includes('measure'));
  check('设置面板仍保留全部工具', panel.count === 9 && !panel.checked.includes('ray') && !panel.checked.includes('measure'));
  check('工具选择立即写入 localStorage',
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('kline-replay:float-tools'));
      return s.tools.indexOf('ray') < 0 && s.tools.indexOf('measure') < 0;
    }));

  await page.click('#btnFloatDone');
  check('完成按钮关闭设置面板', (await panelInfo()).hidden);

  // ---------- 拖动 ----------
  const before = (await toolbarInfo()).rect;
  const grip = await page.locator('#floatToolsGrip').boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x - 340, grip.y + 190, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(160);
  const dragged = await toolbarInfo();
  check('拖动把手移动工具栏',
    Math.abs(dragged.rect.x - before.x) > 200 && Math.abs(dragged.rect.y - before.y) > 120,
    JSON.stringify({ before, after: dragged.rect }));
  check('拖动后位置比例写入 localStorage', dragged.state.x < 0.9 && dragged.state.y > 0.1,
    JSON.stringify(dragged.state));
  check('拖动不会误建 / 选中画线',
    (await page.evaluate(() => window.KR.drawLayer.drawings.length + '|' + window.KR.drawLayer.selected)) === '0|null');

  await page.click('#btnFloatSettings');
  await page.waitForTimeout(180);
  panel = await panelInfo();
  check('拖动后设置面板重新贴住工具栏并留在视口内', panel.inView, JSON.stringify(panel.rect));
  await page.click('#btnFloatDone');

  // ---------- 选择工具 / 画线 ----------
  await page.locator('#floatToolList .ft-btn[data-tool="trend"]').click();
  await page.waitForTimeout(120);
  let picked = await page.evaluate(() => ({
    float: [...document.querySelectorAll('#floatToolList .ft-btn.active')].map((b) => b.dataset.tool),
    side: [...document.querySelectorAll('#toolbar .tool-btn.active')].map((b) => b.dataset.tool),
    tool: window.KR.drawLayer.tool
  }));
  check('点悬浮工具后侧边栏与画线层同步',
    JSON.stringify(picked.float) === JSON.stringify(['trend']) &&
    JSON.stringify(picked.side) === JSON.stringify(['trend']) && picked.tool === 'trend', JSON.stringify(picked));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  picked = await page.evaluate(() => ({
    float: [...document.querySelectorAll('#floatToolList .ft-btn.active')].map((b) => b.dataset.tool),
    tool: window.KR.drawLayer.tool
  }));
  check('Esc 回光标后悬浮工具栏跟随高亮',
    JSON.stringify(picked.float) === JSON.stringify(['cursor']) && picked.tool === 'cursor', JSON.stringify(picked));

  // ---------- 刷新持久化 ----------
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0 && window.FloatTools, { timeout: 20000 });
  await page.waitForTimeout(500);
  const reloaded = await toolbarInfo();
  check('刷新后保留工具勾选',
    JSON.stringify(reloaded.tools) === JSON.stringify(['cursor', 'trend', 'hline', 'vline', 'rect', 'fib', 'text']),
    JSON.stringify(reloaded.tools));
  check('刷新后保留工具栏位置',
    Math.abs(reloaded.rect.x - dragged.rect.x) <= 2 && Math.abs(reloaded.rect.y - dragged.rect.y) <= 2,
    JSON.stringify({ reloaded: reloaded.rect, before: dragged.rect }));

  // ---------- 显隐与菜单入口 ----------
  await page.click('#btnFloatClose');
  await page.waitForTimeout(100);
  let hidden = await toolbarInfo();
  const menuText = await page.locator('#btnFloatToggle').textContent();
  check('× 隐藏悬浮工具栏并持久化',
    hidden.hidden && hidden.state.hidden && menuText === '显示悬浮工具栏',
    JSON.stringify({ hidden: hidden.hidden, menu: menuText }));

  await page.click('#btnDrawMenu');
  await page.click('#btnFloatToggle');
  await page.waitForTimeout(120);
  hidden = await toolbarInfo();
  check('画线菜单可以重新显示工具栏',
    !hidden.hidden && !hidden.state.hidden &&
    (await page.locator('#btnFloatToggle').textContent()) === '隐藏悬浮工具栏');
  const menuState = await page.evaluate(() => ({
    panelHidden: document.getElementById('drawPanel').hidden,
    on: document.getElementById('btnDrawMenu').classList.contains('on'),
    aria: document.getElementById('btnDrawMenu').getAttribute('aria-expanded')
  }));
  check('菜单项通过画线按钮关闭面板，按钮状态一致',
    menuState.panelHidden && !menuState.on && menuState.aria !== 'true',
    JSON.stringify(menuState));

  await page.click('#btnDrawMenu');
  await page.click('#btnFloatSettingsMenu');
  await page.waitForTimeout(160);
  check('画线菜单可以打开工具设置', !(await panelInfo()).hidden);
  check('设置菜单项同样关闭画线面板', await page.evaluate(() => document.getElementById('drawPanel').hidden));
  await page.keyboard.press('Escape');
  check('Esc 关闭设置面板', (await panelInfo()).hidden);

  // ---------- 全选 / 清空 ----------
  await page.click('#btnFloatSettings');
  await page.click('#btnFloatNone');
  await page.waitForTimeout(120);
  check('清空后只显示“未选工具”入口',
    (await page.locator('#floatToolList .ft-btn').count()) === 0 &&
    (await page.locator('#floatToolList .ft-empty').count()) === 1 &&
    (await page.evaluate(() => window.FloatTools.state.tools.length)) === 0);

  await page.click('#floatToolList .ft-empty');
  check('“未选工具”入口重新打开设置', !(await panelInfo()).hidden);
  await page.click('#btnFloatAll');
  await page.waitForTimeout(120);
  check('全选恢复全部工具', (await page.locator('#floatToolList .ft-btn').count()) === 9);
  await page.click('#btnFloatDone');

  // ---------- localStorage 写入失败 ----------
  await page.evaluate(() => {
    window.__origFloatSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key) {
      if (String(key).indexOf('kline-replay:float-tools') === 0) {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      }
      return window.__origFloatSetItem.apply(this, arguments);
    };
  });
  await page.click('#btnFloatClose');
  await page.waitForTimeout(150);
  const saveFail = await page.evaluate(() => {
    const text = document.getElementById('hint') ? document.getElementById('hint').textContent : '';
    const hidden = document.getElementById('floatTools').hidden;
    Storage.prototype.setItem = window.__origFloatSetItem;
    delete window.__origFloatSetItem;
    return { text, hidden };
  });
  check('存储写入失败时提示无法保存',
    saveFail.hidden && saveFail.text.indexOf('无法保存') >= 0,
    JSON.stringify(saveFail));
  await page.click('#btnDrawMenu');
  await page.click('#btnFloatToggle');
  await page.waitForTimeout(150);
  check('存储恢复后仍可重新显示工具栏', !(await toolbarInfo()).hidden);

  // ---------- 尺寸 / 布局变化 ----------
  await page.setViewportSize({ width: 800, height: 760 });
  await page.waitForTimeout(250);
  await page.click('#btnTradePanel');
  await page.waitForTimeout(350);
  info = await toolbarInfo();
  const gearBox = await page.locator('#btnFloatSettings').boundingBox();
  const closeBox = await page.locator('#btnFloatClose').boundingBox();
  check('窄屏 + 交易面板下工具栏不溢出图表', info.inside,
    JSON.stringify({ rect: info.rect, grid: info.grid }));
  check('窄屏下设置/隐藏按钮仍在图表内可点击',
    !!gearBox && !!closeBox &&
    gearBox.x >= info.grid.x && gearBox.x + gearBox.width <= info.grid.x + info.grid.w &&
    closeBox.x >= info.grid.x && closeBox.x + closeBox.width <= info.grid.x + info.grid.w,
    JSON.stringify({ gear: gearBox, close: closeBox, grid: info.grid }));
  await page.click('#btnTradePanel');
  await page.waitForTimeout(250);

  await page.setViewportSize({ width: 1120, height: 760 });
  await page.waitForTimeout(300);
  info = await toolbarInfo();
  check('窗口缩小后仍在图表内', info.inside, JSON.stringify({ rect: info.rect, grid: info.grid }));
  await page.setViewportSize({ width: 1680, height: 950 });
  await page.waitForTimeout(200);

  await page.click('#layoutSwitch button[data-layout="2"]');
  await page.waitForTimeout(1200);
  info = await toolbarInfo();
  check('切换双窗格后位置仍在图表内',
    info.inside && (await page.evaluate(() => window.KR.state.panes.length)) === 2,
    JSON.stringify({ rect: info.rect, grid: info.grid }));
  await page.screenshot({ path: 'shots/25-float-tools-multi.png' });

  // ---------- 多窗格: 作用于活动窗格 ----------
  const pane2 = await page.locator('.pane[data-index="1"] .chart-wrap').boundingBox();
  await page.mouse.click(pane2.x + 420, pane2.y + 160);
  await page.waitForTimeout(100);
  await page.locator('#floatToolList .ft-btn[data-tool="trend"]').click();
  await page.waitForTimeout(120);
  const paneTools = await page.evaluate(() => ({
    activeIndex: window.KR.state.activeIndex,
    p0: window.KR.state.panes[0].drawLayer.tool,
    p1: window.KR.state.panes[1].drawLayer.tool
  }));
  check('悬浮工具作用于当前活动窗格',
    paneTools.activeIndex === 1 && paneTools.p1 === 'trend' && paneTools.p0 === 'cursor',
    JSON.stringify(paneTools));

  await page.mouse.click(pane2.x + 300, pane2.y + 240);
  await page.mouse.click(pane2.x + 620, pane2.y + 140);
  await page.waitForTimeout(250);
  const drawn = await page.evaluate(() => ({
    count: window.KR.state.panes[1].drawLayer.drawings.length,
    float: [...document.querySelectorAll('#floatToolList .ft-btn.active')].map((b) => b.dataset.tool),
    tool: window.KR.state.panes[1].drawLayer.tool
  }));
  check('用悬浮工具能在活动窗格画出趋势线',
    drawn.count === 1 && drawn.tool === 'cursor' && JSON.stringify(drawn.float) === JSON.stringify(['cursor']),
    JSON.stringify(drawn));

  // ---------- 隐藏状态跨刷新 ----------
  await page.click('#btnFloatClose');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.KR && window.KR.state.bars.length > 0 && window.FloatTools, { timeout: 20000 });
  await page.waitForTimeout(500);
  const hiddenReload = await toolbarInfo();
  check('刷新后仍保持隐藏状态',
    hiddenReload.hidden && hiddenReload.state.hidden &&
    (await page.locator('#btnFloatToggle').textContent()) === '显示悬浮工具栏');

  await page.click('#btnDrawMenu');
  await page.click('#btnFloatSettingsMenu');
  await page.waitForTimeout(160);
  const reopen = await toolbarInfo();
  check('隐藏后从画线菜单设置入口恢复显示',
    !reopen.hidden && !reopen.state.hidden && !(await panelInfo()).hidden,
    JSON.stringify({ hidden: reopen.hidden, state: reopen.state }));
  await page.click('#btnFloatDone');
} catch (e) {
  bad.push('EXCEPTION :: ' + e.message + '\n' + e.stack);
}

console.log('== 悬浮绘图工具栏验证 ==');
console.log('通过 ' + ok.length + '\n' + ok.map((x) => '  ✓ ' + x).join('\n'));
if (bad.length) console.log('失败 ' + bad.length + '\n' + bad.map((x) => '  ✗ ' + x).join('\n'));
if (errors.length) console.log('控制台错误\n' + errors.map((x) => '  ! ' + x).join('\n'));

await browser.close();
process.exitCode = bad.length || errors.length ? 1 : 0;
