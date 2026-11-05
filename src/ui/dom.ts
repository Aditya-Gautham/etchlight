/** Tiny DOM helper: el('div', { class: 'row' }, [child, 'text']). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | number | boolean> = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = String(v);
    else if (k === 'text') e.textContent = String(v);
    else if (typeof v === 'boolean') { if (v) e.setAttribute(k, ''); }
    else e.setAttribute(k, String(v));
  }
  for (const c of children) e.append(c);
  return e;
}

export function fmtSci(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1000 || a < 0.01) return v.toExponential(2);
  return v.toPrecision(3);
}
