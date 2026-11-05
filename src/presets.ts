import type { Scene } from './core/types';
import { createScene, fillRect, fillDisk, addSource, addMonitor, setDesign, addTarget } from './core/scene';

export interface Preset {
  id: string;
  name: string;
  blurb: string;
  build: () => Scene;
  /** inverse design presets start the optimizer on load */
  optimize?: boolean;
}

const SI = 3.48 * 3.48;    // silicon, eps = n^2
const SIO2 = 1.44 * 1.44;  // silica
const GLASS = 1.5 * 1.5;

export const presets: Preset[] = [
  {
    id: 'double-slit',
    name: 'Double slit',
    blurb: 'Plane wave into a metal screen with two slits. Switch to the intensity view for the fringes.',
    build: () => {
      const s = createScene({ nx: 320, ny: 240, pml: 16, waveform: { kind: 'cw', lambda: 24, rampPeriods: 3 }, monitorLambdas: [] });
      fillRect(s, 110, 0, 113, 239, 1, 20);
      fillRect(s, 110, 100, 113, 106, 1, 0);
      fillRect(s, 110, 134, 113, 140, 1, 0);
      addSource(s, { kind: 'line', x: 40, y: 16, x2: 40, y2: 223, amp: 1, phase: 0 });
      return s;
    },
  },
  {
    id: 'lens',
    name: 'Dielectric lens',
    blurb: 'Plano-convex glass lens focusing a plane wave. Compare with the inverse design version.',
    build: () => {
      const s = createScene({ nx: 320, ny: 240, pml: 16, waveform: { kind: 'cw', lambda: 20, rampPeriods: 3 } });
      // Plano-convex: flat face at x=110, spherical face of radius R.
      const R = 120, cx = 110 - R + 40;
      for (let j = 0; j < 240; j++) for (let i = 110; i < 170; i++) {
        const dx = i - cx, dy = j - 120;
        if (dx * dx + dy * dy <= R * R && Math.abs(dy) < 90) { s.eps[j * s.nx + i] = GLASS; }
      }
      addSource(s, { kind: 'line', x: 40, y: 16, x2: 40, y2: 223, amp: 1, phase: 0 });
      addMonitor(s, { name: 'focus', x: 250, y: 120 });
      return s;
    },
  },
  {
    id: 'waveguide-bend',
    name: 'Waveguide bend',
    blurb: 'Silicon strip waveguide in silica with a 90 degree bend. A lot leaks out at the corner.',
    build: () => {
      const s = createScene({ nx: 300, ny: 220, pml: 16, waveform: { kind: 'cw', lambda: 62, rampPeriods: 3 } });
      s.eps.fill(SIO2);
      fillRect(s, 0, 100, 150, 119, SI);
      fillRect(s, 131, 100, 150, 219, SI);
      addSource(s, { kind: 'line', x: 30, y: 92, x2: 30, y2: 127, amp: 1, phase: 0 });
      addMonitor(s, { name: 'out', x: 140, y: 190 });
      return s;
    },
  },
  {
    id: 'ring-resonator',
    name: 'Ring resonator',
    blurb: 'Bus waveguide coupled to a ring. Pulse source; let it run a while and the spectrum shows the resonances.',
    build: () => {
      const s = createScene({ nx: 340, ny: 260, pml: 16, waveform: { kind: 'pulse', lambda: 60, widthPeriods: 1.2 }, monitorLambdas: Array.from({ length: 48 }, (_, i) => 48 + i * 0.6) });
      s.eps.fill(SIO2);
      fillRect(s, 0, 60, 339, 73, SI);
      fillDisk(s, 170, 155, 70, SI);
      fillDisk(s, 170, 155, 56, SIO2);
      addSource(s, { kind: 'line', x: 30, y: 54, x2: 30, y2: 79, amp: 1, phase: 0 });
      addMonitor(s, { name: 'through', x: 300, y: 66 });
      addMonitor(s, { name: 'ring', x: 170, y: 92 });
      return s;
    },
  },
  {
    id: 'photonic-crystal',
    name: 'Photonic crystal',
    blurb: 'Square lattice of silicon rods with a missing row. In the band gap the light follows the defect.',
    build: () => {
      const s = createScene({ nx: 320, ny: 240, pml: 16, waveform: { kind: 'cw', lambda: 30, rampPeriods: 3 } });
      const a = 12, r = 2.6;
      for (let gy = 0; gy < 13; gy++) for (let gx = 0; gx < 17; gx++) {
        const row = gy - 6;
        if (row === 0) continue;
        fillDisk(s, 90 + gx * a, 120 + row * a, r, SI);
      }
      addSource(s, { kind: 'line', x: 50, y: 112, x2: 50, y2: 128, amp: 1, phase: 0 });
      addMonitor(s, { name: 'out', x: 300, y: 120 });
      return s;
    },
  },
  {
    id: 'inverse-lens',
    name: 'Inverse design: focus light',
    blurb: 'Blank design region, plane wave in, target on the right. The optimizer ends up with a lens.',
    optimize: true,
    build: () => {
      const s = createScene({ nx: 260, ny: 200, pml: 14, waveform: { kind: 'cw', lambda: 24, rampPeriods: 4 } });
      addSource(s, { kind: 'line', x: 30, y: 14, x2: 30, y2: 185, amp: 1, phase: 0 });
      setDesign(s, { x0: 80, y0: 40, x1: 130, y1: 160, epsMin: 1, epsMax: GLASS * 1.6, radius: 2.5 });
      addTarget(s, { x0: 200, y0: 97, x1: 203, y1: 103, weight: 1 });
      addMonitor(s, { name: 'focus', x: 201, y: 100 });
      return s;
    },
  },
  {
    id: 'inverse-splitter',
    name: 'Inverse design: 1x2 splitter',
    blurb: 'One silicon input, two outputs. The design region starts uniform and gets carved into a splitter.',
    optimize: true,
    build: () => {
      const s = createScene({ nx: 300, ny: 220, pml: 16, waveform: { kind: 'cw', lambda: 62, rampPeriods: 4 } });
      s.eps.fill(SIO2);
      fillRect(s, 0, 100, 110, 119, SI);
      fillRect(s, 190, 60, 299, 79, SI);
      fillRect(s, 190, 140, 299, 159, SI);
      addSource(s, { kind: 'line', x: 36, y: 92, x2: 36, y2: 127, amp: 1, phase: 0 });
      setDesign(s, { x0: 110, y0: 50, x1: 190, y1: 169, epsMin: SIO2, epsMax: SI, radius: 3 });
      addTarget(s, { x0: 250, y0: 66, x1: 252, y1: 73, weight: 1 });
      addTarget(s, { x0: 250, y0: 146, x1: 252, y1: 153, weight: 1 });
      addMonitor(s, { name: 'top', x: 251, y: 69 });
      addMonitor(s, { name: 'bottom', x: 251, y: 149 });
      return s;
    },
  },
  {
    id: 'inverse-bend',
    name: 'Inverse design: sharp bend',
    blurb: 'Get light around a 90 degree corner with as little loss as possible.',
    optimize: true,
    build: () => {
      const s = createScene({ nx: 260, ny: 220, pml: 16, waveform: { kind: 'cw', lambda: 62, rampPeriods: 4 } });
      s.eps.fill(SIO2);
      fillRect(s, 0, 100, 100, 119, SI);
      fillRect(s, 140, 160, 159, 219, SI);
      addSource(s, { kind: 'line', x: 30, y: 92, x2: 30, y2: 127, amp: 1, phase: 0 });
      setDesign(s, { x0: 100, y0: 70, x1: 170, y1: 160, epsMin: SIO2, epsMax: SI, radius: 3 });
      addTarget(s, { x0: 146, y0: 190, x1: 153, y1: 192, weight: 1 });
      addMonitor(s, { name: 'out', x: 150, y: 191 });
      return s;
    },
  },
  {
    id: 'blank',
    name: 'Blank canvas',
    blurb: 'Draw whatever. Add sources and monitors, mark a design region and targets, optimize.',
    build: () => {
      const s = createScene({ nx: 320, ny: 240, pml: 16, waveform: { kind: 'cw', lambda: 24, rampPeriods: 3 } });
      addSource(s, { kind: 'point', x: 80, y: 120, amp: 1, phase: 0 });
      return s;
    },
  },
];

export function presetById(id: string): Preset | undefined {
  return presets.find((p) => p.id === id);
}
