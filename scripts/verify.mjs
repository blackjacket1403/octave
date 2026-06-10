// Dev verification: drives system Chrome through the demo piece and captures
// screenshots at musically meaningful moments. Not part of the app build.
import { chromium } from 'playwright-core';

const URL = process.env.APP_URL ?? 'http://localhost:4978/';
const shots = [
  { t: 8, name: 'melody-left' }, // call phrase, hard left, salient soprano
  { t: 13, name: 'melody-right' }, // response phrase, hard right
  { t: 31, name: 'crescendo' }, // full climb, dense texture
  { t: 35, name: 'climax' }, // tutti + timpani
  { t: 44, name: 'coda' }, // dying away
];

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: [
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--mute-audio',
  ],
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(URL);
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/shot-dormant.png' });
await page.click('#demoBtn');
await page.waitForSelector('#landing.hidden', { timeout: 20000 });

let last = 0;
for (const s of shots) {
  await page.waitForTimeout((s.t - last) * 1000);
  last = s.t;
  await page.screenshot({ path: `/tmp/shot-${s.name}.png` });
  console.log(`captured ${s.name} @ ~${s.t}s`);
}

// dev overlay sanity: band/salience numbers at coda
await page.keyboard.press('d');
await page.waitForTimeout(400);
const dev = await page.textContent('#devOverlay');
console.log('--- dev overlay ---\n' + dev);
console.log('--- page errors ---\n' + (errors.length ? errors.join('\n') : 'none'));
await browser.close();
