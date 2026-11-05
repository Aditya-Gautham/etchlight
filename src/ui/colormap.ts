// CPU copies of the colormaps in the display shader (used by the 2D-canvas renderer).
export function diverging(v: number, dark: boolean): [number, number, number] {
  v = Math.max(-1, Math.min(1, v));
  const mid = dark ? [0.08, 0.09, 0.12] : [1, 1, 1];
  const neg = [0.10, 0.35, 0.95], pos = [0.95, 0.25, 0.15];
  const t = Math.abs(v), c = v < 0 ? neg : pos;
  return [mid[0] + (c[0] - mid[0]) * t, mid[1] + (c[1] - mid[1]) * t, mid[2] + (c[2] - mid[2]) * t];
}

const INFERNO = [
  [0.0015, 0.0005, 0.0139], [0.2582, 0.0386, 0.4065], [0.5783, 0.1481, 0.4040],
  [0.8650, 0.3168, 0.2264], [0.9876, 0.6453, 0.0399], [0.9884, 0.9984, 0.6449],
];
export function inferno(t: number): [number, number, number] {
  t = Math.max(0, Math.min(1, t));
  const s = t * 5, i = Math.min(4, Math.floor(s)), f = s - i;
  const a = INFERNO[i], b = INFERNO[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
