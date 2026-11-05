// GLSL ES 3.00 shaders for the WebGL2 solver. Every pass renders a
// full-screen triangle into an RGBA32F texture; texel (i, j) is grid cell
// (i, j), matching the CPU layout k = j*nx + i.

export const VERT = `#version 300 es
void main() {
  // Full-screen triangle from gl_VertexID, no vertex buffer needed.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 o;
`;

/** H update. Field texture layout: (Ezx, Ezy, Hx, Hy). CoefH: (daX, dbX, daY, dbY). */
export const FRAG_H = HEADER + `
uniform sampler2D uField;
uniform sampler2D uCoefH;
uniform ivec2 uSize;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 f = texelFetch(uField, p, 0);
  vec4 c = texelFetch(uCoefH, p, 0);
  float ez = f.x + f.y;
  float ezUp = 0.0, ezRight = 0.0;
  if (p.y + 1 < uSize.y) { vec4 u = texelFetch(uField, p + ivec2(0, 1), 0); ezUp = u.x + u.y; }
  if (p.x + 1 < uSize.x) { vec4 r = texelFetch(uField, p + ivec2(1, 0), 0); ezRight = r.x + r.y; }
  float hx = c.z * f.z - c.w * (ezUp - ez);
  float hy = c.x * f.w + c.y * (ezRight - ez);
  o = vec4(f.x, f.y, hx, hy);
}`;

/**
 * E update + source injection. CoefE: (caX, cbX, caY, cbY).
 * Src: (amp, cos(phase), sin(phase), dt/eps). The time dependence
 * env(t)*cos(theta(t)) and env(t)*sin(theta(t)) is evaluated on the CPU in
 * double precision and passed as uniforms, so the shader only does
 * multiply-adds: cos(theta + phase) = cos(theta)cos(phase) - sin(theta)sin(phase).
 * GPU trig functions are allowed to be approximate, and the error would
 * otherwise show up as a GPU/CPU mismatch at the source cells.
 */
export const FRAG_E = HEADER + `
uniform sampler2D uField;
uniform sampler2D uCoefE;
uniform sampler2D uSrc;
uniform ivec2 uSize;
uniform float uEnvCos;  // env(t) * cos(theta(t))
uniform float uEnvSin;  // env(t) * sin(theta(t))
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 f = texelFetch(uField, p, 0);
  vec4 c = texelFetch(uCoefE, p, 0);
  float hyLeft = p.x > 0 ? texelFetch(uField, p - ivec2(1, 0), 0).w : 0.0;
  float hxDown = p.y > 0 ? texelFetch(uField, p - ivec2(0, 1), 0).z : 0.0;
  float ezx = c.x * f.x + c.y * (f.w - hyLeft);
  float ezy = c.z * f.y - c.w * (f.z - hxDown);
  vec4 s = texelFetch(uSrc, p, 0);
  if (s.x != 0.0) ezx += s.w * s.x * (uEnvCos * s.y - uEnvSin * s.z);
  o = vec4(ezx, ezy, f.z, f.w);
}`;

/** Whole-grid running DFT of Ez: (Re, Im, 0, 0). */
export const FRAG_DFT = HEADER + `
uniform sampler2D uField;
uniform sampler2D uDft;
uniform float uC;  //  cos(w t) dt
uniform float uS;  // -sin(w t) dt
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 f = texelFetch(uField, p, 0);
  vec4 d = texelFetch(uDft, p, 0);
  float ez = f.x + f.y;
  o = vec4(d.x + ez * uC, d.y + ez * uS, 0.0, 0.0);
}`;

export const MAX_MONITORS = 16;
export const MAX_MON_FREQS = 64;

