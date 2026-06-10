import { chromium } from 'playwright-core';
import fs from 'node:fs';

const DIR = '/tmp/voyframes1080';
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox','--autoplay-policy=no-user-gesture-required','--use-gl=angle','--use-angle=gl-egl','--mute-audio'],
});
// 1280x720 CSS at 1.5x device scale = true 1920x1080 pixels, same composition
const page = await browser.newPage({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 2,
});
await page.goto('http://localhost:4978/');
await page.waitForTimeout(1500);
await page.addStyleTag({ content: '#transport,#toast{display:none!important}' });
await page.click('button[data-url="audio/vivaldi-spring-1.mp3"]');
await page.waitForSelector('#landing.hidden', { timeout: 30000 });
await page.mouse.move(1900, 1060);

await page.waitForFunction(() => document.querySelector('#timeNow').textContent === '0:02');
const wallFlip = await page.evaluate(
  () =>
    new Promise((res) => {
      const el = document.getElementById('timeNow');
      const before = el.textContent;
      const tick = () =>
        el.textContent !== before ? res(Date.now() / 1000) : requestAnimationFrame(tick);
      tick();
    }),
);

await page.waitForTimeout(800);
const cdp = await page.context().newCDPSession(page);
const meta = [];
let idx = 0;
cdp.on('Page.screencastFrame', (ev) => {
  const n = idx++;
  fs.writeFile(`${DIR}/f${String(n).padStart(4, '0')}.jpg`, Buffer.from(ev.data, 'base64'), () => {});
  meta.push({ n, ts: ev.metadata.timestamp });
  cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });

await page.waitForTimeout(4500);
for (let i = 0; i <= 36; i++) {
  const t = i / 36;
  await page.mouse.move(330 + t * 1290, 600 - Math.sin(t * Math.PI) * 315);
  await page.waitForTimeout(40);
}
await page.waitForTimeout(900);
await page.mouse.click(1170, 450);
await page.waitForTimeout(300);
await page.mouse.move(1900, 1060);
await page.waitForTimeout(8000);

await cdp.send('Page.stopScreencast');
await page.waitForTimeout(600);
fs.writeFileSync(`${DIR}/meta.json`, JSON.stringify({ wallFlip, audioAtFlip: 3.0, frames: meta }));
const dts = meta.slice(1).map((m, i) => m.ts - meta[i].ts);
dts.sort((a, b) => a - b);
console.log('frames:', meta.length, 'median fps:', (1 / dts[Math.floor(dts.length / 2)]).toFixed(1),
  'span:', (meta[meta.length - 1].ts - meta[0].ts).toFixed(1) + 's');
const dim = await page.evaluate(() => [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio]);
console.log('device px:', dim.join('x'));
await browser.close();
