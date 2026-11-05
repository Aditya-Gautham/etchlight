import type { Scene, SourceSpec, Waveform } from '../core/types';
import { CpuFdtd } from '../core/fdtd';
import { GlFdtd, glEngine, hasFloatRenderTargets } from '../gpu/gl-fdtd';
import { GlRenderer, type ViewMode } from '../gpu/render';
import { CpuRenderer } from './cpu-render';
import { cpuEngine, type EngineFactory } from '../core/engine';
import { Optimizer, defaultOptimizerSettings, type OptimizerSettings } from '../core/adjoint';
import { sceneToJSON, sceneFromJSON, fillDisk } from '../core/scene';
import { presets, presetById } from '../presets';
import { drawOverlay, type DragPreview } from './overlay';
import { drawLines } from './charts';
import { el, fmtSci } from './dom';

interface Material { name: string; eps: number; sigma: number; color: string }
const MATERIALS: Material[] = [
  { name: 'Vacuum', eps: 1, sigma: 0, color: '#14171f' },
  { name: 'Silica n=1.44', eps: 1.44 ** 2, sigma: 0, color: '#3a4254' },
  { name: 'Glass n=1.5', eps: 2.25, sigma: 0, color: '#4a5570' },
  { name: 'Silicon n=3.48', eps: 3.48 ** 2, sigma: 0, color: '#7f8db0' },
  { name: 'Metal', eps: 1, sigma: 20, color: '#8d9299' },
];

type Tool = 'brush' | 'erase' | 'point' | 'line' | 'monitor' | 'design' | 'target' | 'avoid';
type Engine = GlFdtd | CpuFdtd;

const PALETTE = ['#4cc9f0', '#f2a541', '#7bd389', '#ef6f6c', '#c77dff', '#ffd166'];

export class App {
  scene!: Scene;
  engine: Engine | null = null;
  readonly useGpu: boolean;
  private gl: WebGL2RenderingContext | null = null;
  private glRenderer: GlRenderer | null = null;
  private cpuRenderer: CpuRenderer | null = null;
  private engineFactory: EngineFactory;

  // UI state
  running = true;
  stepsPerFrame = 8;
  view: ViewMode = 'field';
  tool: Tool = 'brush';
  material = 3;
  brushRadius = 4;
  dxNm = 25;
  private fieldScale = 1;
  private intensityScale = 1;
  private frame = 0;
  private stepsThisSecond = 0;
  private lastStatsTime = performance.now();
  private stepsPerSec = 0;
  private cursor: { x: number; y: number; r: number } | null = null;
  private drag: DragPreview | null = null;
  private dragStart: { x: number; y: number } | null = null;
  private painting = false;
  private lastPaint: { x: number; y: number } | null = null;
  private materialsDirty = false;
  private monitorValues = new Map<string, string>();

  // Optimizer
  optimizer: Optimizer | null = null;
  optimizing = false;
  optSettings: OptimizerSettings = { ...defaultOptimizerSettings };
  maxIterations = 60;

  // DOM
  private stage!: HTMLElement;
  private glCanvas!: HTMLCanvasElement;
  private cpuCanvas!: HTMLCanvasElement;
  private overlay!: HTMLCanvasElement;
  private hud!: HTMLElement;
  private toast!: HTMLElement;
  private ui: Record<string, HTMLElement> = {};

  constructor(readonly root: HTMLElement) {
    this.buildDom();
    const gl = this.glCanvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    this.useGpu = !!gl && hasFloatRenderTargets(gl);
    if (this.useGpu && gl) {
      this.gl = gl;
      this.glRenderer = new GlRenderer(gl);
      this.engineFactory = glEngine(gl);
      this.cpuCanvas.style.display = 'none';
    } else {
      this.glCanvas.style.display = 'none';
      this.cpuRenderer = new CpuRenderer(this.cpuCanvas);
      this.engineFactory = cpuEngine;
      this.stepsPerFrame = 3;
    }
    this.bindEvents();
    const params = new URLSearchParams(location.search);
    const initial = params.get('preset') ?? 'inverse-lens';
    this.loadPreset(presetById(initial) ? initial : 'inverse-lens');
    const view = params.get('view');
    if (view === 'field' || view === 'intensity' || view === 'materials') this.setView(view);
    requestAnimationFrame(() => this.loop());
  }

