import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
page.on('pageerror', (e) => console.log('PAGEERR:', e.message));

await page.goto('http://127.0.0.1:8766/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.KR && window.KR.state.panes[0].bars.length > 0, { timeout: 20000 });
await page.waitForTimeout(800);

const out = await page.evaluate(() => {
  const KR = window.KR;
  const p = KR.state.panes[0];
  const pane = KR.api.pane(0);
  const ts = pane.chart.timeScale();
  const res = {};

  // 退回 300 根，制造"未来"数据
  KR.api.setCursor(p.cursor - 300);
  const cur = pane.cursor;
  const curTime = pane.bars[cur].time;
  const futureIdx = cur + 200;
  const futureTime = pane.bars[futureIdx].time;

  res.cursor = cur;
  res.dataLen = pane.bars.length;

  // 1. 未来时间点 timeToCoordinate
  res.timeToCoord_future = ts.timeToCoordinate(futureTime);
  // 2. 未来逻辑索引 logicalToCoordinate
  res.logicalToCoord_future = ts.logicalToCoordinate(futureIdx);
  // 3. 当前最后一根
  res.timeToCoord_cur = ts.timeToCoordinate(curTime);
  res.logicalToCoord_cur = ts.logicalToCoordinate(cur);
  // 4. 可见区间
  const r = ts.getVisibleLogicalRange();
  res.visibleRange = r ? [Math.round(r.from), Math.round(r.to)] : null;
  res.barSpacing = ts.options().barSpacing;
  // 5. 远端
  res.logicalToCoord_far = ts.logicalToCoordinate(pane.bars.length - 1);
  return res;
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
