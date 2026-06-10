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

// library: open from landing, search the archive
await page.click('#libBtnLanding');
await page.waitForTimeout(400);
await page.fill('#libInput', 'Beethoven symphony 5');
await page.press('#libInput', 'Enter');
await page.waitForTimeout(5000);
await page.screenshot({ path: '/tmp/lib-search.png' });
const items = await page.locator('.lib-item').count();
console.log('archive results:', items);
await page.click('#libClose');

// default mode is Voyage; tap interaction during playback
await page.click('#demoBtn');
await page.waitForSelector('#landing.hidden', { timeout: 20000 });
const modeVal = await page.inputValue('#modeSelect');
console.log('default mode:', modeVal);
await page.waitForTimeout(8000);
await page.mouse.move(500, 300);
await page.waitForTimeout(1200);
await page.mouse.click(640, 300);
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/voy-nova.png' });

// library opens from transport during playback
await page.mouse.move(640, 650);
await page.click('#libBtn');
await page.waitForTimeout(400);
const libOpen = await page.locator('#library.open').count();
console.log('library opens during playback:', libOpen === 1);

console.log('errors:', errors.length ? errors.join('\n') : 'none');
await browser.close();
