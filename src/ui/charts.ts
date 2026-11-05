/** Minimal line charts on a 2D canvas (spectra and the optimizer objective). */
export interface Series { name: string; color: string; x: number[]; y: number[] }

function prep(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 110;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

export function drawLines(canvas: HTMLCanvasElement, series: Series[], opts: { xLabel: string; yLabel: string; logY?: boolean; yMin?: number }): void {
  const ctx = prep(canvas);
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 110;
  const L = 34, R = 8, T = 8, B = 20;
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const s of series) for (let i = 0; i < s.x.length; i++) {
    const y = opts.logY ? Math.log10(Math.max(1e-12, s.y[i])) : s.y[i];
    xMin = Math.min(xMin, s.x[i]); xMax = Math.max(xMax, s.x[i]); yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
  }
  if (!Number.isFinite(xMin) || xMax === xMin) { xMin = 0; xMax = 1; }
  if (!Number.isFinite(yMin)) { yMin = 0; yMax = 1; }
  if (opts.yMin !== undefined) yMin = Math.min(yMin, opts.yMin);
  if (yMax === yMin) yMax = yMin + 1;
  const X = (x: number) => L + ((x - xMin) / (xMax - xMin)) * (w - L - R);
  const Y = (y: number) => T + (1 - (y - yMin) / (yMax - yMin)) * (h - T - B);
  ctx.strokeStyle = '#2a3140'; ctx.lineWidth = 1;
  ctx.strokeRect(L, T, w - L - R, h - T - B);
  ctx.fillStyle = '#8b94a7'; ctx.font = '10px sans-serif';
  ctx.fillText(opts.xLabel, w - R - ctx.measureText(opts.xLabel).width, h - 6);
  ctx.save(); ctx.translate(10, T + 4); ctx.rotate(-Math.PI / 2); ctx.fillText(opts.yLabel, -ctx.measureText(opts.yLabel).width, 0); ctx.restore();
  const fmt = (v: number) => (opts.logY ? '1e' + v.toFixed(0) : Math.abs(v) >= 100 ? v.toFixed(0) : v.toPrecision(2));
  ctx.fillText(fmt(yMax), 12, T + 10); ctx.fillText(fmt(yMin), 12, h - B);
  ctx.fillText(xMin.toFixed(0), L, h - 6); ctx.fillText(xMax.toFixed(0), X(xMax) - 20, h - 6);
  for (const s of series) {
    ctx.strokeStyle = s.color; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let i = 0; i < s.x.length; i++) {
      const y = opts.logY ? Math.log10(Math.max(1e-12, s.y[i])) : s.y[i];
      if (i === 0) ctx.moveTo(X(s.x[i]), Y(y)); else ctx.lineTo(X(s.x[i]), Y(y));
    }
    ctx.stroke();
  }
}
