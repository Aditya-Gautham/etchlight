/**
 * WebGL2 implementation of the same 2D TM FDTD scheme as src/core/fdtd.ts.
 * Fields live in an RGBA32F texture (Ezx, Ezy, Hx, Hy); each time step is two
 * fragment-shader passes (H update, then E update + sources), plus optional
 * passes for the whole-grid DFT and the point-monitor DFTs. Update
 * coefficients are computed on the CPU by the shared `computeCoefficients`
 * so the two engines integrate identical difference equations; the e2e
 * parity test checks they agree to float precision.
 */
import type { Scene } from '../core/types';
import type { FdtdOptions } from '../core/fdtd';
import type { FieldRunner } from '../core/engine';
import { computeCoefficients } from '../core/coefficients';
import { expandSources } from '../core/sources';
import { waveformParams, waveformEnvelope, waveformTheta, type WaveformParams } from '../core/waveform';
import { VERT, FRAG_H, FRAG_E, FRAG_DFT, FRAG_MON, MAX_MONITORS, MAX_MON_FREQS } from './shaders';

export function compileProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const mk = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(sh));
    return sh;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
  return prog;
}

export function createFloatTexture(gl: WebGL2RenderingContext, w: number, h: number, data: Float32Array | null): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
  return tex;
}

function interleave4(n: number, a: Float32Array, b: Float32Array, c: Float32Array, d: Float32Array): Float32Array {
  const out = new Float32Array(n * 4);
  for (let k = 0; k < n; k++) { out[4 * k] = a[k]; out[4 * k + 1] = b[k]; out[4 * k + 2] = c[k]; out[4 * k + 3] = d[k]; }
  return out;
}

export function hasFloatRenderTargets(gl: WebGL2RenderingContext): boolean {
  return gl.getExtension('EXT_color_buffer_float') !== null;
}

export class GlFdtd implements FieldRunner {
  readonly nx: number;
  readonly ny: number;
  readonly dt: number;
  step = 0;
  dftSteps = 0;

  private field: [WebGLTexture, WebGLTexture];
  private fieldFbo: [WebGLFramebuffer, WebGLFramebuffer];
  private cur = 0; // index of the texture holding the current state
  private coefE: WebGLTexture;
  private coefH: WebGLTexture;
  private src: WebGLTexture;
  private dft: [WebGLTexture, WebGLTexture] | null = null;
  private dftFbo: [WebGLFramebuffer, WebGLFramebuffer] | null = null;
  private dftCur = 0;
  private mon: [WebGLTexture, WebGLTexture] | null = null;
  private monFbo: [WebGLFramebuffer, WebGLFramebuffer] | null = null;
  private monCur = 0;
  private nMon = 0;
  private nFreq = 0;
  private progH: WebGLProgram;
  private progE: WebGLProgram;
  private progDft: WebGLProgram | null = null;
  private progMon: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject;
  private wf: WaveformParams;
  readonly omegaDft: number;
  readonly dftStartStep: number;
  private uni: Record<string, WebGLUniformLocation | null> = {};
  private monOmega: Float64Array = new Float64Array(0);
  private monCos = new Float32Array(MAX_MON_FREQS);
  private monSin = new Float32Array(MAX_MON_FREQS);