  // ---------------------------------------------------------------- scene / engine

  loadPreset(id: string): void {
    const p = presetById(id);
    if (!p) return;
    this.stopOptimize();
    this.scene = p.build();
    this.dxNm = this.scene.waveform.lambda > 40 ? 25 : 25;
    (this.ui.preset as HTMLSelectElement).value = id;
    this.ui.blurb.textContent = p.blurb;
    this.syncWaveformControls();
    this.rebuildEngine();
    this.optimizer = null;
    this.drawObjectiveChart();
    if (p.optimize) void this.startOptimize();
    history.replaceState(null, '', '?preset=' + id + (this.view !== 'field' ? '&view=' + this.view : ''));
  }

  /** Point monitors sample a band of wavelengths around the carrier in pulse mode. */
  private ensureMonitorLambdas(): void {
    const w = this.scene.waveform;
    if (this.scene.monitors.length === 0) { this.scene.monitorLambdas = []; return; }
    if (w.kind === 'cw') { this.scene.monitorLambdas = [w.lambda]; return; }
    if (this.scene.monitorLambdas.length < 8) {
      this.scene.monitorLambdas = Array.from({ length: 64 }, (_, i) => w.lambda * (0.6 + i * (1.0 / 63)));
    }
  }

  rebuildEngine(): void {
    this.engine?.dispose();
    this.ensureMonitorLambdas();
    this.engine = this.engineFactory(this.scene, { fullDft: true }) as unknown as Engine;
    this.glRenderer?.updateMaterials(this.scene);
    this.materialsDirty = false;
    this.fieldScale = 1; this.intensityScale = 1;
    this.monitorValues.clear();
    this.updateScaleReadout();
  }

  reset(): void { this.rebuildEngine(); }

  private get epsMax(): number {
    let m = 1;
    const e = this.scene.eps;
    for (let k = 0; k < e.length; k += 7) if (e[k] > m) m = e[k];
    return Math.max(m, this.scene.design?.epsMax ?? 1);
  }

  setWaveform(w: Waveform): void {
    this.scene.waveform = w;
    this.rebuildEngine();
  }

  // ---------------------------------------------------------------- main loop

  private loop(): void {
    const eng = this.engine;
    if (eng) {
      if (this.materialsDirty) { eng.updateMaterials(); eng.resetDft(); this.glRenderer?.updateMaterials(this.scene); this.materialsDirty = false; }
      if (this.running) {
        for (let i = 0; i < this.stepsPerFrame; i++) eng.advance();
        this.stepsThisSecond += this.stepsPerFrame;
      }
      this.frame++;
      if (this.frame % 15 === 0) this.autoscale();
      this.render();
      this.updateStats();
    }
    requestAnimationFrame(() => this.loop());
  }

  private autoscale(): void {
    const eng = this.engine; if (!eng) return;
    const { nx, ny, pml } = this.scene;
    let maxE = 0, maxI = 0;
    const inner = (k: number) => { const i = k % nx, j = (k / nx) | 0; return i >= pml && j >= pml && i < nx - pml && j < ny - pml; };
    if (eng instanceof GlFdtd) {
      if (this.view === 'field') {
        const f = eng.readFields();
        for (let k = 0; k < f.ezx.length; k += 3) if (inner(k)) maxE = Math.max(maxE, Math.abs(f.ezx[k] + f.ezy[k]));
      } else if (this.view === 'intensity') {
        const d = eng.readFullDft();
        for (let k = 0; k < d.re.length; k += 3) if (inner(k)) maxI = Math.max(maxI, d.re[k] * d.re[k] + d.im[k] * d.im[k]);
      }
    } else {
      if (this.view === 'field') { for (let k = 0; k < eng.n; k += 3) if (inner(k)) maxE = Math.max(maxE, Math.abs(eng.ezx[k] + eng.ezy[k])); }
      else if (this.view === 'intensity' && eng.fullRe && eng.fullIm) { for (let k = 0; k < eng.n; k += 3) if (inner(k)) maxI = Math.max(maxI, eng.fullRe[k] ** 2 + eng.fullIm[k] ** 2); }
    }
    if (maxE > 0) { const target = 1 / (maxE * 0.65); this.fieldScale += (target - this.fieldScale) * 0.5; }
    if (maxI > 0) { const target = 1 / maxI; this.intensityScale += (target - this.intensityScale) * 0.6; }
    // Monitor readouts (CW mode): phasor amplitude at the carrier.
    if (this.scene.monitors.length && this.scene.waveform.kind === 'cw' && eng.dftSteps > 0) {
      const mon = eng instanceof GlFdtd ? eng.readMonitors() : { re: eng.monRe, im: eng.monIm };
      const norm = 2 / (eng.dftSteps * this.scene.dt);
      this.scene.monitors.forEach((m, i) => {
        if (!mon.re[i]) return;
        this.monitorValues.set(m.name, '|E|=' + fmtSci(Math.hypot(mon.re[i][0], mon.im[i][0]) * norm));
      });
    } else if (this.scene.monitors.length && this.scene.waveform.kind === 'pulse' && this.frame % 45 === 0) {
      this.drawSpectrum();
    }
  }

