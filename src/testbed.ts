// window.etchlight, used by e2e/run.mjs and handy in the console.
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
  app: null as unknown,
};

declare global {
  interface Window { etchlight: typeof testbed }
}
window.etchlight = testbed;
