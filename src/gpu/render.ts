import type { Scene } from '../core/types';
import { compileProgram, createFloatTexture } from './gl-fdtd';
import { VERT, FRAG_DISPLAY } from './shaders';

export type ViewMode = 'field' | 'intensity' | 'materials';

/** Draws the field texture to the default framebuffer with a colormap and material overlay. */
export class GlRenderer {
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private mat: WebGLTexture | null = null;
  private matSize: [number, number] = [0, 0];
  private uni: Record<string, WebGLUniformLocation | null> = {};

  constructor(readonly gl: WebGL2RenderingContext) {
    this.prog = compileProgram(gl, VERT, FRAG_DISPLAY);
    this.vao = gl.createVertexArray()!;
    for (const u of ['uField', 'uDft', 'uMat', 'uSize', 'uMode', 'uScale', 'uEpsMax', 'uView', 'uDark']) this.uni[u] = gl.getUniformLocation(this.prog, u);
  }

  /** Upload (eps, sigma, pmlMask) for the overlay. Call whenever the scene changes. */
  updateMaterials(scene: Scene): void {
    const gl = this.gl;
    const { nx, ny } = scene;
    const data = new Float32Array(nx * ny * 4);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      data[4 * k] = scene.eps[k];
      data[4 * k + 1] = scene.sigma[k];
      data[4 * k + 2] = i < scene.pml || j < scene.pml || i >= nx - scene.pml || j >= ny - scene.pml ? 1 : 0;
    }
    if (!this.mat || this.matSize[0] !== nx || this.matSize[1] !== ny) {
      if (this.mat) gl.deleteTexture(this.mat);
      this.mat = createFloatTexture(gl, nx, ny, data);
      this.matSize = [nx, ny];
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.mat);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, nx, ny, gl.RGBA, gl.FLOAT, data);
    }
  }

  render(field: WebGLTexture, dft: WebGLTexture | null, nx: number, ny: number, mode: ViewMode, scale: number, epsMax: number, width: number, height: number): void {
    const gl = this.gl;
    if (!this.mat) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    const bind = (unit: number, tex: WebGLTexture, name: string) => {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(this.uni[name], unit);
    };
    bind(0, field, 'uField');
    bind(1, dft ?? field, 'uDft');
    bind(2, this.mat, 'uMat');
    gl.uniform2i(this.uni['uSize'], nx, ny);
    gl.uniform1i(this.uni['uMode'], mode === 'field' ? 0 : mode === 'intensity' ? 1 : 2);
    gl.uniform1f(this.uni['uScale'], scale);
    gl.uniform1f(this.uni['uEpsMax'], epsMax);
    gl.uniform2f(this.uni['uView'], width, height);
    gl.uniform1i(this.uni['uDark'], 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    this.gl.deleteProgram(this.prog);
    this.gl.deleteVertexArray(this.vao);
    if (this.mat) this.gl.deleteTexture(this.mat);
  }
}
