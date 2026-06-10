import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox','--autoplay-policy=no-user-gesture-required','--use-gl=angle','--use-angle=swiftshader','--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:4978/');
await page.waitForTimeout(1200);
await page.click('#demoBtn');
await page.waitForSelector('#landing.hidden', { timeout: 20000 });

// Luminous Hall during the melody and crescendo
await page.waitForTimeout(9000);
await page.screenshot({ path: '/tmp/m1-hall-melody.png' });
await page.waitForTimeout(5000);

// Ink and Current through the crescendo
await page.selectOption('#modeSelect', 'ink-and-current');
await page.waitForTimeout(12000);
await page.screenshot({ path: '/tmp/m2-ink-crescendo.png' });

// Celestial through the climax
await page.selectOption('#modeSelect', 'celestial-mechanics');
await page.waitForTimeout(9000);
await page.screenshot({ path: '/tmp/m4-celestial-climax.png' });

// Garden: restart demo so it grows from the beginning
await page.selectOption('#modeSelect', 'growing-garden');
await page.evaluate(() => { /* seek to start via space-less restart */ });
await page.waitForTimeout(11000); // coda + silence growth check
await page.screenshot({ path: '/tmp/m3-garden-partial.png' });

console.log('errors:', errors.length ? errors.join('\n') : 'none');
await browser.close();
