import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: [
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--use-gl=angle', '--use-angle=gl-egl', // hardware GPU in headless
    '--mute-audio',
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: '/tmp/voyrec', size: { width: 1280, height: 720 } },
});
const page = await ctx.newPage();
await page.goto('http://localhost:4978/');
await page.waitForTimeout(1500);
await page.click('button[data-url="audio/vivaldi-spring-1.mp3"]');
await page.waitForSelector('#landing.hidden', { timeout: 30000 });
await page.mouse.move(1270, 710); // park: let UI and pointer light fade

// wait until the transport clock reads 0:04, then anchor the NEXT flip (0:05)
await page.waitForFunction(() => document.getElementById('timeNow').textContent === '0:04');
const anchored = await page.evaluate(
  () =>
    new Promise((res) => {
      const el = document.getElementById('timeNow');
      const before = el.textContent;
      const tick = () => {
        if (el.textContent !== before) {
          // flash a small white anchor square for ~90ms
          const d = document.createElement('div');
          d.style.cssText =
            'position:fixed;left:4px;bottom:4px;width:48px;height:48px;background:#fff;z-index:99999';
          document.body.appendChild(d);
          setTimeout(() => d.remove(), 90);
          res(el.textContent);
        } else requestAnimationFrame(tick);
      };
      tick();
    }),
);
console.log('anchor at audio time:', anchored); // "0:05" => 5s

// 5s..15s: pure flight through the opening tutti
await page.waitForTimeout(10000);

// 15s: a slow lantern sweep — ribbons lean after the light
for (let i = 0; i <= 40; i++) {
  const t = i / 40;
  await page.mouse.move(180 + t * 920, 380 - Math.sin(t * Math.PI) * 200);
  await page.waitForTimeout(45);
}
await page.waitForTimeout(1200);

// ~20s: two supernovae
await page.mouse.click(840, 280);
await page.waitForTimeout(1800);
await page.mouse.click(420, 330);
await page.waitForTimeout(800);

// park again and fly hands-off to the end
await page.mouse.move(1270, 710);
await page.waitForTimeout(12500);

await ctx.close(); // flushes the video
const video = await page.video().path();
console.log('webm:', video);
await browser.close();
