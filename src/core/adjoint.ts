// Adjoint inverse design. See docs/physics.md for the derivation.
//   J = sum_t w_t sum_{r in t} |E(r)|^2        (one frequency)
//   dJ/deps(r) = 2 w~^2 Re[E(r) lambda(r)]
// lambda comes from a second run with source w_t conj(E) / (i w~ e^{i w dt/2})
// at the target cells. w~ = (2/dt) sin(w dt/2) is what the leapfrog scheme
// sees, the phase factor is because the source goes in after the curl update.
// tests/adjoint.test.ts checks this against finite differences.
import type { Scene, SourceSpec, DesignSpec } from './types';
import { cloneScene } from './scene';
import type { EngineFactory } from './engine';
import { forwardParam, backwardParam, type DesignShape } from './parameterization';

export interface PhasorField { re: Float32Array; im: Float32Array }

export interface SolveSettings {
  /** Wavelength in cells. */
  lambda: number;
  /** CW ramp-up, in periods. */
  rampPeriods: number;
  /** Periods to run before starting the DFT (transients must die out). */
  settlePeriods: number;
  /** Periods integrated by the DFT. */
  dftPeriods: number;
}

export const defaultSolveSettings: SolveSettings = { lambda: 40, rampPeriods: 4, settlePeriods: 24, dftPeriods: 4 };

/** Number of time steps used by a steady-state solve. */
export function solveSteps(scene: Scene, st: SolveSettings): { settle: number; dft: number } {
  const perPeriod = st.lambda / scene.dt;
  return { settle: Math.round(st.settlePeriods * perPeriod), dft: Math.round(st.dftPeriods * perPeriod) };
}

/** CW run to steady state, returns the Ez phasor on the whole grid (Ez(t) = Re[E e^{iwt}]). */
export async function solvePhasor(scene: Scene, sources: SourceSpec[], st: SolveSettings, engine: EngineFactory): Promise<PhasorField> {
  const s = cloneScene(scene);
  s.sources = sources;
  s.waveform = { kind: 'cw', lambda: st.lambda, rampPeriods: st.rampPeriods };
  s.monitors = [];
  s.monitorLambdas = [];
  const { settle, dft } = solveSteps(s, st);
  const runner = engine(s, { fullDft: true, omegaDft: (2 * Math.PI) / st.lambda, dftStartStep: settle });
  await runner.run(settle + dft);
  const out = runner.readFullDft();
  runner.dispose();
  // DFT over N full periods of Re[E e^{iwt}] gives (N T / 2) E.
  const scale = 2 / (dft * s.dt);
  for (let k = 0; k < out.re.length; k++) { out.re[k] *= scale; out.im[k] *= scale; }
  return out;
}

export function objectiveValue(E: PhasorField, scene: Scene): number {
  let J = 0;
  for (const t of scene.targets) {
    for (let j = t.y0; j <= t.y1; j++) for (let i = t.x0; i <= t.x1; i++) {
      const k = j * scene.nx + i;
      J += t.weight * (E.re[k] * E.re[k] + E.im[k] * E.im[k]);
    }
  }
  return J;
}

/** Discrete angular frequency of the leapfrog scheme: (2/dt) sin(w dt / 2). */
export function discreteOmega(omega: number, dt: number): number {
  return (2 / dt) * Math.sin((omega * dt) / 2);
}

/** Adjoint sources: one CW point source per target cell. */
export function adjointSources(E: PhasorField, scene: Scene, omega: number): SourceSpec[] {
  const out: SourceSpec[] = [];
  const wt = discreteOmega(omega, scene.dt);
  // 1 / (i w~ e^{i w dt/2}) = e^{-i (pi/2 + w dt/2)} / w~
  const ph = -(Math.PI / 2 + (omega * scene.dt) / 2);
  const kre = Math.cos(ph) / wt, kim = Math.sin(ph) / wt;
  for (const t of scene.targets) {
    for (let j = t.y0; j <= t.y1; j++) for (let i = t.x0; i <= t.x1; i++) {
      const k = j * scene.nx + i;
      // z = w_t * conj(E) * kappa^-1
      const cre = t.weight * E.re[k], cim = -t.weight * E.im[k];
      const zre = cre * kre - cim * kim;
      const zim = cre * kim + cim * kre;
      const amp = Math.hypot(zre, zim);
      if (amp === 0) continue;
      out.push({ kind: 'point', x: i, y: j, amp, phase: Math.atan2(zim, zre) });
    }
  }
  return out;
}

/** dJ/d eps over the design rectangle, row-major (w x h). */
export function gradientEps(Ef: PhasorField, Ea: PhasorField, scene: Scene, design: DesignSpec, omega: number): Float32Array {
  const w = design.x1 - design.x0 + 1, h = design.y1 - design.y0 + 1;
  const g = new Float32Array(w * h);
  const wt = discreteOmega(omega, scene.dt);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = (design.y0 + y) * scene.nx + design.x0 + x;
    const re = Ef.re[k] * Ea.re[k] - Ef.im[k] * Ea.im[k];
    g[y * w + x] = 2 * wt * wt * re;
  }
  return g;
}

