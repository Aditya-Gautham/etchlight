/**
 * Physics validation of the CPU reference solver against analytic results.
 * Each test prints the measured number so `npm run validate` doubles as a
 * report generator for docs/validation.md.
 */
import { describe, it, expect } from 'vitest';
import { createScene, fillRect, fillDisk, addSource, addMonitor } from '../src/core/scene';
import { CpuFdtd } from '../src/core/fdtd';
import { idx } from '../src/core/types';

function peakIn(series: number[], times: number[], t0: number, t1: number): number {
  let m = 0;
  for (let i = 0; i < series.length; i++) if (times[i] >= t0 && times[i] <= t1) m = Math.max(m, Math.abs(series[i]));
  return m;
}

function peakTime(series: number[], times: number[], t0: number, t1: number): number {
  let m = 0, tm = t0;
  for (let i = 0; i < series.length; i++) if (times[i] >= t0 && times[i] <= t1 && Math.abs(series[i]) > m) { m = Math.abs(series[i]); tm = times[i]; }
  return tm;
}

describe('wave propagation in vacuum', () => {
  it('phase velocity is c to within 1% at 20 cells per wavelength', () => {
    const s = createScene({ nx: 240, ny: 240, pml: 16, waveform: { kind: 'pulse', lambda: 20, widthPeriods: 1 } });
    const cx = 60, cy = 120;
    addSource(s, { kind: 'point', x: cx, y: cy, amp: 1, phase: 0 });
    const d1 = 40, d2 = 120;
    const f = new CpuFdtd(s);
    const a: number[] = [], b: number[] = [], t: number[] = [];
    for (let n = 0; n < 700; n++) {
      f.advance();
      t.push(f.time);
      a.push(f.ez(idx(s.nx, cx + d1, cy)));
      b.push(f.ez(idx(s.nx, cx + d2, cy)));
    }
    // Arrival of the pulse centre at each monitor (cylindrical spreading does
    // not shift the peak time).
    const t1 = peakTime(a, t, 0, 350), t2 = peakTime(b, t, 0, 350);
    const v = (d2 - d1) / (t2 - t1);
    console.log(`[validation] vacuum phase velocity = ${v.toFixed(4)} c`);
    expect(Math.abs(v - 1)).toBeLessThan(0.01);
  });

  it('field stays bounded below the Courant limit and diverges above it', () => {
    const mk = (dt: number) => {
      const s = createScene({ nx: 60, ny: 60, pml: 8, dt, waveform: { kind: 'pulse', lambda: 20, widthPeriods: 1 } });
      fillDisk(s, 30, 30, 8, 12);
      addSource(s, { kind: 'point', x: 20, y: 20, amp: 1, phase: 0 });
      const f = new CpuFdtd(s);
      f.run(1500);
      return f.maxAbsEz();
    };
    const stable = mk(0.7);   // 0.7 < 1/sqrt(2) = 0.7071
    const unstable = mk(0.72);
    console.log(`[validation] max|Ez| at dt=0.70: ${stable.toExponential(2)}, at dt=0.72: ${unstable.toExponential(2)}`);
    expect(stable).toBeLessThan(10);
    expect(unstable > 1e3 || !Number.isFinite(unstable)).toBe(true);
  });
});

