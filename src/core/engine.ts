import type { Scene } from './types';
import { CpuFdtd, type FdtdOptions } from './fdtd';

/**
 * The minimal interface the optimizer needs from a solver. The CPU reference
 * and the WebGL2 implementation both satisfy it, so inverse design runs
 * unchanged on either.
 */
export interface FieldRunner {
  /** Advance by n time steps. GPU implementations may yield to the event loop. */
  run(n: number): Promise<void>;
  /** Whole-grid DFT of Ez at the configured frequency (requires fullDft). */
  readFullDft(): { re: Float32Array; im: Float32Array };
  dispose(): void;
}

export type EngineFactory = (scene: Scene, opts: FdtdOptions) => FieldRunner;

export const cpuEngine: EngineFactory = (scene, opts) => {
  const f = new CpuFdtd(scene, opts);
  return {
    async run(n) { f.run(n); },
    readFullDft: () => f.readFullDft(),
    dispose: () => f.dispose(),
  };
};
