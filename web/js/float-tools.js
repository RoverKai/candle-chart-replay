/* 悬浮绘图工具栏 —— 覆盖在 K 线图上的可拖动工具条。
   工具列表从侧边栏 (#toolbar .tool-btn) 读取, 所以画线工具增删时这里自动跟随;
   但只渲染设置里勾选的工具。点悬浮按钮时直接触发侧边栏对应按钮的 click,
   复用 app.js 的 selectTool / 快捷键提示 / 画线层切换, 不复制工具状态。
   工具选择、位置和显隐都存 localStorage, 多窗格时作用于当前活动窗格。 */
(function (global) {
  'use strict';

  var KEY = 'kline-replay:float-tools';
  var MARGIN = 12;          // 工具栏与图表边缘的最小留白
  var $ = function (id) { return document.getElementById(id); };

  var catalog = [];         // [{ id, title, label, svg }]
  var state = null;         // { tools: [...], x: 0..1, y: 0..1, hidden: bool }
  var observer = null;
  var syncScheduled = false;
  var hintTimer = null;

  /* ------------------------------------------------------------ 工具清单 */

  function readCatalog() {
    var out = [];
    var seen = {};
    var btns = document.querySelectorAll('#toolbar .tool-btn[data-tool]');
    for (var i = 0; i < btns.length; i++) {
      var id = btns[i].dataset.tool;
      if (!id || id === 'eraser' || seen[id]) continue;
      seen[id] = 1;
      var title = btns[i].title || id;
      out.push({
        id: id,
        title: title,
        label: title.replace(/\s*\([^)]*\)\s*$/, ''),
        svg: btns[i].innerHTML
      });
    }
    return out;
  }

  function toolOf(id) {
    for (var i = 0; i < catalog.length; i++) {
      if (catalog[i].id === id) return catalog[i];
    }
    return null;
  }

  function allToolIds() {
    return catalog.map(function (t) { return t.id; });
  }

  function clamp01(v) {
    v = Number(v);
    if (!isFinite(v)) return 0;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /* ------------------------------------------------------------ 持久化 */

  function readState() {
    var out = { tools: allToolIds(), x: 1, y: 0, hidden: false };
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { return out; }
    if (!raw) return out;

    var data = null;
    try { data = JSON.parse(raw); } catch (e) { return out; }
    if (!data || typeof data !== 'object') return out;

    if (Array.isArray(data.tools)) {
      // 按工具栏顺序重建, 顺带去掉重复和未知 id
      out.tools = allToolIds().filter(function (id) { return data.tools.indexOf(id) >= 0; });
    }
    if (typeof data.x === 'number') out.x = clamp01(data.x);
    if (typeof data.y === 'number') out.y = clamp01(data.y);
    out.hidden = data.hidden === true;
    return out;
  }

  function saveState() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { }
  }

  /* ------------------------------------------------------------ 位置 */

  /** 位置用 0~1 的比例保存, 窗口缩放 / 切换窗格布局后仍然贴着原来的相对位置 */
  function layoutToolbar() {
    var grid = $('chartGrid');
    var box = $('floatTools');
    if (!grid || !box || !state || box.hidden) return;
    var w = box.offsetWidth;
    var h = box.offsetHeight;
    var maxLeft = Math.max(MARGIN, grid.clientWidth - w - MARGIN);
    var maxTop = Math.max(MARGIN, grid.clientHeight - h - MARGIN);
    var left = MARGIN + state.x * (maxLeft - MARGIN);
    var top = MARGIN + state.y * (maxTop - MARGIN);
    box.style.left = Math.round(left) + 'px';
    box.style.top = Math.round(top) + 'px';
    placePanel();
  }

  /** 设置面板优先放在工具栏右侧, 右边放不下就翻到左侧; 上下不出视口 */
  function placePanel() {
    var panel = $('floatToolSettings');
    var box = $('floatTools');
    if (!panel || panel.hidden || !box) return;
    var b = box.getBoundingClientRect();
    var pw = panel.offsetWidth;
    var ph = panel.offsetHeight;
    var gap = 8;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var left = b.right + gap;
    if (left + pw > vw - 8) left = b.left - pw - gap;
    left = Math.max(8, Math.min(vw - pw - 8, left));
    var top = Math.max(8, Math.min(vh - ph - 8, b.top));
    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(top) + 'px';
  }

  /* ------------------------------------------------------------ 显隐 */

  /** app.js 的 hint 是私有的, 这里用同一个 #hint 元素兜底显示提示 */
  function showHint(msg) {
    var el = $('hint');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(function () {
      el.classList.remove('show');
      hintTimer = null;
    }, 2600);
  }

  function syncMenu() {
    var btn = $('btnFloatToggle');
    if (btn) btn.textContent = state && state.hidden ? '显示悬浮工具栏' : '隐藏悬浮工具栏';
  }

  function setHidden(hidden, silent) {
    if (!state) return;
    hidden = !!hidden;
    var changed = state.hidden !== hidden;
    state.hidden = hidden;
    var box = $('floatTools');
    if (box) box.hidden = hidden;
    if (hidden) closeSettings();
    saveState();
    syncMenu();
    if (!hidden) requestAnimationFrame(layoutToolbar);
    if (changed && !silent) {
      // 提示文案与侧边栏入口对应, 隐藏后仍知道去哪里找回
      var msg = hidden ? '悬浮工具栏已隐藏，可在「画线 ▾」中重新显示' : '悬浮工具栏已显示';
      if (global.KR && global.KR.api && typeof global.KR.api.hint === 'function') global.KR.api.hint(msg);
      else showHint(msg);
    }
  }

  /* ------------------------------------------------------------ 工具栏 */

  function buildToolbar() {
    var list = $('floatToolList');
    if (!list || !state) return;
    list.innerHTML = '';

    var prev = null;
    state.tools.forEach(function (id) {
      var t = toolOf(id);
      if (!t) return;
      if (prev === 'cursor') {
        var sep = document.createElement('div');
        sep.className = 'ft-sep';
        list.appendChild(sep);
      }
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ft-btn';
      b.dataset.tool = id;
      b.title = t.title;
      b.setAttribute('aria-label', t.label);
      b.innerHTML = t.svg;
      b.addEventListener('click', function () { pickTool(id); });
      list.appendChild(b);
      prev = id;
    });

    if (!state.tools.length) {
      var empty = document.createElement('button');
      empty.type = 'button';
      empty.className = 'ft-empty';
      empty.textContent = '＋';
      empty.title = '选择要显示的工具';
      empty.setAttribute('aria-label', '选择要显示的工具');
      empty.addEventListener('click', openSettings);
      list.appendChild(empty);
    }

    syncActive();
    requestAnimationFrame(layoutToolbar);
  }

  /** 悬浮按钮不自己维护工具状态: 触发侧边栏按钮, 由 app.js 统一切换 */
  function pickTool(id) {
    var side = document.querySelector('#toolbar .tool-btn[data-tool="' + id + '"]');
    if (!side) return;
    side.click();
    syncActive();
  }

  /** 侧边栏的 active 类是唯一事实来源: 画完一条线自动回光标、快捷键、Esc 都能同步 */
  function syncActive() {
    var current = '';
    var side = document.querySelector('#toolbar .tool-btn.active[data-tool]');
    if (side) current = side.dataset.tool;
    var list = $('floatToolList');
    if (!list) return;
    var btns = list.querySelectorAll('.ft-btn[data-tool]');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].dataset.tool === current;
      btns[i].classList.toggle('active', on);
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function scheduleSyncActive() {
    if (syncScheduled) return;
    syncScheduled = true;
    requestAnimationFrame(function () {
      syncScheduled = false;
      syncActive();
    });
  }

  /* ------------------------------------------------------------ 设置面板 */

  function buildSettings() {
    var host = $('floatToolOptions');
    if (!host) return;
    host.innerHTML = '';

    catalog.forEach(function (t) {
      var row = document.createElement('label');
      row.className = 'ftp-row';
      row.title = t.title;

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.tool = t.id;
      cb.checked = state.tools.indexOf(t.id) >= 0;
      cb.addEventListener('change', function () { setTool(t.id, cb.checked); });

      var ico = document.createElement('span');
      ico.className = 'ftp-ico';
      ico.innerHTML = t.svg;

      var name = document.createElement('span');
      name.className = 'ftp-name';
      name.textContent = t.label;

      row.appendChild(cb);
      row.appendChild(ico);
      row.appendChild(name);
      host.appendChild(row);
    });
  }

  function syncChecks() {
    var host = $('floatToolOptions');
    if (!host || !state) return;
    var inputs = host.querySelectorAll('input[data-tool]');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].checked = state.tools.indexOf(inputs[i].dataset.tool) >= 0;
    }
  }

  function applyTools(list) {
    state.tools = allToolIds().filter(function (id) { return list.indexOf(id) >= 0; });
    saveState();
    buildToolbar();
    syncChecks();
  }

  function setTool(id, on) {
    if (!state || !toolOf(id)) return;
    var next = state.tools.slice();
    var at = next.indexOf(id);
    if (on && at < 0) next.push(id);
    else if (!on && at >= 0) next.splice(at, 1);
    applyTools(next);
  }

  function openSettings() {
    if (!state) return;
    if (state.hidden) setHidden(false, true);
    var panel = $('floatToolSettings');
    if (!panel) return;
    syncChecks();
    panel.hidden = false;
    var gear = $('btnFloatSettings');
    if (gear) gear.classList.add('on');
    placePanel();
    requestAnimationFrame(placePanel);
  }

  function closeSettings() {
    var panel = $('floatToolSettings');
    if (panel) panel.hidden = true;
    var gear = $('btnFloatSettings');
    if (gear) gear.classList.remove('on');
  }

  /* ------------------------------------------------------------ 拖动 */

  function bindDrag() {
    var grid = $('chartGrid');
    var box = $('floatTools');
    if (!grid || !box) return;

    var drag = null;

    box.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      // 按钮负责自己的点击, 只有左侧把手和空白处可以拖动
      if (e.target.closest('button')) return;
      closeSettings();

      var gr = grid.getBoundingClientRect();
      var br = box.getBoundingClientRect();
      var w = box.offsetWidth;
      var h = box.offsetHeight;
      drag = {
        pointerId: e.pointerId,
        dx: e.clientX - br.left,
        dy: e.clientY - br.top,
        gridLeft: gr.left,
        gridTop: gr.top,
        maxLeft: Math.max(MARGIN, grid.clientWidth - w - MARGIN),
        maxTop: Math.max(MARGIN, grid.clientHeight - h - MARGIN)
      };
      box.classList.add('dragging');
      document.body.classList.add('ft-dragging');
      try { box.setPointerCapture(e.pointerId); } catch (err) { }
      e.preventDefault();
      e.stopPropagation();
    });

    function onMove(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      var left = e.clientX - drag.gridLeft - drag.dx;
      var top = e.clientY - drag.gridTop - drag.dy;
      left = Math.max(MARGIN, Math.min(drag.maxLeft, left));
      top = Math.max(MARGIN, Math.min(drag.maxTop, top));
      box.style.left = Math.round(left) + 'px';
      box.style.top = Math.round(top) + 'px';
    }

    function finish(e) {
      if (!drag) return;
      var left = parseFloat(box.style.left);
      var top = parseFloat(box.style.top);
      var xRange = drag.maxLeft - MARGIN;
      var yRange = drag.maxTop - MARGIN;
      state.x = xRange > 0 ? clamp01((left - MARGIN) / xRange) : 0;
      state.y = yRange > 0 ? clamp01((top - MARGIN) / yRange) : 0;
      saveState();
      drag = null;
      box.classList.remove('dragging');
      document.body.classList.remove('ft-dragging');
      try { box.releasePointerCapture(e.pointerId); } catch (err) { }
    }

    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerup', finish);
    box.addEventListener('pointercancel', finish);
    box.addEventListener('lostpointercapture', finish);
  }

  /* ------------------------------------------------------------ 绑定 */

  function bindSettings() {
    var gear = $('btnFloatSettings');
    if (gear) {
      gear.addEventListener('click', function () {
        if ($('floatToolSettings').hidden) openSettings();
        else closeSettings();
      });
    }

    var hide = $('btnFloatClose');
    if (hide) hide.addEventListener('click', function () { setHidden(true); });

    var close = $('btnFloatSettingsClose');
    if (close) close.addEventListener('click', closeSettings);
    var done = $('btnFloatDone');
    if (done) done.addEventListener('click', closeSettings);

    var all = $('btnFloatAll');
    if (all) all.addEventListener('click', function () { applyTools(allToolIds()); });

    var none = $('btnFloatNone');
    if (none) none.addEventListener('click', function () { applyTools([]); });

    // 画线菜单入口: 设置 / 显示隐藏
    var menuSettings = $('btnFloatSettingsMenu');
    if (menuSettings) {
      menuSettings.addEventListener('click', function (e) {
        e.stopPropagation();
        var dp = $('drawPanel');
        if (dp) dp.hidden = true;
        openSettings();
      });
    }

    var menuToggle = $('btnFloatToggle');
    if (menuToggle) {
      menuToggle.addEventListener('click', function (e) {
        e.stopPropagation();
        var dp = $('drawPanel');
        if (dp) dp.hidden = true;
        setHidden(!state.hidden);
      });
    }

    // Esc 优先关闭设置面板, 不触发画线层回光标; 使用 capture 抢在 app.js 前处理
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var panel = $('floatToolSettings');
      if (!panel || panel.hidden) return;
      e.preventDefault();
      e.stopPropagation();
      closeSettings();
    }, true);

    // 点击面板 / 工具栏之外时收起; 设置菜单按钮本身不触发, 否则会和打开动作打架
    document.addEventListener('mousedown', function (e) {
      var panel = $('floatToolSettings');
      if (!panel || panel.hidden) return;
      if (e.target.closest('#floatToolSettings') ||
          e.target.closest('#floatTools') ||
          e.target.closest('#btnFloatSettingsMenu')) return;
      closeSettings();
    }, true);

    // 打开顶栏其他面板时同步收起
    ['btnChartSettings', 'btnDrawMenu', 'btnTradePanel', 'btnIndicators'].forEach(function (id) {
      var b = $(id);
      if (b) b.addEventListener('click', closeSettings);
    });
  }

  /* ------------------------------------------------------------ 启动 */

  function init() {
    if (state) return;
    catalog = readCatalog();
    if (!catalog.length) return;
    state = readState();

    buildSettings();
    buildToolbar();
    bindSettings();
    bindDrag();
    syncMenu();

    var box = $('floatTools');
    if (!box) return;
    box.hidden = state.hidden;
    if (!state.hidden) requestAnimationFrame(layoutToolbar);

    // 位置跟随窗格布局 / 交易面板 / 窗口尺寸变化; 工具栏自身高度变化也会重新夹取
    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        layoutToolbar();
        placePanel();
      }).observe($('chartGrid'));
    }
    window.addEventListener('resize', function () {
      layoutToolbar();
      placePanel();
    });

    // 侧边栏高亮是唯一事实来源, 用 MutationObserver 跟随 (含画完线自动回光标 / Esc)
    var side = $('toolbar');
    if (side && window.MutationObserver) {
      observer = new MutationObserver(scheduleSyncActive);
      observer.observe(side, { subtree: true, attributes: true, attributeFilter: ['class'] });
    }
  }

  function start() {
    var tries = 0;
    (function wait() {
      if ($('floatTools') && document.querySelector('#toolbar .tool-btn[data-tool]')) {
        init();
        return;
      }
      if (tries++ > 240) return;       // app.js 没启动时安静退出
      setTimeout(wait, 25);
    })();
  }

  global.FloatTools = {
    get state() { return state ? JSON.parse(JSON.stringify(state)) : null; },
    catalog: function () {
      return catalog.map(function (t) { return { id: t.id, label: t.label }; });
    },
    show: function () { setHidden(false); },
    hide: function () { setHidden(true); },
    openSettings: openSettings,
    closeSettings: closeSettings
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(window);