  private render(): void {
    const eng = this.engine; if (!eng) return;
    const { nx, ny } = this.scene;
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    // Keep the aspect ratio of the grid; letterbox inside the stage.
    const aspect = nx / ny;
    let cw = w, ch = Math.round(w / aspect);
    if (ch > h) { ch = h; cw = Math.round(h * aspect); }
    const left = Math.floor((w - cw) / 2), top = Math.floor((h - ch) / 2);
    for (const c of [this.glCanvas, this.cpuCanvas, this.overlay]) {
      c.style.left = left + 'px'; c.style.top = top + 'px'; c.style.width = cw + 'px'; c.style.height = ch + 'px';
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (eng instanceof GlFdtd && this.glRenderer) {
      const pw = Math.round(cw * dpr), ph = Math.round(ch * dpr);
      if (this.glCanvas.width !== pw || this.glCanvas.height !== ph) { this.glCanvas.width = pw; this.glCanvas.height = ph; }
      const scale = this.view === 'intensity' ? this.intensityScale : this.fieldScale;
      this.glRenderer.render(eng.fieldTexture, eng.dftTexture, nx, ny, this.view, scale, this.epsMax, pw, ph);
    } else if (eng instanceof CpuFdtd && this.cpuRenderer) {
      const scale = this.view === 'intensity' ? this.intensityScale : this.fieldScale;
      this.cpuRenderer.render(eng, this.scene, this.view, scale, this.epsMax);
    }
    const ow = Math.round(cw * dpr), oh = Math.round(ch * dpr);
    if (this.overlay.width !== ow || this.overlay.height !== oh) { this.overlay.width = ow; this.overlay.height = oh; }
    const ctx = this.overlay.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawOverlay(ctx, this.scene, cw, ch, this.cursor, this.drag, this.monitorValues);
  }

  private updateStats(): void {
    const now = performance.now();
    if (now - this.lastStatsTime > 500) {
      this.stepsPerSec = (this.stepsThisSecond * 1000) / (now - this.lastStatsTime);
      this.stepsThisSecond = 0;
      this.lastStatsTime = now;
      const eng = this.engine!;
      const mcells = (this.stepsPerSec * this.scene.nx * this.scene.ny) / 1e6;
      const t = eng.step * this.scene.dt;
      const periods = t / this.scene.waveform.lambda;
      this.hud.textContent = `${this.useGpu ? 'WebGL2' : 'CPU'} · ${this.scene.nx}×${this.scene.ny} · step ${eng.step} · t = ${periods.toFixed(1)} periods · ${this.stepsPerSec.toFixed(0)} steps/s · ${mcells.toFixed(0)} Mcell/s`;
    }
  }

  private drawSpectrum(): void {
    const eng = this.engine; if (!eng || this.scene.monitors.length === 0) return;
    const mon = eng instanceof GlFdtd ? eng.readMonitors() : { re: eng.monRe, im: eng.monIm };
    const lam = this.scene.monitorLambdas;
    const series = this.scene.monitors.map((m, i) => ({
      name: m.name, color: PALETTE[i % PALETTE.length],
      x: lam.map((l) => l * this.dxNm),
      y: lam.map((_, f) => (mon.re[i] ? mon.re[i][f] ** 2 + mon.im[i][f] ** 2 : 0)),
    }));
    let peak = 0; for (const s of series) for (const v of s.y) peak = Math.max(peak, v);
    if (peak > 0) for (const s of series) s.y = s.y.map((v) => v / peak);
    drawLines(this.ui.spectrum as HTMLCanvasElement, series, { xLabel: 'wavelength (nm)', yLabel: '|E|² (norm.)', yMin: 0 });
    this.ui.legend.replaceChildren(...series.map((s) => { const i = el('i'); i.style.background = s.color; return el('span', {}, [i, s.name]); }));
  }

  private drawObjectiveChart(): void {
    const h = this.optimizer?.history ?? [];
    const J0 = h[0] || 1;
    drawLines(this.ui.objective as HTMLCanvasElement, [{ name: 'J', color: '#7bd389', x: h.map((_, i) => i + 1), y: h.map((v) => v / J0) }], { xLabel: 'iteration', yLabel: 'J / J₀', yMin: 0 });
    this.ui.optStatus.textContent = this.optimizer
      ? `iteration ${this.optimizer.iteration}/${this.maxIterations} · J/J₀ = ${(h.length ? h[h.length - 1] / J0 : 1).toFixed(2)} · β = ${this.optimizer.beta.toFixed(1)}${this.optimizing ? ' · running' : ''}`
      : 'no optimization yet';
  }

  // ---------------------------------------------------------------- optimizer

  async startOptimize(): Promise<void> {
    if (this.optimizing) return;
    if (!this.scene.design || this.scene.targets.length === 0) { this.showToast('Mark a design region and at least one target first.'); return; }
    if (this.scene.waveform.kind !== 'cw') { this.setWaveform({ kind: 'cw', lambda: this.scene.waveform.lambda, rampPeriods: 4 }); this.syncWaveformControls(); }
    this.optSettings = { ...this.optSettings, solve: { ...this.optSettings.solve, lambda: this.scene.waveform.lambda } };
    if (!this.optimizer) this.optimizer = new Optimizer(this.scene, this.optSettings, this.engineFactory);
    this.optimizing = true;
    (this.ui.optBtn as HTMLButtonElement).textContent = 'Stop';
    this.running = true;
    try {
      while (this.optimizing && this.optimizer.iteration < this.maxIterations) {
        await this.optimizer.step();
        this.materialsDirty = true;
        this.drawObjectiveChart();
      }
    } catch (e) {
      console.error(e);
      this.showToast('Optimization failed: ' + (e as Error).message);
    }
    this.optimizing = false;
    (this.ui.optBtn as HTMLButtonElement).textContent = 'Optimize';
    this.drawObjectiveChart();
  }

  stopOptimize(): void { this.optimizing = false; }

  clearDesign(): void {
    this.stopOptimize();
    if (!this.scene.design) return;
    const d = this.scene.design;
    for (let j = d.y0; j <= d.y1; j++) for (let i = d.x0; i <= d.x1; i++) { this.scene.eps[j * this.scene.nx + i] = d.epsMin; this.scene.sigma[j * this.scene.nx + i] = 0; }
    this.optimizer = null;
    this.materialsDirty = true;
    this.drawObjectiveChart();
  }

  // ---------------------------------------------------------------- editing

  private cellFromEvent(e: PointerEvent): { x: number; y: number } {
    const r = this.overlay.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * this.scene.nx);
    const y = Math.floor(((e.clientY - r.top) / r.height) * this.scene.ny);
    return { x: Math.max(0, Math.min(this.scene.nx - 1, x)), y: Math.max(0, Math.min(this.scene.ny - 1, y)) };
  }

