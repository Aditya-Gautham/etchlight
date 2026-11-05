// Exposes the solver on window for the Playwright end-to-end tests
// (e2e/run.mjs) and for poking at it from the browser console.
import { CpuFdtd } from './core/fdtd';
import { GlFdtd, glEngine } from './gpu/gl-fdtd';
import { cpuEngine } from './core/engine';
import { createScene, fillRect, fillDisk, addSource, addMonitor, setDesign, addTarget } from './core/scene';
import { Optimizer, solvePhasor, objectiveValue, defaultOptimizerSettings } from './core/adjoint';
import { presets } from './presets';

export const testbed = {
  CpuFdtd, GlFdtd, glEngine, cpuEngine,
  createScene, fillRect, fillDisk, addSource, addMonitor, setDesign, addTarget,
  Optimizer, solvePhasor, objectiveValue, defaultOptimizerSettings, presets,
};

declare global {
  interface Window { etchlight: typeof testbed }
}
window.etchlight = testbed;
