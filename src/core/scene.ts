import type { Scene, Waveform, DesignSpec, TargetSpec, SourceSpec, MonitorSpec } from './types';
import { idx } from './types';

export interface SceneOptions {
  nx: number;
  ny: number;
  pml?: number;
  dt?: number;
  waveform?: Waveform;
  monitorLambdas?: number[];
}

export function createScene(o: SceneOptions): Scene {
  const n = o.nx * o.ny;
  const eps = new Float32Array(n).fill(1);
  const sigma = new Float32Array(n);
  return {
    nx: o.nx,
    ny: o.ny,
    dt: o.dt ?? 0.5,
    pml: o.pml ?? 16,
    eps,
    sigma,
    sources: [],
    monitors: [],
    waveform: o.waveform ?? { kind: 'pulse', lambda: 40, widthPeriods: 2 },
    monitorLambdas: o.monitorLambdas ?? [],
    design: null,
    targets: [],
  };
}

export function cloneScene(s: Scene): Scene {
  return {
    ...s,
    eps: new Float32Array(s.eps),
    sigma: new Float32Array(s.sigma),
    sources: s.sources.map((x) => ({ ...x })),
    monitors: s.monitors.map((x) => ({ ...x })),
    monitorLambdas: [...s.monitorLambdas],
    design: s.design ? { ...s.design } : null,
    targets: s.targets.map((x) => ({ ...x })),
  };
}

export function fillRect(s: Scene, x0: number, y0: number, x1: number, y1: number, eps: number, sigma = 0): void {
  const ia = Math.max(0, Math.min(x0, x1)), ib = Math.min(s.nx - 1, Math.max(x0, x1));
  const ja = Math.max(0, Math.min(y0, y1)), jb = Math.min(s.ny - 1, Math.max(y0, y1));
  for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) {
    const k = idx(s.nx, i, j);
    s.eps[k] = eps;
    s.sigma[k] = sigma;
  }
}

export function fillDisk(s: Scene, cx: number, cy: number, r: number, eps: number, sigma = 0): void {
  const ia = Math.max(0, Math.floor(cx - r)), ib = Math.min(s.nx - 1, Math.ceil(cx + r));
  const ja = Math.max(0, Math.floor(cy - r)), jb = Math.min(s.ny - 1, Math.ceil(cy + r));
  for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) {
    const dx = i - cx, dy = j - cy;
    if (dx * dx + dy * dy <= r * r) {
      const k = idx(s.nx, i, j);
      s.eps[k] = eps;
      s.sigma[k] = sigma;
    }
  }
}

export function addSource(s: Scene, src: SourceSpec): void { s.sources.push(src); }
export function addMonitor(s: Scene, m: MonitorSpec): void { s.monitors.push(m); }
export function setDesign(s: Scene, d: DesignSpec | null): void { s.design = d; }
export function addTarget(s: Scene, t: TargetSpec): void { s.targets.push(t); }

export function omega(lambda: number): number { return (2 * Math.PI) / lambda; }

/** Serializable form (eps/sigma as base64 float32). */
export interface SceneJSON {
  nx: number; ny: number; dt: number; pml: number;
  eps: string; sigma: string;
  sources: SourceSpec[]; monitors: MonitorSpec[]; waveform: Waveform;
  monitorLambdas: number[]; design: DesignSpec | null; targets: TargetSpec[];
}

function f32ToB64(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64ToF32(s: string): Float32Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export function sceneToJSON(s: Scene): SceneJSON {
  return {
    nx: s.nx, ny: s.ny, dt: s.dt, pml: s.pml,
    eps: f32ToB64(s.eps), sigma: f32ToB64(s.sigma),
    sources: s.sources, monitors: s.monitors, waveform: s.waveform,
    monitorLambdas: s.monitorLambdas, design: s.design, targets: s.targets,
  };
}

export function sceneFromJSON(j: SceneJSON): Scene {
  return {
    nx: j.nx, ny: j.ny, dt: j.dt, pml: j.pml,
    eps: b64ToF32(j.eps), sigma: b64ToF32(j.sigma),
    sources: j.sources, monitors: j.monitors, waveform: j.waveform,
    monitorLambdas: j.monitorLambdas, design: j.design, targets: j.targets,
  };
}