/** Point-monitor DFTs: texel (f, m) accumulates monitor m at frequency f. */
export const FRAG_MON = HEADER + `
uniform sampler2D uField;
uniform sampler2D uMon;
uniform ivec2 uMonPos[${MAX_MONITORS}];
uniform float uCos[${MAX_MON_FREQS}];  // cos(w_f t) dt, computed on the CPU
uniform float uSin[${MAX_MON_FREQS}];  // sin(w_f t) dt
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 f = texelFetch(uField, uMonPos[p.y], 0);
  vec4 d = texelFetch(uMon, p, 0);
  float v = f.x + f.y;
  o = vec4(d.x + v * uCos[p.x], d.y - v * uSin[p.x], 0.0, 0.0);
}`;

/** Display pass: field/intensity colormap with material overlay. */
export const FRAG_DISPLAY = HEADER + `
uniform sampler2D uField;
uniform sampler2D uDft;
uniform sampler2D uMat;    // (eps, sigma, pmlMask, 0)
uniform ivec2 uSize;
uniform int uMode;         // 0 = Ez, 1 = |E|^2 from DFT, 2 = materials only
uniform float uScale;      // colour scale
uniform float uEpsMax;
uniform vec2 uView;        // canvas size in px
uniform int uDark;

vec3 diverging(float v) {
  // blue (-1) -> white (0) -> red (+1)
  v = clamp(v, -1.0, 1.0);
  vec3 neg = vec3(0.10, 0.35, 0.95);
  vec3 pos = vec3(0.95, 0.25, 0.15);
  vec3 mid = uDark == 1 ? vec3(0.08, 0.09, 0.12) : vec3(1.0);
  return v < 0.0 ? mix(mid, neg, -v) : mix(mid, pos, v);
}
vec3 inferno(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.0015, 0.0005, 0.0139);
  vec3 c1 = vec3(0.2582, 0.0386, 0.4065);
  vec3 c2 = vec3(0.5783, 0.1481, 0.4040);
  vec3 c3 = vec3(0.8650, 0.3168, 0.2264);
  vec3 c4 = vec3(0.9876, 0.6453, 0.0399);
  vec3 c5 = vec3(0.9884, 0.9984, 0.6449);
  if (t < 0.2) return mix(c0, c1, t / 0.2);
  if (t < 0.4) return mix(c1, c2, (t - 0.2) / 0.2);
  if (t < 0.6) return mix(c2, c3, (t - 0.4) / 0.2);
  if (t < 0.8) return mix(c3, c4, (t - 0.6) / 0.2);
  return mix(c4, c5, (t - 0.8) / 0.2);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uView;
  ivec2 p = ivec2(uv * vec2(uSize));
  p.y = uSize.y - 1 - p.y;  // cell row 0 is drawn at the top, like a 2D canvas
  p = clamp(p, ivec2(0), uSize - 1);
  vec4 m = texelFetch(uMat, p, 0);
  vec3 col;
  if (uMode == 0) {
    vec4 f = texelFetch(uField, p, 0);
    col = diverging((f.x + f.y) * uScale);
  } else if (uMode == 1) {
    vec4 d = texelFetch(uDft, p, 0);
    float I = (d.x * d.x + d.y * d.y) * uScale;
    col = inferno(log(1.0 + 30.0 * I) / log(31.0));
  } else {
    col = uDark == 1 ? vec3(0.08, 0.09, 0.12) : vec3(1.0);
  }
  // Dielectric: darken proportionally to (eps - 1); metal: grey.
  float d = clamp((m.x - 1.0) / max(uEpsMax - 1.0, 1e-3), 0.0, 1.0);
  col = mix(col, col * (uDark == 1 ? 1.6 : 0.55) + (uDark == 1 ? vec3(0.10) : vec3(0.0)), d * 0.75);
  if (m.y > 0.0) col = mix(col, vec3(0.55, 0.58, 0.62), 0.85);
  // PML: hatch-free dim band.
  if (m.z > 0.0) col = mix(col, uDark == 1 ? vec3(0.03) : vec3(0.82), 0.5);
  o = vec4(col, 1.0);
}`;
