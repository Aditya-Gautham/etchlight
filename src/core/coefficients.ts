import type { Scene } from './types';
import { buildPml } from './pml';

/**
 * Per-cell update coefficients of the semi-implicit lossy Yee scheme.
 * Computed once per scene and shared by the CPU and GPU solvers so both
 * integrate exactly the same difference equations.
 *
 *   Ezx <- caX*Ezx + cbX*(Hy(i,j) - Hy(i-1,j))
 *   Ezy <- caY*Ezy - cbY*(Hx(i,j) - Hx(i,j-1))
 *   Hx  <- daY*Hx  - dbY*(Ez(i,j+1) - Ez(i,j))
 *   Hy  <- daX*Hy  + dbX*(Ez(i+1,j) - Ez(i,j))
 */
export interface Coefficients {
  caX: Float32Array; cbX: Float32Array;
  caY: Float32Array; cbY: Float32Array;
  daX: Float32Array; dbX: Float32Array;
  daY: Float32Array; dbY: Float32Array;
}

export function computeCoefficients(scene: Scene): Coefficients {
  const { nx, ny, dt } = scene;
  const n = nx * ny;
  const c: Coefficients = {
    caX: new Float32Array(n), cbX: new Float32Array(n),
    caY: new Float32Array(n), cbY: new Float32Array(n),
    daX: new Float32Array(n), dbX: new Float32Array(n),
    daY: new Float32Array(n), dbY: new Float32Array(n),
  };
  const pml = buildPml(nx, ny, scene.pml);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const eps = scene.eps[k];
      const sm = scene.sigma[k];
      // Electric losses: PML conductivity scaled by eps keeps the layer
      // impedance-matched even where a dielectric runs into it.
      const lx = pml.sxE[i] * eps + sm;
      const ly = pml.syE[j] * eps + sm;
      const ax = (lx * dt) / (2 * eps);
      const ay = (ly * dt) / (2 * eps);
      c.caX[k] = (1 - ax) / (1 + ax);
      c.cbX[k] = dt / eps / (1 + ax);
      c.caY[k] = (1 - ay) / (1 + ay);
      c.cbY[k] = dt / eps / (1 + ay);
      // Magnetic losses (mu = 1): sigma* = sigma_pml.
      const bx = (pml.sxH[i] * dt) / 2;
      const by = (pml.syH[j] * dt) / 2;
      c.daX[k] = (1 - bx) / (1 + bx);
      c.dbX[k] = dt / (1 + bx);
      c.daY[k] = (1 - by) / (1 + by);
      c.dbY[k] = dt / (1 + by);
    }
  }
  return c;
}
