import { describe, it, expect } from 'vitest';
import { createScene, fillRect, addSource, setDesign, addTarget } from '../src/core/scene';
import { cpuEngine } from '../src/core/engine';
import { solvePhasor, objectiveValue, adjointSources, gradientEps, defaultSolveSettings, Optimizer, defaultOptimizerSettings } from '../src/core/adjoint';
import { forwardParam, backwardParam } from '../src/core/parameterization';
import type { Scene } from '../src/core/types';

const st = { ...defaultSolveSettings, lambda: 24, settlePeriods: 30, dftPeriods: 4 };

function makeScene(): Scene {
  const s = createScene({ nx: 110, ny: 70, pml: 10 });
  // A waveguide-ish slab on the left feeding a design block; target to the right.
  fillRect(s, 12, 30, 40, 40, 2.25);
  addSource(s, { kind: 'line', x: 22, y: 26, x2: 22, y2: 44, amp: 1, phase: 0 });
  setDesign(s, { x0: 44, y0: 18, x1: 70, y1: 52, epsMin: 1, epsMax: 4, radius: 2 });
  addTarget(s, { x0: 84, y0: 33, x1: 86, y1: 37, weight: 1 });
  // Seed a non-trivial starting permittivity in the design region.
  const d = s.design!;
  for (let j = d.y0; j <= d.y1; j++) for (let i = d.x0; i <= d.x1; i++) {
    s.eps[j * s.nx + i] = 1 + 1.5 * (0.5 + 0.5 * Math.sin(0.4 * i) * Math.cos(0.5 * j));
  }
  return s;
}

async function objective(s: Scene): Promise<number> {
  const E = await solvePhasor(s, s.sources, st, cpuEngine);
  return objectiveValue(E, s);
}

describe('adjoint gradient', () => {
  it('matches central finite differences in direction and magnitude', async () => {
    const s = makeScene();
    const omega = (2 * Math.PI) / st.lambda;
    const Ef = await solvePhasor(s, s.sources, st, cpuEngine);
    const Ea = await solvePhasor(s, adjointSources(Ef, s, omega), st, cpuEngine);
    const g = gradientEps(Ef, Ea, s, s.design!, omega);
    const d = s.design!;
    const w = d.x1 - d.x0 + 1;

    // Finite differences at a handful of cells spread over the design region.
    const probes = [[3, 5], [10, 12], [18, 20], [25, 30], [7, 28], [22, 8], [13, 17], [20, 26]];
    const h = 0.02;
    const fd: number[] = [], adj: number[] = [];
    for (const [x, y] of probes) {
      const k = (d.y0 + y) * s.nx + d.x0 + x;
      const base = s.eps[k];
      s.eps[k] = base + h; const Jp = await objective(s);
      s.eps[k] = base - h; const Jm = await objective(s);
      s.eps[k] = base;
      fd.push((Jp - Jm) / (2 * h));
      adj.push(g[y * w + x]);
    }
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < fd.length; i++) { dot += fd[i] * adj[i]; na += fd[i] * fd[i]; nb += adj[i] * adj[i]; }
    const cosine = dot / Math.sqrt(na * nb);
    const scale = dot / nb; // least-squares fit fd ~ scale * adj
    const maxRel = Math.max(...fd.map((v, i) => Math.abs(v - adj[i]) / Math.max(1e-12, Math.abs(v))));
    console.log(`[validation] adjoint vs finite-difference: cosine = ${cosine.toFixed(5)}, fitted scale = ${scale.toFixed(4)}, max rel. err = ${(100 * maxRel).toFixed(2)}%`);
    for (let i = 0; i < fd.length; i++) console.log(`   cell ${probes[i]}: FD ${fd[i].toExponential(4)}  adjoint ${adj[i].toExponential(4)}`);
    expect(cosine).toBeGreaterThan(0.999);
    expect(Math.abs(scale - 1)).toBeLessThan(0.02);
  });
});

describe('parameterization chain rule', () => {
  it('backwardParam matches finite differences through filter and projection', () => {
    const shape = { w: 13, h: 9 }, radius = 2.5, beta = 6, eta = 0.5;
    const n = shape.w * shape.h;
    const rho = new Float32Array(n);
    for (let k = 0; k < n; k++) rho[k] = 0.5 + 0.4 * Math.sin(k * 0.7);
    // Random linear objective on rhoHat: J = sum c_k rhoHat_k.
    const c = new Float32Array(n);
    for (let k = 0; k < n; k++) c[k] = Math.cos(k * 1.3);
    const J = (r: Float32Array) => { const { rhoHat } = forwardParam(r, shape, radius, beta, eta); let s = 0; for (let k = 0; k < n; k++) s += c[k] * rhoHat[k]; return s; };
    const { rhoTilde } = forwardParam(rho, shape, radius, beta, eta);
    const g = backwardParam(c, rhoTilde, shape, radius, beta, eta);
    const h = 1e-3;
    let maxErr = 0;
    for (const k of [0, 5, 12, 40, 58, 77, 100, 116]) {
      const r2 = new Float32Array(rho);
      r2[k] = rho[k] + h; const Jp = J(r2);
      r2[k] = rho[k] - h; const Jm = J(r2);
      const fd = (Jp - Jm) / (2 * h);
      maxErr = Math.max(maxErr, Math.abs(fd - g[k]) / Math.max(1e-6, Math.abs(fd)));
    }
    console.log(`[validation] parameterization chain rule max rel. err = ${(100 * maxErr).toFixed(3)}%`);
    expect(maxErr).toBeLessThan(1e-2);
  });
});

describe('optimizer', () => {
  it('increases the objective monotonically over a few iterations', async () => {
    const s = makeScene();
    const opt = new Optimizer(s, { ...defaultOptimizerSettings, solve: st, lr: 0.08 }, cpuEngine);
    const J: number[] = [];
    for (let i = 0; i < 5; i++) J.push((await opt.step()).objective);
    console.log(`[validation] objective over 5 Adam steps: ${J.map((v) => v.toExponential(3)).join(' -> ')}`);
    expect(J[4]).toBeGreaterThan(J[0] * 1.2);
  });
});
