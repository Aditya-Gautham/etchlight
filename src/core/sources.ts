import type { Scene } from './types';
import { idx } from './types';

export interface SourceCells {
  /** Flat cell indices. */
  index: Int32Array;
  amp: Float32Array;
  phase: Float32Array;
}

/** Expand point/line sources into a per-cell list (one entry per cell). */
export function expandSources(scene: Scene): SourceCells {
  const map = new Map<number, { amp: number; phase: number }>();
  for (const s of scene.sources) {
    if (s.kind === 'point') {
      put(map, scene, s.x, s.y, s.amp, s.phase);
    } else {
      const x2 = s.x2 ?? s.x, y2 = s.y2 ?? s.y;
      const n = Math.max(Math.abs(x2 - s.x), Math.abs(y2 - s.y));
      for (let k = 0; k <= n; k++) {
        const t = n === 0 ? 0 : k / n;
        put(map, scene, Math.round(s.x + (x2 - s.x) * t), Math.round(s.y + (y2 - s.y) * t), s.amp, s.phase);
      }
    }
  }
  const index = new Int32Array(map.size);
  const amp = new Float32Array(map.size);
  const phase = new Float32Array(map.size);
  let n = 0;
  for (const [k, v] of map) {
    index[n] = k; amp[n] = v.amp; phase[n] = v.phase; n++;
  }
  return { index, amp, phase };
}

function put(map: Map<number, { amp: number; phase: number }>, scene: Scene, x: number, y: number, amp: number, phase: number): void {
  if (x < 0 || y < 0 || x >= scene.nx || y >= scene.ny) return;
  const k = idx(scene.nx, x, y);
  const prev = map.get(k);
  if (!prev) { map.set(k, { amp, phase }); return; }
  // Superpose phasors so overlapping sources add coherently.
  const re = prev.amp * Math.cos(prev.phase) + amp * Math.cos(phase);
  const im = prev.amp * Math.sin(prev.phase) + amp * Math.sin(phase);
  map.set(k, { amp: Math.hypot(re, im), phase: Math.atan2(im, re) });
}
