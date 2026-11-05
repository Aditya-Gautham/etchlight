// Density parameterization (Jensen & Sigmund 2011 style):
//   rho in [0,1] -> conic filter -> rhoTilde -> tanh projection -> rhoHat
//   eps = epsMin + (epsMax - epsMin) * rhoHat
// Filter sets a minimum feature size, projection pushes toward binary as beta grows.

export interface DesignShape { w: number; h: number }

/** Conic filter kernel, normalized per output pixel so edges are unbiased. */
export function conicFilter(src: Float32Array, out: Float32Array, shape: DesignShape, radius: number): void {
  const { w, h } = shape;
  const r = Math.max(0, Math.ceil(radius));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0, norm = 0;
    for (let dy = -r; dy <= r; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx; if (xx < 0 || xx >= w) continue;
        const wgt = radius > 0 ? Math.max(0, 1 - Math.hypot(dx, dy) / radius) : (dx === 0 && dy === 0 ? 1 : 0);
        if (wgt <= 0) continue;
        acc += wgt * src[yy * w + xx];
        norm += wgt;
      }
    }
    out[y * w + x] = norm > 0 ? acc / norm : src[y * w + x];
  }
}

/** Transpose of conicFilter. Not symmetric at the edges because of the per-pixel normalization. */
export function conicFilterTranspose(v: Float32Array, out: Float32Array, shape: DesignShape, radius: number): void {
  const { w, h } = shape;
  const r = Math.max(0, Math.ceil(radius));
  out.fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // Compute norm for output pixel i = (x, y), then scatter.
    let norm = 0;
    for (let dy = -r; dy <= r; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx; if (xx < 0 || xx >= w) continue;
        const wgt = radius > 0 ? Math.max(0, 1 - Math.hypot(dx, dy) / radius) : (dx === 0 && dy === 0 ? 1 : 0);
        norm += wgt;
      }
    }
    if (norm <= 0) { out[y * w + x] += v[y * w + x]; continue; }
    const vi = v[y * w + x] / norm;
    for (let dy = -r; dy <= r; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx; if (xx < 0 || xx >= w) continue;
        const wgt = radius > 0 ? Math.max(0, 1 - Math.hypot(dx, dy) / radius) : (dx === 0 && dy === 0 ? 1 : 0);
        if (wgt > 0) out[yy * w + xx] += wgt * vi;
      }
    }
  }
}

/** Smoothed Heaviside projection with threshold eta and sharpness beta. */
export function project(rhoTilde: Float32Array, out: Float32Array, beta: number, eta = 0.5): void {
  const denom = Math.tanh(beta * eta) + Math.tanh(beta * (1 - eta));
  const a = Math.tanh(beta * eta);
  for (let k = 0; k < rhoTilde.length; k++) out[k] = (a + Math.tanh(beta * (rhoTilde[k] - eta))) / denom;
}

/** d(rhoHat)/d(rhoTilde), elementwise. */
export function projectDerivative(rhoTilde: Float32Array, out: Float32Array, beta: number, eta = 0.5): void {
  const denom = Math.tanh(beta * eta) + Math.tanh(beta * (1 - eta));
  for (let k = 0; k < rhoTilde.length; k++) {
    const c = Math.cosh(beta * (rhoTilde[k] - eta));
    out[k] = beta / (c * c) / denom;
  }
}

export interface ParamResult { rhoTilde: Float32Array; rhoHat: Float32Array }

/** rho -> (rhoTilde, rhoHat). */
export function forwardParam(rho: Float32Array, shape: DesignShape, radius: number, beta: number, eta = 0.5): ParamResult {
  const rhoTilde = new Float32Array(rho.length);
  const rhoHat = new Float32Array(rho.length);
  conicFilter(rho, rhoTilde, shape, radius);
  project(rhoTilde, rhoHat, beta, eta);
  return { rhoTilde, rhoHat };
}

/** Chain rule: dJ/dRho from dJ/dRhoHat. */
export function backwardParam(gRhoHat: Float32Array, rhoTilde: Float32Array, shape: DesignShape, radius: number, beta: number, eta = 0.5): Float32Array {
  const dproj = new Float32Array(rhoTilde.length);
  projectDerivative(rhoTilde, dproj, beta, eta);
  const gTilde = new Float32Array(rhoTilde.length);
  for (let k = 0; k < gTilde.length; k++) gTilde[k] = gRhoHat[k] * dproj[k];
  const gRho = new Float32Array(rhoTilde.length);
  conicFilterTranspose(gTilde, gRho, shape, radius);
  return gRho;
}
