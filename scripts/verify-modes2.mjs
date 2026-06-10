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

// Ink through melody + crescendo
await page.click('#demoBtn');
await page.waitForSelector('#landing.hidden', { timeout: 20000 });
await page.selectOption('#modeSelect', 'ink-and-current');
await page.waitForTimeout(12000);
await page.screenshot({ path: '/tmp/m2b-ink-melody.png' });
await page.waitForTimeout(20000);
await page.screenshot({ path: '/tmp/m2b-ink-climax.png' });

// Garden grown from the start of the piece
await page.reload();
await page.waitForTimeout(1000);
await page.click('#demoBtn');
await page.waitForSelector('#landing.hidden', { timeout: 20000 });
await page.selectOption('#modeSelect', 'growing-garden');
await page.waitForTimeout(36000);
await page.screenshot({ path: '/tmp/m3b-garden-grown.png' });

console.log('errors:', errors.length ? errors.join('\n') : 'none');
await browser.close();
