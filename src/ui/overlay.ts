import type { Scene } from '../core/types';

export interface DragPreview { kind: 'line' | 'rect'; x0: number; y0: number; x1: number; y1: number }

/**
 * Material boundaries as a 1-pixel-per-cell image: a cell is marked where its
 * permittivity or conductivity differs from its right or lower neighbour.
 * Drawn scaled without smoothing, this gives crisp outlines of the device in
 * any view (the same role as the epsilon contours in Meep plots).
 */
export function buildEdgeLayer(scene: Scene, threshold = 0.3): HTMLCanvasElement {
  const { nx, ny, eps, sigma } = scene;
  const c = document.createElement('canvas');
  c.width = nx; c.height = ny;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(nx, ny);
  const d = img.data;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    let edge = false;
    if (i + 1 < nx && (Math.abs(eps[k] - eps[k + 1]) > threshold || (sigma[k] > 0) !== (sigma[k + 1] > 0))) edge = true;
    if (j + 1 < ny && (Math.abs(eps[k] - eps[k + nx]) > threshold || (sigma[k] > 0) !== (sigma[k + nx] > 0))) edge = true;
    if (edge) { d[4 * k] = 235; d[4 * k + 1] = 238; d[4 * k + 2] = 245; d[4 * k + 3] = 255; }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Draws sources, monitors, design region, targets and the brush cursor over the field. */
export function drawOverlay(ctx: CanvasRenderingContext2D, scene: Scene, w: number, h: number, cursor: { x: number; y: number; r: number } | null, drag: DragPreview | null, monitorValues: Map<string, string>, edges: HTMLCanvasElement | null): void {
  ctx.clearRect(0, 0, w, h);
  const sx = w / scene.nx, sy = h / scene.ny;
  const px = (i: number) => (i + 0.5) * sx, py = (j: number) => (j + 0.5) * sy;

  if (edges) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 0.55;
    ctx.drawImage(edges, 0, 0, w, h);
    ctx.restore();
  }

  // PML inner boundary
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(scene.pml * sx, scene.pml * sy, (scene.nx - 2 * scene.pml) * sx, (scene.ny - 2 * scene.pml) * sy);
  ctx.setLineDash([]);

  // Design region
  if (scene.design) {
    const d = scene.design;
    ctx.setLineDash([6, 3]);
    ctx.strokeStyle = '#f2a541';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(d.x0 * sx, d.y0 * sy, (d.x1 - d.x0 + 1) * sx, (d.y1 - d.y0 + 1) * sy);
    ctx.setLineDash([]);
    ctx.fillStyle = '#f2a541';
    ctx.font = '11px sans-serif';
    ctx.fillText('design region', d.x0 * sx + 4, d.y0 * sy - 4);
  }
  // Targets
  for (const t of scene.targets) {
    ctx.strokeStyle = t.weight >= 0 ? '#7bd389' : '#ef6f6c';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(t.x0 * sx, t.y0 * sy, (t.x1 - t.x0 + 1) * sx, (t.y1 - t.y0 + 1) * sy);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(t.weight >= 0 ? 'target' : 'avoid', t.x0 * sx, t.y0 * sy - 4);
  }
  // Sources
  for (const s of scene.sources) {
    ctx.strokeStyle = '#ff8c42';
    ctx.fillStyle = '#ff8c42';
    if (s.kind === 'point') {
      ctx.beginPath(); ctx.arc(px(s.x), py(s.y), 4, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px(s.x), py(s.y)); ctx.lineTo(px(s.x2 ?? s.x), py(s.y2 ?? s.y)); ctx.stroke();
    }
  }
  // Monitors
  for (const m of scene.monitors) {
    ctx.strokeStyle = '#4cc9f0';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(px(m.x), py(m.y), 5, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#4cc9f0';
    ctx.font = '11px sans-serif';
    const v = monitorValues.get(m.name);
    ctx.fillText(m.name + (v ? ' ' + v : ''), px(m.x) + 8, py(m.y) + 4);
  }
  // Drag preview
  if (drag) {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    if (drag.kind === 'line') { ctx.beginPath(); ctx.moveTo(px(drag.x0), py(drag.y0)); ctx.lineTo(px(drag.x1), py(drag.y1)); ctx.stroke(); }
    else {
      const x0 = Math.min(drag.x0, drag.x1), y0 = Math.min(drag.y0, drag.y1);
      ctx.strokeRect(x0 * sx, y0 * sy, (Math.abs(drag.x1 - drag.x0) + 1) * sx, (Math.abs(drag.y1 - drag.y0) + 1) * sy);
    }
    ctx.setLineDash([]);
  }
  // Brush cursor
  if (cursor) {
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(px(cursor.x), py(cursor.y), Math.max(2, cursor.r * sx), 0, Math.PI * 2); ctx.stroke();
  }
}