export function designShape(d: DesignSpec): DesignShape {
  return { w: d.x1 - d.x0 + 1, h: d.y1 - d.y0 + 1 };
}

/** Write eps = epsMin + (epsMax - epsMin) * rhoHat into the scene's design rectangle. */
export function applyDesign(scene: Scene, d: DesignSpec, rhoHat: Float32Array): void {
  const { w, h } = designShape(d);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = (d.y0 + y) * scene.nx + d.x0 + x;
    scene.eps[k] = d.epsMin + (d.epsMax - d.epsMin) * rhoHat[y * w + x];
    scene.sigma[k] = 0;
  }
}

export interface OptimizerSettings {
  solve: SolveSettings;
  /** Adam learning rate in rho units. */
  lr: number;
  betaStart: number;
  betaGrowth: number;
  betaEvery: number;
  betaMax: number;
  eta: number;
}

export const defaultOptimizerSettings: OptimizerSettings = {
  solve: defaultSolveSettings,
  lr: 0.05,
  betaStart: 2,
  betaGrowth: 1.4,
  betaEvery: 6,
  betaMax: 64,
  eta: 0.5,
};

export interface IterationResult {
  iteration: number;
  objective: number;
  beta: number;
  /** Forward phasor field for display. */
  field: PhasorField;
  rhoHat: Float32Array;
}

/** Adam ascent on the design density. One forward + one adjoint run per step(). */
export class Optimizer {
  readonly design: DesignSpec;
  readonly shape: DesignShape;
  readonly rho: Float32Array;
  private m: Float32Array;
  private v: Float32Array;
  iteration = 0;
  beta: number;
  readonly history: number[] = [];

  constructor(readonly scene: Scene, readonly settings: OptimizerSettings = defaultOptimizerSettings, readonly engine: EngineFactory, initialRho = 0.5) {
    if (!scene.design) throw new Error('scene has no design region');
    if (scene.targets.length === 0) throw new Error('scene has no targets');
    this.design = scene.design;
    this.shape = designShape(this.design);
    const n = this.shape.w * this.shape.h;
    this.rho = new Float32Array(n).fill(initialRho);
    this.m = new Float32Array(n);
    this.v = new Float32Array(n);
    this.beta = settings.betaStart;
  }

  get omega(): number { return (2 * Math.PI) / this.settings.solve.lambda; }

  /** Materialize the current design into scene.eps. */
  apply(): Float32Array {
    const { rhoHat } = forwardParam(this.rho, this.shape, this.design.radius, this.beta, this.settings.eta);
    applyDesign(this.scene, this.design, rhoHat);
    return rhoHat;
  }

  async step(): Promise<IterationResult> {
    const st = this.settings;
    const { rhoTilde, rhoHat } = forwardParam(this.rho, this.shape, this.design.radius, this.beta, st.eta);
    applyDesign(this.scene, this.design, rhoHat);

    const Ef = await solvePhasor(this.scene, this.scene.sources, st.solve, this.engine);
    const J = objectiveValue(Ef, this.scene);
    const Ea = await solvePhasor(this.scene, adjointSources(Ef, this.scene, this.omega), st.solve, this.engine);
    const gEps = gradientEps(Ef, Ea, this.scene, this.design, this.omega);

    const dEps = this.design.epsMax - this.design.epsMin;
    const gHat = new Float32Array(gEps.length);
    for (let k = 0; k < gEps.length; k++) gHat[k] = gEps[k] * dEps;
    const gRho = backwardParam(gHat, rhoTilde, this.shape, this.design.radius, this.beta, st.eta);

    // Adam (ascent). Gradient normalized by RMS so lr is in rho units.
    this.iteration++;
    const b1 = 0.9, b2 = 0.999, eps = 1e-12;
    let rms = 0;
    for (let k = 0; k < gRho.length; k++) rms += gRho[k] * gRho[k];
    rms = Math.sqrt(rms / gRho.length) || 1;
    for (let k = 0; k < gRho.length; k++) {
      const g = gRho[k] / rms;
      this.m[k] = b1 * this.m[k] + (1 - b1) * g;
      this.v[k] = b2 * this.v[k] + (1 - b2) * g * g;
      const mh = this.m[k] / (1 - Math.pow(b1, this.iteration));
      const vh = this.v[k] / (1 - Math.pow(b2, this.iteration));
      this.rho[k] = Math.min(1, Math.max(0, this.rho[k] + (st.lr * mh) / (Math.sqrt(vh) + eps)));
    }
    if (this.iteration % st.betaEvery === 0) this.beta = Math.min(st.betaMax, this.beta * st.betaGrowth);

    this.history.push(J);
    return { iteration: this.iteration, objective: J, beta: this.beta, field: Ef, rhoHat };
  }
}