describe('dielectric interface (Fresnel, normal incidence)', () => {
  it('reflection and transmission amplitudes match (n1-n2)/(n1+n2) and 2n1/(n1+n2)', () => {
    // A tall line source approximates a plane wave near the centre row for
    // as long as the diffraction from the line ends has not arrived. The
    // wavelength is 40 cells in vacuum so that it is still 20 cells inside
    // the n=2 medium, keeping numerical dispersion below 1%.
    const nx = 300, ny = 800, pml = 16;
    const s = createScene({ nx, ny, pml, waveform: { kind: 'pulse', lambda: 40, widthPeriods: 0.75 } });
    const n2 = 2;
    fillRect(s, 200, 0, nx - 1, ny - 1, n2 * n2);
    addSource(s, { kind: 'line', x: 40, y: pml, x2: 40, y2: ny - 1 - pml, amp: 1, phase: 0 });
    const f = new CpuFdtd(s);
    const mid = ny >> 1;
    const refl: number[] = [], trans: number[] = [], t: number[] = [];
    for (let n = 0; n < 820; n++) {
      f.advance();
      t.push(f.time);
      refl.push(f.ez(idx(nx, 120, mid)));
      trans.push(f.ez(idx(nx, 240, mid)));
    }
    // Pulse centre leaves the source at t=90. Incident passes x=120 at t=170,
    // the reflection returns there at t=330, the transmitted pulse reaches
    // x=240 (40 cells into the n=2 medium) at t=330 as well.
    const inc = peakIn(refl, t, 95, 245);
    const ref = peakIn(refl, t, 255, 405);
    const tr = peakIn(trans, t, 255, 405);
    const rMeas = ref / inc, tMeas = tr / inc;
    const rTheory = Math.abs((1 - n2) / (1 + n2)), tTheory = 2 / (1 + n2);
    console.log(`[validation] Fresnel n=${n2}: |r| = ${rMeas.toFixed(4)} (theory ${rTheory.toFixed(4)}), |t| = ${tMeas.toFixed(4)} (theory ${tTheory.toFixed(4)})`);
    expect(Math.abs(rMeas - rTheory)).toBeLessThan(0.01);
    expect(Math.abs(tMeas - tTheory)).toBeLessThan(0.01);
    // Energy conservation across the interface: R + (n2/n1) T^2 = 1.
    const energy = rMeas * rMeas + n2 * tMeas * tMeas;
    console.log(`[validation] Fresnel energy balance R + n2*T^2 = ${energy.toFixed(4)}`);
    expect(Math.abs(energy - 1)).toBeLessThan(0.02);
  });
});

describe('perfectly matched layer', () => {
  it('reflects less than -50 dB of a normally incident pulse', () => {
    const nx = 400, ny = 600, pml = 16;
    const s = createScene({ nx, ny, pml, waveform: { kind: 'pulse', lambda: 20, widthPeriods: 1 } });
    addSource(s, { kind: 'line', x: 100, y: pml, x2: 100, y2: ny - 1 - pml, amp: 1, phase: 0 });
    const f = new CpuFdtd(s);
    const mid = ny >> 1;
    const m: number[] = [], t: number[] = [];
    for (let n = 0; n < 560; n++) {
      f.advance();
      t.push(f.time);
      m.push(f.ez(idx(nx, 50, mid)));
    }
    // Incident passes x=50 at t~110; the echo from the left PML returns at t~178.
    const inc = peakIn(m, t, 60, 150);
    const echo = peakIn(m, t, 160, 260);
    const dB = 20 * Math.log10(echo / inc);
    console.log(`[validation] PML (${pml} cells, order 3) normal-incidence reflection = ${dB.toFixed(1)} dB (|r| = ${(echo / inc).toExponential(2)})`);
    expect(dB).toBeLessThan(-50);
  });
});

describe('reciprocity', () => {
  it('phasor at B due to a current at A equals the phasor at A due to the same current at B', () => {
    const build = (sx: number, sy: number, mx: number, my: number) => {
      const s = createScene({ nx: 160, ny: 120, pml: 12, waveform: { kind: 'pulse', lambda: 30, widthPeriods: 1.5 }, monitorLambdas: [26, 30, 36] });
      fillDisk(s, 80, 60, 18, 6);
      fillRect(s, 40, 20, 50, 100, 2.5);
      fillDisk(s, 120, 40, 6, 1, 5); // a lossy metal blob
      addSource(s, { kind: 'point', x: sx, y: sy, amp: 1, phase: 0 });
      addMonitor(s, { name: 'm', x: mx, y: my });
      const f = new CpuFdtd(s);
      f.run(2400);
      return { re: Array.from(f.monRe[0]), im: Array.from(f.monIm[0]) };
    };
    const ab = build(30, 30, 130, 95);   // A in vacuum, B inside the eps=2.5 slab? (no: B at 130,95 is vacuum)
    const ba = build(130, 95, 30, 30);
    const ab2 = build(30, 30, 45, 60);    // B inside the eps=2.5 slab
    const ba2 = build(45, 60, 30, 30);
    for (const [p, q] of [[ab, ba], [ab2, ba2]]) {
      for (let k = 0; k < p.re.length; k++) {
        const mag = Math.hypot(p.re[k], p.im[k]);
        const err = Math.hypot(p.re[k] - q.re[k], p.im[k] - q.im[k]) / mag;
        console.log(`[validation] reciprocity rel. error (freq ${k}) = ${err.toExponential(2)}`);
        expect(err).toBeLessThan(2e-3);
      }
    }
  });
});
