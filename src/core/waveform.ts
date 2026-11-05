import type { Waveform } from './types';

/** Angular frequency of the carrier. */
export function carrierOmega(w: Waveform): number {
  return (2 * Math.PI) / w.lambda;
}

/**
 * Parameters shared by the CPU and GPU implementations so both evaluate the
 * identical closed-form waveform. `kind` 0 = Gaussian-modulated pulse,
 * 1 = ramped continuous wave.
 */
export interface WaveformParams {
  kind: 0 | 1;
  omega: number;
  /** Pulse: envelope centre time. CW: unused. */
  t0: number;
  /** Pulse: envelope 1/e half-width. CW: ramp duration. */
  tau: number;
}

export function waveformParams(w: Waveform): WaveformParams {
  const omega = carrierOmega(w);
  if (w.kind === 'pulse') {
    const tau = w.widthPeriods * w.lambda;
    return { kind: 0, omega, t0: 3 * tau, tau };
  }
  return { kind: 1, omega, t0: 0, tau: Math.max(1e-9, w.rampPeriods * w.lambda) };
}

/** Evaluate the waveform at time t for a source with the given phase. */
export function evalWaveform(p: WaveformParams, t: number, phase: number): number {
  if (p.kind === 0) {
    const u = (t - p.t0) / p.tau;
    return Math.exp(-u * u) * Math.cos(p.omega * (t - p.t0) + phase);
  }
  const r = Math.min(1, t / p.tau);
  const ramp = r * r * (3 - 2 * r);
  return ramp * Math.cos(p.omega * t + phase);
}

/** Time after which a pulse source has effectively finished emitting. */
export function pulseEndTime(p: WaveformParams): number {
  return p.kind === 0 ? p.t0 + 4 * p.tau : Infinity;
}
