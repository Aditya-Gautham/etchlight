// End-to-end checks that need a real browser:
//   1. GPU/CPU parity: both engines integrate the same scene; fields must agree.
//   2. GPU optimizer smoke test: one adjoint iteration on the GPU engine.
// Usage: npm run build && node e2e/run.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from './server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const { server, port } = await serve(root);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', (e) => { console.error('page error:', e); process.exitCode = 1; });
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => !!window.etchlight);

const parity = await page.evaluate(async () => {
  const T = window.etchlight;
  const s = T.createScene({ nx: 160, ny: 120, pml: 12, waveform: { kind: 'pulse', lambda: 24, widthPeriods: 1 }, monitorLambdas: [20, 24, 30] });
  T.fillDisk(s, 90, 60, 22, 6);
  T.fillRect(s, 30, 20, 40, 100, 2.5);
  T.fillDisk(s, 130, 30, 7, 1, 8);
  T.addSource(s, { kind: 'point', x: 50, y: 60, amp: 1, phase: 0 });
  T.addSource(s, { kind: 'line', x: 20, y: 30, x2: 20, y2: 90, amp: 0.5, phase: 1 });
  T.addMonitor(s, { name: 'a', x: 120, y: 70 });
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  const cpu = new T.CpuFdtd(s, { fullDft: true });
  const gpu = new T.GlFdtd(gl, s, { fullDft: true });
  // Run in chunks so the normalization uses the peak field over the whole
  // run, not the (tiny) residual left after the pulse has been absorbed.
  const steps = 600, chunk = 50;
  let tCpu = 0, tGpu = 0, maxVal = 0;
  for (let done = 0; done < steps; done += chunk) {
    const t0 = performance.now(); cpu.run(chunk); tCpu += performance.now() - t0;
    // readFields forces the GPU queue to drain, so the GPU time is real.
    const t1 = performance.now(); await gpu.run(chunk); gpu.readFields(); tGpu += performance.now() - t1;
    maxVal = Math.max(maxVal, cpu.maxAbsEz());
  }
  const f = gpu.readFields();
  let maxDiff = 0;
  for (let k = 0; k < f.ezx.length; k++) {
    const a = cpu.ezx[k] + cpu.ezy[k], b = f.ezx[k] + f.ezy[k];
    maxDiff = Math.max(maxDiff, Math.abs(a - b), Math.abs(cpu.hx[k] - f.hx[k]), Math.abs(cpu.hy[k] - f.hy[k]));
  }
  const dc = cpu.readFullDft(), dg = gpu.readFullDft();
  let dftDiff = 0, dftMax = 0;
  for (let k = 0; k < dc.re.length; k++) {
    dftDiff = Math.max(dftDiff, Math.abs(dc.re[k] - dg.re[k]), Math.abs(dc.im[k] - dg.im[k]));
    dftMax = Math.max(dftMax, Math.hypot(dc.re[k], dc.im[k]));
  }
  const mg = gpu.readMonitors();
  let monDiff = 0, monMax = 0;
  for (let fq = 0; fq < 3; fq++) {
    monDiff = Math.max(monDiff, Math.abs(cpu.monRe[0][fq] - mg.re[0][fq]), Math.abs(cpu.monIm[0][fq] - mg.im[0][fq]));
    monMax = Math.max(monMax, Math.hypot(cpu.monRe[0][fq], cpu.monIm[0][fq]));
  }
  gpu.dispose();
  return { steps, maxDiff, maxVal, rel: maxDiff / maxVal, dftRel: dftDiff / dftMax, monRel: monDiff / monMax, tCpu, tGpu, renderer: gl.getParameter(gl.RENDERER) };
});
console.log('[e2e] GPU/CPU parity after', parity.steps, 'steps on', parity.renderer);
console.log(`[e2e]   max |field diff| / peak |Ez| = ${parity.rel.toExponential(2)}`);
console.log(`[e2e]   whole-grid DFT rel. diff   = ${parity.dftRel.toExponential(2)}`);
console.log(`[e2e]   monitor DFT rel. diff      = ${parity.monRel.toExponential(2)}`);
console.log(`[e2e]   CPU ${parity.tCpu.toFixed(0)} ms, GPU ${parity.tGpu.toFixed(0)} ms (software GL in CI; real GPUs are far faster)`);
const ok1 = parity.rel < 1e-5 && parity.dftRel < 1e-5 && parity.monRel < 1e-5;
if (!ok1) { console.error('[e2e] FAIL: parity tolerance exceeded'); process.exitCode = 1; }

const opt = await page.evaluate(async () => {
  const T = window.etchlight;
  const s = T.presets.find((p) => p.id === 'inverse-lens').build();
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  const settings = { ...T.defaultOptimizerSettings, solve: { ...T.defaultOptimizerSettings.solve, lambda: 24, settlePeriods: 14, dftPeriods: 3 } };
  const o = new T.Optimizer(s, settings, T.glEngine(gl));
  const t0 = performance.now();
  const a = await o.step();
  const b = await o.step();
  const c = await o.step();
  return { J: [a.objective, b.objective, c.objective], ms: performance.now() - t0 };
});
console.log(`[e2e] GPU optimizer, 3 iterations on the focus preset: J = ${opt.J.map((v) => v.toExponential(3)).join(' -> ')} in ${opt.ms.toFixed(0)} ms`);
if (!(opt.J[2] > opt.J[0])) { console.error('[e2e] FAIL: objective did not improve'); process.exitCode = 1; }

await browser.close();
server.close();
console.log(process.exitCode ? '[e2e] FAILED' : '[e2e] all checks passed');
