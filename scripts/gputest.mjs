import { chromium } from 'playwright-core';
for (const args of [
  ['--no-sandbox','--autoplay-policy=no-user-gesture-required','--mute-audio'], // default ANGLE (may hit GPU)
  ['--no-sandbox','--autoplay-policy=no-user-gesture-required','--mute-audio','--use-gl=angle','--use-angle=gl-egl'],
]) {
  try {
    const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args });
    const p = await b.newPage();
    await p.goto('http://localhost:4978/');
    const info = await p.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    });
    console.log(JSON.stringify(args.slice(3)), '->', info);
    await b.close();
  } catch (e) { console.log('failed:', String(e).slice(0,100)); }
}