  constructor(readonly gl: WebGL2RenderingContext, readonly scene: Scene, opts: FdtdOptions = {}) {
    if (!hasFloatRenderTargets(gl)) throw new Error('EXT_color_buffer_float is required');
    const { nx, ny, dt } = scene;
    this.nx = nx; this.ny = ny; this.dt = dt;
    const n = nx * ny;
    this.wf = waveformParams(scene.waveform);
    this.omegaDft = opts.omegaDft ?? this.wf.omega;
    this.dftStartStep = opts.dftStartStep ?? 0;

    const c = computeCoefficients(scene);
    this.coefE = createFloatTexture(gl, nx, ny, interleave4(n, c.caX, c.cbX, c.caY, c.cbY));
    this.coefH = createFloatTexture(gl, nx, ny, interleave4(n, c.daX, c.dbX, c.daY, c.dbY));
    this.src = createFloatTexture(gl, nx, ny, this.sourceData());

    const zeros = new Float32Array(n * 4);
    this.field = [createFloatTexture(gl, nx, ny, zeros), createFloatTexture(gl, nx, ny, zeros)];
    this.fieldFbo = [this.fbo(this.field[0]), this.fbo(this.field[1])];

    this.vao = gl.createVertexArray()!;
    this.progH = compileProgram(gl, VERT, FRAG_H);
    this.progE = compileProgram(gl, VERT, FRAG_E);
    for (const [name, prog] of [['H', this.progH], ['E', this.progE]] as const) {
      for (const u of ['uField', 'uCoefH', 'uCoefE', 'uSrc', 'uSize', 'uEnvCos', 'uEnvSin']) {
        this.uni[name + '.' + u] = gl.getUniformLocation(prog, u);
      }
    }

    if (opts.fullDft) {
      this.dft = [createFloatTexture(gl, nx, ny, zeros), createFloatTexture(gl, nx, ny, zeros)];
      this.dftFbo = [this.fbo(this.dft[0]), this.fbo(this.dft[1])];
      this.progDft = compileProgram(gl, VERT, FRAG_DFT);
      for (const u of ['uField', 'uDft', 'uC', 'uS']) this.uni['D.' + u] = gl.getUniformLocation(this.progDft, u);
    }

    this.nMon = Math.min(MAX_MONITORS, scene.monitors.length);
    this.nFreq = Math.min(MAX_MON_FREQS, scene.monitorLambdas.length);
    if (this.nMon > 0 && this.nFreq > 0) {
      const z = new Float32Array(this.nFreq * this.nMon * 4);
      this.mon = [createFloatTexture(gl, this.nFreq, this.nMon, z), createFloatTexture(gl, this.nFreq, this.nMon, z)];
      this.monFbo = [this.fbo(this.mon[0]), this.fbo(this.mon[1])];
      this.progMon = compileProgram(gl, VERT, FRAG_MON);
      for (const u of ['uField', 'uMon', 'uMonPos', 'uCos', 'uSin']) this.uni['M.' + u] = gl.getUniformLocation(this.progMon, u);
      gl.useProgram(this.progMon);
      const pos = new Int32Array(MAX_MONITORS * 2);
      for (let m = 0; m < this.nMon; m++) { pos[2 * m] = scene.monitors[m].x; pos[2 * m + 1] = scene.monitors[m].y; }
      gl.uniform2iv(this.uni['M.uMonPos'], pos);
      this.monOmega = new Float64Array(this.nFreq);
      for (let f = 0; f < this.nFreq; f++) this.monOmega[f] = (2 * Math.PI) / scene.monitorLambdas[f];
    }
  }

  private sourceData(): Float32Array {
    const { nx, ny, dt, scene } = this;
    const s = expandSources(scene);
    const srcData = new Float32Array(nx * ny * 4);
    for (let i = 0; i < s.index.length; i++) {
      const k = s.index[i];
      srcData[4 * k] = s.amp[i];
      srcData[4 * k + 1] = Math.cos(s.phase[i]);
      srcData[4 * k + 2] = Math.sin(s.phase[i]);
      srcData[4 * k + 3] = dt / scene.eps[k];
    }
    return srcData;
  }

