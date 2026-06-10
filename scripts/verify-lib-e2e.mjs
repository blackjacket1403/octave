import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox','--autoplay-policy=no-user-gesture-required','--use-gl=angle','--use-angle=swiftshader','--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:4978/');
await page.waitForTimeout(1000);
await page.click('#libBtnLanding');
await page.fill('#libInput', 'Beethoven symphony 5');
await page.press('#libInput', 'Enter');
await page.waitForSelector('.lib-item', { timeout: 15000 });
// pick "Symphony No. 5, Op. 67" style item (skip the FLAC collection)
const items = page.locator('.lib-item');
const n = await items.count();
let clicked = false;
for (let i = 0; i < n; i++) {
  const t = await items.nth(i).locator('.lib-title').textContent();
  if (/symphony no\.? 5/i.test(t ?? '') && !/flac/i.test(t ?? '')) {
    await items.nth(i).click(); clicked = true; break;
  }
}
if (!clicked) await items.nth(1).click();
await page.waitForSelector('.lib-track', { timeout: 20000 });
const trackName = await page.locator('.lib-track').first().textContent();
console.log('first track:', trackName);
await page.locator('.lib-track').first().click();
// wait for decode + playback (file may be 10MB+)
await page.waitForSelector('#landing.hidden', { timeout: 90000 });
await page.waitForTimeout(15000);
const time = await page.textContent('#timeNow');
const title = await page.textContent('#trackName');
console.log('playing:', title, '@', time);
await page.screenshot({ path: '/tmp/lib-playing.png' });
console.log('errors:', errors.length ? errors.join('\n') : 'none');
await browser.close();
