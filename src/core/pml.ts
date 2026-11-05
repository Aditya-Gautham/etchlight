/**
 * Split-field (Berenger) PML profiles.
 *
 * Conductivity is graded polynomially from the interior edge of the layer to
 * the outer wall: sigma(rho) = sigmaMax * rho^m with rho in [0, 1].
 * sigmaMax follows the standard estimate for a target normal-incidence
 * reflection R0 (Taflove & Hagness, eq. 7.60 with eta = 1 in normalized units).
 */
export interface PmlProfile {
  /** sigma_x at integer (Ez) nodes, length nx. */
  sxE: Float32Array;
  /** sigma_x at half nodes i+1/2 (Hy positions), length nx. */
  sxH: Float32Array;
  syE: Float32Array;
  syH: Float32Array;
}

export const PML_ORDER = 3;
export const PML_R0 = 1e-8;

export function pmlSigmaMax(width: number, m = PML_ORDER, r0 = PML_R0): number {
  if (width <= 0) return 0;
  return (-(m + 1) * Math.log(r0)) / (2 * width);
}

function axisProfile(n: number, width: number, halfOffset: number): Float32Array {
  const out = new Float32Array(n);
  if (width <= 0) return out;
  const smax = pmlSigmaMax(width);
  for (let i = 0; i < n; i++) {
    const pos = i + halfOffset; // physical position of this node
    let rho = 0;
    if (pos < width) rho = (width - pos) / width;
    else if (pos > n - 1 - width) rho = (pos - (n - 1 - width)) / width;
    rho = Math.max(0, Math.min(1, rho));
    out[i] = smax * Math.pow(rho, PML_ORDER);
  }
  return out;
}

export function buildPml(nx: number, ny: number, width: number): PmlProfile {
  return {
    sxE: axisProfile(nx, width, 0),
    sxH: axisProfile(nx, width, 0.5),
    syE: axisProfile(ny, width, 0),
    syH: axisProfile(ny, width, 0.5),
  };
}