  private upload(tex: WebGLTexture, w: number, h: number, data: Float32Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, data);
  }

  /** Re-upload update coefficients after scene.eps / scene.sigma changed, keeping the fields. */
  updateMaterials(): void {
    const { nx, ny } = this;
    const n = nx * ny;
    const c = computeCoefficients(this.scene);
    this.upload(this.coefE, nx, ny, interleave4(n, c.caX, c.cbX, c.caY, c.cbY));
    this.upload(this.coefH, nx, ny, interleave4(n, c.daX, c.dbX, c.daY, c.dbY));
    this.upload(this.src, nx, ny, this.sourceData());
  }

  /** Clear the DFT accumulators (e.g. after the geometry changed). */
  resetDft(): void {
    const gl = this.gl;
    this.dftSteps = 0;
    const clear = (fbs: WebGLFramebuffer[] | null) => {
      if (!fbs) return;
      for (const fb of fbs) { gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    };
    clear(this.dftFbo); clear(this.monFbo);
  }

  private fbo(tex: WebGLTexture): WebGLFramebuffer {
    const gl = this.gl;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fb;
  }

  get time(): number { return this.step * this.dt; }

  /** Texture holding the current (Ezx, Ezy, Hx, Hy). */
  get fieldTexture(): WebGLTexture { return this.field[this.cur]; }
  /** Texture holding the whole-grid DFT, or null. */
  get dftTexture(): WebGLTexture | null { return this.dft ? this.dft[this.dftCur] : null; }

  private bindTex(unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  advance(): void {
    const gl = this.gl;
    const { nx, ny } = this;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, nx, ny);

    // H pass: field[cur] -> field[1-cur]
    gl.useProgram(this.progH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fieldFbo[1 - this.cur]);
    this.bindTex(0, this.field[this.cur], this.uni['H.uField']);
    this.bindTex(1, this.coefH, this.uni['H.uCoefH']);
    gl.uniform2i(this.uni['H.uSize'], nx, ny);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.cur = 1 - this.cur;

    // E pass + sources: field[cur] -> field[1-cur]
    this.step++;
    const t = this.time;
    gl.useProgram(this.progE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fieldFbo[1 - this.cur]);
    this.bindTex(0, this.field[this.cur], this.uni['E.uField']);
    this.bindTex(1, this.coefE, this.uni['E.uCoefE']);
    this.bindTex(2, this.src, this.uni['E.uSrc']);
    gl.uniform2i(this.uni['E.uSize'], nx, ny);
    const env = waveformEnvelope(this.wf, t), theta = waveformTheta(this.wf, t);
    gl.uniform1f(this.uni['E.uEnvCos'], env * Math.cos(theta));
    gl.uniform1f(this.uni['E.uEnvSin'], env * Math.sin(theta));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.cur = 1 - this.cur;

    if (this.step > this.dftStartStep) {
      this.dftSteps++;
      if (this.dft && this.dftFbo && this.progDft) {
        const w = this.omegaDft * t;
        gl.useProgram(this.progDft);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.dftFbo[1 - this.dftCur]);
        this.bindTex(0, this.field[this.cur], this.uni['D.uField']);
        this.bindTex(1, this.dft[this.dftCur], this.uni['D.uDft']);
        gl.uniform1f(this.uni['D.uC'], Math.cos(w) * this.dt);
        gl.uniform1f(this.uni['D.uS'], -Math.sin(w) * this.dt);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.dftCur = 1 - this.dftCur;
      }
      if (this.mon && this.monFbo && this.progMon) {
        gl.useProgram(this.progMon);
        gl.viewport(0, 0, this.nFreq, this.nMon);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.monFbo[1 - this.monCur]);
        this.bindTex(0, this.field[this.cur], this.uni['M.uField']);
        this.bindTex(1, this.mon[this.monCur], this.uni['M.uMon']);
        for (let f = 0; f < this.nFreq; f++) {
          const w = this.monOmega[f] * t;
          this.monCos[f] = Math.cos(w) * this.dt;
          this.monSin[f] = Math.sin(w) * this.dt;
        }
        gl.uniform1fv(this.uni['M.uCos'], this.monCos);
        gl.uniform1fv(this.uni['M.uSin'], this.monSin);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.monCur = 1 - this.monCur;
        gl.viewport(0, 0, nx, ny);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Steps per chunk before yielding to the event loop in run(). */
  chunk = 400;

  async run(n: number): Promise<void> {
    let done = 0;
    while (done < n) {
      const m = Math.min(this.chunk, n - done);
      for (let i = 0; i < m; i++) this.advance();
      done += m;
      if (done < n && typeof requestAnimationFrame === 'function') {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
    }
  }

  private readTexture(fb: WebGLFramebuffer, w: number, h: number): Float32Array {
    const gl = this.gl;
    const out = new Float32Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  readFields(): { ezx: Float32Array; ezy: Float32Array; hx: Float32Array; hy: Float32Array } {
    const n = this.nx * this.ny;
    const d = this.readTexture(this.fieldFbo[this.cur], this.nx, this.ny);
    const ezx = new Float32Array(n), ezy = new Float32Array(n), hx = new Float32Array(n), hy = new Float32Array(n);
    for (let k = 0; k < n; k++) { ezx[k] = d[4 * k]; ezy[k] = d[4 * k + 1]; hx[k] = d[4 * k + 2]; hy[k] = d[4 * k + 3]; }
    return { ezx, ezy, hx, hy };
  }

  readFullDft(): { re: Float32Array; im: Float32Array } {
    if (!this.dft || !this.dftFbo) throw new Error('fullDft not enabled');
    const n = this.nx * this.ny;
    const d = this.readTexture(this.dftFbo[this.dftCur], this.nx, this.ny);
    const re = new Float32Array(n), im = new Float32Array(n);
    for (let k = 0; k < n; k++) { re[k] = d[4 * k]; im[k] = d[4 * k + 1]; }
    return { re, im };
  }

  readMonitors(): { re: Float32Array[]; im: Float32Array[] } {
    const re: Float32Array[] = [], im: Float32Array[] = [];
    if (!this.mon || !this.monFbo) return { re, im };
    const d = this.readTexture(this.monFbo[this.monCur], this.nFreq, this.nMon);
    for (let m = 0; m < this.nMon; m++) {
      const r = new Float32Array(this.nFreq), i = new Float32Array(this.nFreq);
      for (let f = 0; f < this.nFreq; f++) { r[f] = d[4 * (m * this.nFreq + f)]; i[f] = d[4 * (m * this.nFreq + f) + 1]; }
      re.push(r); im.push(i);
    }
    return { re, im };
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of [...this.field, this.coefE, this.coefH, this.src, ...(this.dft ?? []), ...(this.mon ?? [])]) gl.deleteTexture(t);
    for (const f of [...this.fieldFbo, ...(this.dftFbo ?? []), ...(this.monFbo ?? [])]) gl.deleteFramebuffer(f);
    for (const p of [this.progH, this.progE, this.progDft, this.progMon]) if (p) gl.deleteProgram(p);
    gl.deleteVertexArray(this.vao);
  }
}

/** Engine factory bound to a GL context, for the optimizer. */
export function glEngine(gl: WebGL2RenderingContext) {
  return (scene: Scene, opts: FdtdOptions): FieldRunner => new GlFdtd(gl, scene, opts);
}
