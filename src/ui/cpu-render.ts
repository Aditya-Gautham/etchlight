import type { Scene } from '../core/types';
import type { CpuFdtd } from '../core/fdtd';
import { diverging, inferno } from './colormap';
import type { ViewMode } from '../gpu/render';

/** Fallback renderer for the CPU engine: colours cells into an ImageData. */
export class CpuRenderer {
  private ctx: CanvasRenderingContext2D;
  private img: ImageData | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  render(f: CpuFdtd, scene: Scene, mode: ViewMode, scale: number, epsMax: number): void {
    const { nx, ny } = scene;
    if (this.canvas.width !== nx || this.canvas.height !== ny) { this.canvas.width = nx; this.canvas.height = ny; this.img = null; }
    if (!this.img) this.img = this.ctx.createImageData(nx, ny);
    const d = this.img.data;
    const pml = scene.pml;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      let c: [number, number, number];
      if (mode === 'field') c = diverging((f.ezx[k] + f.ezy[k]) * scale, true);
      else if (mode === 'intensity' && f.fullRe && f.fullIm) {
        const I = (f.fullRe[k] * f.fullRe[k] + f.fullIm[k] * f.fullIm[k]) * scale;
        c = inferno(Math.log(1 + 60 * I) / Math.log(61));
      } else c = [0.08, 0.09, 0.12];
      const dd = Math.max(0, Math.min(1, (scene.eps[k] - 1) / Math.max(epsMax - 1, 1e-3)));
      if (dd > 0) { const w = dd * 0.75; c = [c[0] * (1 - w) + (c[0] * 1.6 + 0.1) * w, c[1] * (1 - w) + (c[1] * 1.6 + 0.1) * w, c[2] * (1 - w) + (c[2] * 1.6 + 0.1) * w]; }
      if (scene.sigma[k] > 0) c = [c[0] * 0.15 + 0.55 * 0.85, c[1] * 0.15 + 0.58 * 0.85, c[2] * 0.15 + 0.62 * 0.85];
      if (i < pml || j < pml || i >= nx - pml || j >= ny - pml) c = [c[0] * 0.5 + 0.015, c[1] * 0.5 + 0.015, c[2] * 0.5 + 0.015];
      const o = 4 * k;
      d[o] = Math.min(255, c[0] * 255); d[o + 1] = Math.min(255, c[1] * 255); d[o + 2] = Math.min(255, c[2] * 255); d[o + 3] = 255;
    }
    this.ctx.putImageData(this.img, 0, 0);
  }
}
