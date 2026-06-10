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
await page.click('button[data-url="audio/vivaldi-spring-1.mp3"]');
await page.waitForSelector('#landing.hidden', { timeout: 30000 });
await page.waitForTimeout(12000);
await page.screenshot({ path: '/tmp/vivaldi-tutti.png' });   // opening tutti
await page.waitForTimeout(20000);
await page.screenshot({ path: '/tmp/vivaldi-solo.png' });    // birdsong solo section
console.log('errors:', errors.length ? errors.join('\n') : 'none');
await browser.close();
