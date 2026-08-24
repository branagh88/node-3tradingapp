import { chromium } from '/tmp/node_modules/playwright-core/index.mjs';
const exe = process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';
const browser = await chromium.launch({ executablePath: exe, headless: true });
const ctx = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
const page = await ctx.newPage();
page.on('console', m => console.log('[c]', m.text()));
await page.goto('http://localhost:3199/index.html', { waitUntil: 'load' });
await page.waitForTimeout(800);
// Calibrate fixed positioning using existing fixed elements (no state change)
const calib = await page.evaluate(() => {
  const nav = document.getElementById('bottomnav');
  const toast = document.querySelector('.toast-root');
  const r = nav.getBoundingClientRect();
  return { navRect: {y:r.y, h:r.height}, navBottomCS: getComputedStyle(nav).bottom,
           toastY: toast ? toast.getBoundingClientRect().y : null, innerH: innerHeight, docH: document.documentElement.clientHeight };
});
console.log('CALIB', JSON.stringify(calib));
await browser.close();