  private paint(x: number, y: number): void {
    const m = this.tool === 'erase' ? MATERIALS[0] : MATERIALS[this.material];
    const from = this.lastPaint ?? { x, y };
    const n = Math.max(1, Math.ceil(Math.hypot(x - from.x, y - from.y)));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      fillDisk(this.scene, from.x + (x - from.x) * t, from.y + (y - from.y) * t, this.brushRadius, m.eps, m.sigma);
    }
    this.lastPaint = { x, y };
    this.materialsDirty = true;
  }

  private bindEvents(): void {
    const ov = this.overlay;
    ov.addEventListener('pointerdown', (e) => {
      ov.setPointerCapture(e.pointerId);
      const c = this.cellFromEvent(e);
      if (e.button === 2) return;
      switch (this.tool) {
        case 'brush': case 'erase': this.painting = true; this.lastPaint = null; this.paint(c.x, c.y); break;
        case 'point': this.scene.sources.push({ kind: 'point', x: c.x, y: c.y, amp: 1, phase: 0 }); this.rebuildEngine(); break;
        case 'monitor': this.scene.monitors.push({ name: 'm' + (this.scene.monitors.length + 1), x: c.x, y: c.y }); this.rebuildEngine(); break;
        case 'line': case 'design': case 'target': case 'avoid':
          this.dragStart = c; this.drag = { kind: this.tool === 'line' ? 'line' : 'rect', x0: c.x, y0: c.y, x1: c.x, y1: c.y }; break;
      }
    });
    ov.addEventListener('pointermove', (e) => {
      const c = this.cellFromEvent(e);
      this.cursor = this.tool === 'brush' || this.tool === 'erase' ? { x: c.x, y: c.y, r: this.brushRadius } : null;
      if (this.painting) this.paint(c.x, c.y);
      if (this.drag) { this.drag.x1 = c.x; this.drag.y1 = c.y; }
    });
    const finish = (e: PointerEvent) => {
      if (this.painting) { this.painting = false; this.lastPaint = null; }
      if (this.drag && this.dragStart) {
        const d = this.drag; const c = this.cellFromEvent(e);
        const x0 = Math.min(d.x0, c.x), x1 = Math.max(d.x0, c.x), y0 = Math.min(d.y0, c.y), y1 = Math.max(d.y0, c.y);
        if (this.tool === 'line') { const s: SourceSpec = { kind: 'line', x: d.x0, y: d.y0, x2: c.x, y2: c.y, amp: 1, phase: 0 }; this.scene.sources.push(s); this.rebuildEngine(); }
        else if (this.tool === 'design') {
          const prev = this.scene.design;
          const bg = this.scene.eps[y0 * this.scene.nx + x0];
          this.scene.design = { x0, y0, x1, y1, epsMin: prev?.epsMin ?? Math.min(bg, MATERIALS[this.material].eps), epsMax: prev?.epsMax ?? Math.max(bg, MATERIALS[this.material].eps), radius: prev?.radius ?? 2.5 };
          this.optimizer = null; this.drawObjectiveChart();
        } else if (this.tool === 'target' || this.tool === 'avoid') {
          this.scene.targets.push({ x0, y0, x1, y1, weight: this.tool === 'target' ? 1 : -1 }); this.optimizer = null;
        }
        this.drag = null; this.dragStart = null;
      }
    };
    ov.addEventListener('pointerup', finish);
    ov.addEventListener('pointercancel', finish);
    ov.addEventListener('pointerleave', () => { this.cursor = null; });
    ov.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); this.running = !this.running; this.syncRunButton(); }
      else if (e.key === 'r') this.reset();
      else if (e.key === '1') this.setView('field');
      else if (e.key === '2') this.setView('intensity');
      else if (e.key === '3') this.setView('materials');
      else if (e.key === 'b') this.setTool('brush');
      else if (e.key === 'e') this.setTool('erase');
    });
  }

  setView(v: ViewMode): void {
    this.view = v;
    for (const id of ['field', 'intensity', 'materials']) this.ui['view-' + id].classList.toggle('active', id === v);
  }

  setTool(t: Tool): void {
    this.tool = t;
    for (const id of ['brush', 'erase', 'point', 'line', 'monitor', 'design', 'target', 'avoid']) this.ui['tool-' + id].classList.toggle('active', id === t);
  }

  private syncRunButton(): void { (this.ui.run as HTMLButtonElement).textContent = this.running ? 'Pause' : 'Play'; }

  private syncWaveformControls(): void {
    const w = this.scene.waveform;
    (this.ui.wfKind as HTMLSelectElement).value = w.kind;
    (this.ui.lambda as HTMLInputElement).value = String(w.lambda);
    this.ui.lambdaVal.textContent = `${w.lambda} cells`;
    this.updateScaleReadout();
  }

  private updateScaleReadout(): void {
    const w = this.scene.waveform;
    const nm = w.lambda * this.dxNm;
    this.ui.scale.textContent = `λ = ${w.lambda} cells = ${nm >= 1000 ? (nm / 1000).toFixed(2) + ' µm' : nm.toFixed(0) + ' nm'} · grid ${(this.scene.nx * this.dxNm / 1000).toFixed(1)} × ${(this.scene.ny * this.dxNm / 1000).toFixed(1)} µm · PML ${this.scene.pml} cells`;
  }

  showToast(msg: string): void {
    this.toast.textContent = msg; this.toast.classList.add('show');
    setTimeout(() => this.toast.classList.remove('show'), 2500);
  }

  // ---------------------------------------------------------------- export

  exportScene(): void {
    const json = JSON.stringify(sceneToJSON(this.scene));
    const a = el('a', { href: URL.createObjectURL(new Blob([json], { type: 'application/json' })), download: 'etchlight-scene.json' });
    a.click();
  }

  importScene(file: File): void {
    file.text().then((txt) => {
      this.stopOptimize();
      this.scene = sceneFromJSON(JSON.parse(txt));
      this.optimizer = null;
      this.syncWaveformControls();
      this.rebuildEngine();
      this.drawObjectiveChart();
    }).catch((e) => this.showToast('Could not load scene: ' + e));
  }

  // ---------------------------------------------------------------- DOM

  private buildDom(): void {
    const u = this.ui;
    this.glCanvas = el('canvas');
    this.cpuCanvas = el('canvas');
    this.overlay = el('canvas', { class: 'overlay' });
    this.hud = el('div', { class: 'hud' });
    this.toast = el('div', { class: 'toast' });
    this.stage = el('div', { class: 'stage' }, [this.glCanvas, this.cpuCanvas, this.overlay, this.hud, this.toast]);

    const header = el('div', {}, [
      el('h1', {}, ['etch', el('span', { text: 'light' })]),
      el('p', { class: 'tagline', text: 'GPU Maxwell solver and adjoint inverse design for 2D photonics. Draw a device, or let gradient descent draw it.' }),
      el('div', { class: 'links' }, [
        el('a', { href: 'https://github.com/' + (import.meta.env.VITE_REPO ?? 'etchlight/etchlight'), target: '_blank', text: 'Source' }),
        el('a', { href: 'https://github.com/' + (import.meta.env.VITE_REPO ?? 'etchlight/etchlight') + '/blob/main/docs/physics.md', target: '_blank', text: 'How it works' }),
        el('a', { href: 'https://github.com/' + (import.meta.env.VITE_REPO ?? 'etchlight/etchlight') + '/blob/main/docs/validation.md', target: '_blank', text: 'Validation' }),
      ]),
    ]);

    // Presets
    u.preset = el('select');
    for (const p of presets) u.preset.append(el('option', { value: p.id, text: p.name }));
    u.preset.addEventListener('change', () => this.loadPreset((u.preset as HTMLSelectElement).value));
    u.blurb = el('p', { class: 'blurb' });
    const presetSec = el('section', {}, [el('h2', { text: 'Experiment' }), u.preset, u.blurb]);

    // Run controls
    u.run = el('button', { class: 'primary', text: 'Pause' });
    u.run.addEventListener('click', () => { this.running = !this.running; this.syncRunButton(); });
    const stepBtn = el('button', { text: 'Step' }); stepBtn.addEventListener('click', () => { this.running = false; this.syncRunButton(); this.engine?.advance(); });
    const resetBtn = el('button', { text: 'Reset' }); resetBtn.addEventListener('click', () => this.reset());
    const speed = el('input', { type: 'range', min: 1, max: 40, value: this.stepsPerFrame });
    const speedVal = el('span', { class: 'val', text: `${this.stepsPerFrame}/frame` });
    speed.addEventListener('input', () => { this.stepsPerFrame = +speed.value; speedVal.textContent = `${this.stepsPerFrame}/frame`; });
    for (const v of ['field', 'intensity', 'materials'] as ViewMode[]) {
      u['view-' + v] = el('button', { text: v === 'field' ? 'Ez field' : v === 'intensity' ? '|E|² (steady)' : 'Materials' });
      u['view-' + v].addEventListener('click', () => this.setView(v));
    }
    u['view-field'].classList.add('active');
    const runSec = el('section', {}, [
      el('h2', { text: 'Simulation' }),
      el('div', { class: 'row' }, [u.run, stepBtn, resetBtn]),
      el('div', { class: 'row' }, [el('label', { text: 'speed' }), speed, speedVal]),
      el('div', { class: 'row' }, [el('label', { text: 'view' }), u['view-field'], u['view-intensity'], u['view-materials']]),
    ]);

    // Source
    u.wfKind = el('select', {}, [el('option', { value: 'cw', text: 'Continuous wave' }), el('option', { value: 'pulse', text: 'Gaussian pulse (for spectra)' })]);
    u.lambda = el('input', { type: 'range', min: 12, max: 120, value: 24 });
    u.lambdaVal = el('span', { class: 'val' });
    u.scale = el('div', { class: 'blurb' });
    const applyWf = () => {
      const lambda = +(u.lambda as HTMLInputElement).value;
      const kind = (u.wfKind as HTMLSelectElement).value;
      this.setWaveform(kind === 'cw' ? { kind: 'cw', lambda, rampPeriods: 3 } : { kind: 'pulse', lambda, widthPeriods: 1.2 });
      this.syncWaveformControls();
    };
    u.wfKind.addEventListener('change', applyWf);
    u.lambda.addEventListener('change', applyWf);
    u.lambda.addEventListener('input', () => { u.lambdaVal.textContent = `${(u.lambda as HTMLInputElement).value} cells`; });
    const dx = el('input', { type: 'number', min: 1, max: 500, value: this.dxNm });
    dx.addEventListener('change', () => { this.dxNm = +dx.value || 25; this.updateScaleReadout(); });
    const srcSec = el('section', {}, [
      el('h2', { text: 'Source' }),
      el('div', { class: 'row' }, [el('label', { text: 'waveform' }), u.wfKind]),
      el('div', { class: 'row' }, [el('label', { text: 'wavelength' }), u.lambda, u.lambdaVal]),
      el('div', { class: 'row' }, [el('label', { text: 'cell size' }), dx, el('span', { class: 'val', text: 'nm' })]),
      u.scale,
    ]);

    // Tools
    const tools: [Tool, string][] = [['brush', 'Brush'], ['erase', 'Erase'], ['point', 'Point source'], ['line', 'Line source'], ['monitor', 'Monitor'], ['design', 'Design region'], ['target', 'Target'], ['avoid', 'Avoid']];
    const toolGrid = el('div', { class: 'tools' });
    for (const [id, label] of tools) { u['tool-' + id] = el('button', { text: label }); u['tool-' + id].addEventListener('click', () => this.setTool(id)); toolGrid.append(u['tool-' + id]); }
    u['tool-brush'].classList.add('active');
    const swatches = el('div', { class: 'swatches' });
    MATERIALS.forEach((m, i) => {
      const dot = el('span', { class: 'dot' }); dot.style.background = m.color;
      const b = el('button', {}, [dot, m.name]);
      if (i === this.material) b.classList.add('active');
      b.addEventListener('click', () => { this.material = i; this.setTool('brush'); swatches.querySelectorAll('button').forEach((x, j) => x.classList.toggle('active', j === i)); });
      swatches.append(b);
    });
    const radius = el('input', { type: 'range', min: 1, max: 20, value: this.brushRadius });
    const radiusVal = el('span', { class: 'val', text: `${this.brushRadius} cells` });
    radius.addEventListener('input', () => { this.brushRadius = +radius.value; radiusVal.textContent = `${this.brushRadius} cells`; });
    const clearSrc = el('button', { text: 'Clear sources' }); clearSrc.addEventListener('click', () => { this.scene.sources = []; this.rebuildEngine(); });
    const clearMon = el('button', { text: 'Clear monitors' }); clearMon.addEventListener('click', () => { this.scene.monitors = []; this.rebuildEngine(); });
    const clearTargets = el('button', { text: 'Clear targets' }); clearTargets.addEventListener('click', () => { this.scene.targets = []; this.scene.design = null; this.optimizer = null; this.drawObjectiveChart(); });
    const toolSec = el('section', {}, [
      el('h2', { text: 'Draw' }), toolGrid,
      el('div', { class: 'row', style: 'margin-top:8px' }, [swatches]),
      el('div', { class: 'row' }, [el('label', { text: 'brush size' }), radius, radiusVal]),
      el('div', { class: 'row' }, [clearSrc, clearMon, clearTargets]),
      el('p', { class: 'blurb', text: 'Drag on the canvas to draw. Line source, design region and targets are click-and-drag. Shortcuts: space play/pause, r reset, 1/2/3 views, b brush, e erase.' }),
    ]);

    // Spectrum
    u.spectrum = el('canvas', { class: 'chart' });
    u.legend = el('div', { class: 'legend' });
    const specSec = el('section', {}, [el('h2', { text: 'Monitors' }), u.spectrum, u.legend, el('p', { class: 'blurb', text: 'With a pulse source, each monitor accumulates a running DFT and the chart shows its spectrum. With a CW source the phasor amplitude is printed next to the monitor.' })]);

    // Optimizer
    u.optBtn = el('button', { class: 'primary', text: 'Optimize' });
    u.optBtn.addEventListener('click', () => { if (this.optimizing) this.stopOptimize(); else void this.startOptimize(); });
    const clearDesignBtn = el('button', { text: 'Clear design' }); clearDesignBtn.addEventListener('click', () => this.clearDesign());
    const iters = el('input', { type: 'number', min: 1, max: 500, value: this.maxIterations });
    iters.addEventListener('change', () => { this.maxIterations = +iters.value || 60; });
    const lr = el('input', { type: 'number', min: 0.005, max: 0.5, step: 0.005, value: this.optSettings.lr });
    lr.addEventListener('change', () => { this.optSettings = { ...this.optSettings, lr: +lr.value || 0.05 }; if (this.optimizer) (this.optimizer.settings as OptimizerSettings).lr = this.optSettings.lr; });
    u.objective = el('canvas', { class: 'chart' });
    u.optStatus = el('div', { class: 'stats' });
    const optSec = el('section', {}, [
      el('h2', { text: 'Inverse design' }),
      el('div', { class: 'row' }, [u.optBtn, clearDesignBtn]),
      el('div', { class: 'row' }, [el('label', { text: 'iterations' }), iters, el('label', { text: 'step size' }), lr]),
      u.objective, u.optStatus,
      el('p', { class: 'blurb', text: 'Each iteration runs one forward and one adjoint simulation to steady state, then takes an Adam step on the design density. The projection sharpness β grows over time so the design ends up close to binary.' }),
    ]);

    // Export
    const exp = el('button', { text: 'Download scene JSON' }); exp.addEventListener('click', () => this.exportScene());
    const imp = el('input', { type: 'file', accept: 'application/json', style: 'display:none' });
    imp.addEventListener('change', () => { const f = (imp as HTMLInputElement).files?.[0]; if (f) this.importScene(f); });
    const impBtn = el('button', { text: 'Load scene JSON' }); impBtn.addEventListener('click', () => imp.click());
    const ioSec = el('section', {}, [el('h2', { text: 'Scene' }), el('div', { class: 'row' }, [exp, impBtn, imp])]);

    const footer = el('div', { class: 'footer' }, [
      'Units: c = ε₀ = μ₀ = 1, Courant number 0.5, 2D TM polarization (Ez, Hx, Hy). Materials are non-dispersive; metal is a conductor with σ = 20 (skin depth ≈ 1 cell). ',
      this.useGpuHint(),
    ]);

    const panel = el('div', { class: 'panel' }, [header, presetSec, runSec, srcSec, toolSec, optSec, specSec, ioSec, footer]);
    this.root.replaceChildren(this.stage, panel);
  }

  private useGpuHint(): HTMLElement {
    const span = el('span', { class: 'warn' });
    setTimeout(() => { if (!this.useGpu) span.textContent = 'WebGL2 float render targets are not available in this browser, so the CPU engine is used (slower).'; }, 0);
    return span;
  }
}
