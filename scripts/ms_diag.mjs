import { chromium } from '/tmp/node_modules/playwright-core/index.mjs';

const exe = process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';
const browser = await chromium.launch({ executablePath: exe, headless: true });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
});
const page = await ctx.newPage();
page.on('console', (m) => console.log('[console.' + m.type() + ']', m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://localhost:3199/index.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

async function tapTest(triggerSel, popSel) {
  console.log('\n===== TAP TEST', triggerSel, '=====');
  // Show the asset screen (in real usage user reaches it by picking an asset)
  await page.evaluate(() => { document.getElementById('screen-asset').hidden = false; });
  await page.$eval(triggerSel, (el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  const info = await page.$eval(triggerSel, (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      computed: { pointerEvents: cs.pointerEvents, position: cs.position, zIndex: cs.zIndex, visibility: cs.visibility, opacity: cs.opacity, display: cs.display, touchAction: cs.touchAction },
    };
  });
  console.log('[pre-tap]', JSON.stringify(info));
  const cx = info.rect.x + info.rect.w / 2, cy = info.rect.y + info.rect.h / 2;
  const atPoint = await page.evaluate(([x, y]) =>
    document.elementsFromPoint(x, y).slice(0, 6).map((el) =>
      el.id ? `${el.tagName}#${el.id}` : `${el.tagName}.${(el.className || '').toString().split(' ')[0]}`), [cx, cy]);
  console.log(`[pre-tap] elementsFromPoint(${cx},${cy}):`, atPoint);

  await page.touchscreen.tap(cx, cy);
  await page.waitForTimeout(600);
  const state = await page.$eval(popSel, (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { hiddenAttr: el.hidden, display: cs.display, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, childCount: el.childElementCount };
  });
  const onScreen = state.display !== 'none' && state.rect.y >= 0 && state.rect.y + state.rect.h <= 844 && state.rect.w > 0;
  console.log('[post-tap popover]', JSON.stringify(state), 'onScreen=', onScreen);
  await page.screenshot({ path: `/tmp/ms_${popSel.replace(/[^a-z]/g, '')}.png` });
  await page.touchscreen.tap(cx, cy);
  await page.waitForTimeout(400);
  console.log('[post-2nd-tap] hidden =', await page.$eval(popSel, (el) => el.hidden));
}

console.log('\n===== CONTROL .btn #hist-analysis-btn =====');
await page.evaluate(() => { document.getElementById('screen-asset').hidden = false; });
await page.$eval('#hist-analysis-btn', (el) => el.scrollIntoView({ block: 'center' }));
await page.waitForTimeout(200);
const binfo = await page.$eval('#hist-analysis-btn', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await page.touchscreen.tap(binfo.x + binfo.w / 2, binfo.y + binfo.h / 2);
await page.waitForTimeout(400);
console.log('[control post-tap] hist-panel hidden =', await page.$eval('#hist-panel', (el) => el.hidden));

await tapTest('#rv-ms-trigger', '#rv-ms-popover');
await tapTest('#hd-ms-trigger', '#hd-ms-popover');

await browser.close();
console.log('\nDONE');
