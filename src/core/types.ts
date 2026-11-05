// Shared data types for the solver. Everything is in normalized units:
//   c = 1, eps0 = mu0 = 1, dx = dy = 1 cell.
// Time is therefore measured in "cell transit times" and a wavelength of
// `lambda` cells has angular frequency 2*pi/lambda.

export interface SourceSpec {
  kind: 'point' | 'line';
  x: number;
  y: number;
  /** End point for line sources (inclusive). */
  x2?: number;
  y2?: number;
  /** Current amplitude. */
  amp: number;
  /** Phase in radians, used by CW excitation. */
  phase: number;
}

export interface MonitorSpec {
  name: string;
  x: number;
  y: number;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TargetSpec extends Rect {
  /** Positive weight = maximize |E|^2 here, negative = minimize. */
  weight: number;
}

export interface DesignSpec extends Rect {
  epsMin: number;
  epsMax: number;
  /** Filter radius in cells (conic kernel). */
  radius: number;
}

export type Waveform =
  | { kind: 'pulse'; lambda: number; /** Gaussian envelope width in periods. */ widthPeriods: number }
  | { kind: 'cw'; lambda: number; /** Ramp-up time in periods. */ rampPeriods: number };

export interface Scene {
  nx: number;
  ny: number;
  /** Courant number dt/dx. Must be < 1/sqrt(2) in 2D. */
  dt: number;
  pml: number;
  /** Relative permittivity at Ez nodes, length nx*ny. */
  eps: Float32Array;
  /** Electric conductivity (normalized), length nx*ny. */
  sigma: Float32Array;
  sources: SourceSpec[];
  monitors: MonitorSpec[];
  waveform: Waveform;
  /** Frequencies (as wavelengths in cells) sampled by point monitors. */
  monitorLambdas: number[];
  design: DesignSpec | null;
  targets: TargetSpec[];
}

export const idx = (nx: number, i: number, j: number): number => j * nx + i;
