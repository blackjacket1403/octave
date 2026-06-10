import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox','--autoplay-policy=no-user-gesture-required','--use-gl=angle','--use-angle=swiftshader','--mute-audio'],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:4978/');
await page.waitForTimeout(1800);
await page.screenshot({ path: '/tmp/mob-landing.png' });
await page.tap('#demoBtn');
await page.waitForSelector('#landing.hidden', { timeout: 20000 });
await page.waitForTimeout(9000);
await page.screenshot({ path: '/tmp/mob-playing.png' });
// landscape phone
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(2500);
await page.screenshot({ path: '/tmp/mob-landscape.png' });
console.log('errors:', errors.length ? errors.join('\n') : 'none');
await browser.close();
