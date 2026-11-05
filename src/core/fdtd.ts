/**
 * CPU reference implementation of the 2D TM_z Yee FDTD scheme with a
 * split-field Berenger PML. This is the ground truth that the tests check
 * against analytic results and that the WebGL2 implementation must match.
 *
 * Field components: Ez (stored as Ezx + Ezy for the PML split), Hx, Hy.
 * Grid staggering (Yee):
 *   Ez(i, j)         at integer nodes
 *   Hx(i, j + 1/2)   between Ez(i,j) and Ez(i,j+1)
 *   Hy(i + 1/2, j)   between Ez(i,j) and Ez(i+1,j)
 * Units: c = eps0 = mu0 = dx = 1, so dt is the Courant number.
 */
import type { Scene } from './types';
import { computeCoefficients } from './coefficients';
import { expandSources, type SourceCells } from './sources';
import { waveformParams, evalWaveform, type WaveformParams } from './waveform';

export interface FdtdOptions {
  /** Accumulate a whole-grid DFT of Ez at omegaDft (used for intensity display and the adjoint). */
  fullDft?: boolean;
  /** Angular frequency for the whole-grid DFT; defaults to the carrier. */
  omegaDft?: number;
  /** Only accumulate DFTs after this many steps (lets transients die). */
  dftStartStep?: number;
}

export class CpuFdtd {
  readonly nx: number;
  readonly ny: number;
  readonly dt: number;
  readonly n: number;
  readonly ezx: Float32Array;
  readonly ezy: Float32Array;
  readonly hx: Float32Array;
  readonly hy: Float32Array;

  // Update coefficients, one per cell.
  readonly caX: Float32Array; readonly cbX: Float32Array;
  readonly caY: Float32Array; readonly cbY: Float32Array;
  readonly daX: Float32Array; readonly dbX: Float32Array; // Hy
  readonly daY: Float32Array; readonly dbY: Float32Array; // Hx

  readonly src: SourceCells;
  readonly srcScale: Float32Array;
  readonly wf: WaveformParams;

  /** Monitor DFTs: [monitor][frequency]. */
  readonly monRe: Float32Array[];
  readonly monIm: Float32Array[];
  readonly monOmega: Float64Array;
  readonly monIndex: Int32Array;

  readonly fullRe: Float32Array | null;
  readonly fullIm: Float32Array | null;
  readonly omegaDft: number;
  readonly dftStartStep: number;
  /** Number of steps accumulated into the DFTs. */
  dftSteps = 0;

  step = 0;

  constructor(readonly scene: Scene, opts: FdtdOptions = {}) {
    const { nx, ny, dt } = scene;
    this.nx = nx; this.ny = ny; this.dt = dt; this.n = nx * ny;
    this.ezx = new Float32Array(this.n);
    this.ezy = new Float32Array(this.n);
    this.hx = new Float32Array(this.n);
    this.hy = new Float32Array(this.n);

    const c = computeCoefficients(scene);
    this.caX = c.caX; this.cbX = c.cbX; this.caY = c.caY; this.cbY = c.cbY;
    this.daX = c.daX; this.dbX = c.dbX; this.daY = c.daY; this.dbY = c.dbY;

    this.src = expandSources(scene);
    this.srcScale = new Float32Array(this.src.index.length);
    for (let s = 0; s < this.src.index.length; s++) {
      this.srcScale[s] = dt / scene.eps[this.src.index[s]];
    }
    this.wf = waveformParams(scene.waveform);

    this.monIndex = new Int32Array(scene.monitors.map((m) => m.y * nx + m.x));
    this.monOmega = new Float64Array(scene.monitorLambdas.map((l) => (2 * Math.PI) / l));
    this.monRe = scene.monitors.map(() => new Float32Array(this.monOmega.length));
    this.monIm = scene.monitors.map(() => new Float32Array(this.monOmega.length));

    this.omegaDft = opts.omegaDft ?? this.wf.omega;
    this.dftStartStep = opts.dftStartStep ?? 0;
    this.fullRe = opts.fullDft ? new Float32Array(this.n) : null;
    this.fullIm = opts.fullDft ? new Float32Array(this.n) : null;
  }

