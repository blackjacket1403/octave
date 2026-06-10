import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox','--autoplay-policy=no-user-gesture-required','--use-gl=angle','--use-angle=swiftshader','--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:4978/');
await page.waitForTimeout(1200);
await page.click('#demoBtn');
await page.waitForSelector('#landing.hidden', { timeout: 20000 });
await page.waitForTimeout(8000);
// sweep the cursor in an arc so the comet tail shows
for (let i = 0; i <= 24; i++) {
  const t = i / 24;
  await page.mouse.move(300 + t * 600, 360 - Math.sin(t * Math.PI) * 180);
  await page.waitForTimeout(28);
}
await page.screenshot({ path: '/tmp/glow.png' });
console.log('errors:', errors.length ? errors.join('\n') : 'none');
await browser.close();
