// Captures README media from the built app in headless Chromium:
//   node tools/capture.mjs gif <preset> <out.gif> [maxIterations] [stride]
//   node tools/capture.mjs png <preset> <out.png> [waitMs]
// Requires `npm run build` first. Uses software GL, so it is slow; on a real
// GPU the same optimization runs in seconds.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc;
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '../e2e/server.mjs';

const [mode, preset, out, arg4, arg5] = process.argv.slice(2);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const { server, port } = await serve(root);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('page error:', e));
await page.goto(`http://127.0.0.1:${port}/?preset=${preset.replace('?', '&')}`);
await page.waitForFunction(() => !!window.etchlight?.app);

const grab = async () => {
  const dataUrl = await page.evaluate(() => {
    const app = window.etchlight.app;
    const gl = document.querySelector('.stage canvas:not(.overlay)');
    const ov = document.querySelector('.stage canvas.overlay');
    const c = document.createElement('canvas');
    c.width = gl.width; c.height = gl.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(gl, 0, 0);
    ctx.drawImage(ov, 0, 0, c.width, c.height);
    // Caption with iteration count and objective.
    const o = app.optimizer;
    if (o) {
      const J0 = o.history[0] || 1, J = o.history[o.history.length - 1] ?? J0;
      ctx.font = 'bold 16px sans-serif'; ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(8, 8, 300, 26);
      ctx.fillStyle = '#fff';
      ctx.fillText(`iteration ${o.iteration}   J/J0 = ${(J / J0).toFixed(2)}`, 14, 27);
    }
    return c.toDataURL('image/png');
  });
  return PNG.sync.read(Buffer.from(dataUrl.split(',')[1], 'base64'));
};

if (mode === 'png') {
  await page.waitForTimeout(+(arg4 ?? 4000));
  const png = await grab();
  writeFileSync(out, PNG.sync.write(png));
  console.log('saved', out, png.width, 'x', png.height);
} else {
  const maxIter = +(arg4 ?? 40), stride = +(arg5 ?? 1);
  await page.evaluate((n) => { window.etchlight.app.maxIterations = n; }, maxIter);
  const frames = [];
  let last = -1;
  // First frame: the blank design region with the field, before any iteration.
  await page.waitForTimeout(1500);
  frames.push(await grab());
  while (true) {
    const it = await page.evaluate(() => window.etchlight.app.optimizer?.iteration ?? 0);
    const running = await page.evaluate(() => window.etchlight.app.optimizing);
    if (it !== last && it % stride === 0) { last = it; await page.waitForTimeout(400); frames.push(await grab()); console.log('frame at iteration', it); }
    if (!running && it >= 1) break;
    await page.waitForTimeout(500);
  }
  // Hold the final frame.
  for (let i = 0; i < 6; i++) frames.push(frames[frames.length - 1]);
  const { width, height } = frames[0];
  const scale = 2; // downscale to keep the GIF small
  const w = Math.floor(width / scale), h = Math.floor(height / scale);
  const gif = GIFEncoder();
  for (const f of frames) {
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const si = ((y * scale) * width + x * scale) * 4, di = (y * w + x) * 4;
      rgba[di] = f.data[si]; rgba[di + 1] = f.data[si + 1]; rgba[di + 2] = f.data[si + 2]; rgba[di + 3] = 255;
    }
    const palette = quantize(rgba, 256);
    const index = applyPalette(rgba, palette);
    gif.writeFrame(index, w, h, { palette, delay: 160 });
  }
  gif.finish();
  writeFileSync(out, gif.bytes());
  console.log('saved', out, frames.length, 'frames', w, 'x', h);
}
await browser.close(); server.close();