  /** Current simulation time of the E field. */
  get time(): number { return this.step * this.dt; }

  ez(k: number): number { return this.ezx[k] + this.ezy[k]; }

  /** Materialize Ez = Ezx + Ezy into a new (or provided) array. */
  getEz(out?: Float32Array): Float32Array {
    const o = out ?? new Float32Array(this.n);
    for (let k = 0; k < this.n; k++) o[k] = this.ezx[k] + this.ezy[k];
    return o;
  }

  advance(): void {
    const { nx, ny, ezx, ezy, hx, hy } = this;
    // --- H update (uses Ez at time n) ---
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      const up = j + 1 < ny;
      for (let i = 0; i < nx; i++) {
        const k = row + i;
        const ez = ezx[k] + ezy[k];
        const ezUp = up ? ezx[k + nx] + ezy[k + nx] : 0;
        const ezRight = i + 1 < nx ? ezx[k + 1] + ezy[k + 1] : 0;
        hx[k] = this.daY[k] * hx[k] - this.dbY[k] * (ezUp - ez);
        hy[k] = this.daX[k] * hy[k] + this.dbX[k] * (ezRight - ez);
      }
    }
    // --- E update (uses H at time n+1/2) ---
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const k = row + i;
        const hyLeft = i > 0 ? hy[k - 1] : 0;
        const hxDown = j > 0 ? hx[k - nx] : 0;
        ezx[k] = this.caX[k] * ezx[k] + this.cbX[k] * (hy[k] - hyLeft);
        ezy[k] = this.caY[k] * ezy[k] - this.cbY[k] * (hx[k] - hxDown);
      }
    }
    this.step++;
    const t = this.time;
    // --- Sources: soft current injection, Ez += -(dt/eps) * J with J = -amp*w(t) ---
    const src = this.src;
    for (let s = 0; s < src.index.length; s++) {
      ezx[src.index[s]] += this.srcScale[s] * src.amp[s] * evalWaveform(this.wf, t, src.phase[s]);
    }
    // --- DFTs (convention: X(w) = sum x(t) e^{-i w t} dt) ---
    if (this.step > this.dftStartStep) {
      this.dftSteps++;
      const dt = this.dt;
      for (let m = 0; m < this.monIndex.length; m++) {
        const v = this.ez(this.monIndex[m]) * dt;
        const re = this.monRe[m], im = this.monIm[m];
        for (let f = 0; f < this.monOmega.length; f++) {
          const w = this.monOmega[f] * t;
          re[f] += v * Math.cos(w);
          im[f] -= v * Math.sin(w);
        }
      }
      if (this.fullRe && this.fullIm) {
        const c = Math.cos(this.omegaDft * t) * dt;
        const s = -Math.sin(this.omegaDft * t) * dt;
        const re = this.fullRe, im = this.fullIm;
        for (let k = 0; k < this.n; k++) {
          const e = ezx[k] + ezy[k];
          re[k] += e * c;
          im[k] += e * s;
        }
      }
    }
  }

  run(steps: number): void {
    for (let s = 0; s < steps; s++) this.advance();
  }

  /** Copy of the whole-grid DFT accumulators (throws if not enabled). */
  readFullDft(): { re: Float32Array; im: Float32Array } {
    if (!this.fullRe || !this.fullIm) throw new Error('fullDft not enabled');
    return { re: new Float32Array(this.fullRe), im: new Float32Array(this.fullIm) };
  }

  dispose(): void { /* nothing to free on the CPU */ }

  /** Maximum |Ez| over the grid; handy for stability checks. */
  maxAbsEz(): number {
    let m = 0;
    for (let k = 0; k < this.n; k++) {
      const v = Math.abs(this.ezx[k] + this.ezy[k]);
      if (Number.isNaN(v)) return NaN;
      if (v > m) m = v;
    }
    return m;
  }
}
