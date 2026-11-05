# validation

Everything here comes out of the test suite:

```bash
npm run validate      # physics tests, prints the measured values
npm run build && npm run e2e   # GPU/CPU parity in headless Chromium
```

## physics (`tests/validation.test.ts`, CPU engine)

| Check | Setup | Measured | Expected | Tolerance |
|---|---|---|---|---|
| Vacuum phase velocity | point source, λ = 20 cells, pulse peak timing between two monitors | 0.9938 c | 1 c (0.994 with numerical dispersion at 20 cells/λ) | 1% |
| Courant limit | same scene at S = 0.70 and S = 0.72 | bounded (6e-3) / NaN | stable below 1/√2 = 0.7071, unstable above | – |
| Fresnel reflection, normal incidence, n = 2 | plane wave from a tall line source, λ = 40 cells, pulse peak amplitudes | \|r\| = 0.3380 | 1/3 = 0.3333 | 0.01 |
| Fresnel transmission | same | \|t\| = 0.6683 | 2/3 = 0.6667 | 0.01 |
| Energy balance R + n·T² | same | 1.0074 | 1 | 0.02 |
| PML reflection | 16-cell cubic-graded layer, normal incidence pulse | -54.1 dB | < -50 dB | – |
| Reciprocity | pulse source and monitor swapped in a scene with dielectric and lossy metal, 3 frequencies | 1.9e-7 to 1.2e-6 relative | 0 | 2e-3 |

The Fresnel test keeps 20 cells per wavelength inside the dielectric on
purpose. At 10 cells |r| came out 0.3506, which is the right answer for the
medium's numerical index (2.03), not a solver bug. See physics.md.

## adjoint (`tests/adjoint.test.ts`)

| Check | Setup | Measured | Tolerance |
|---|---|---|---|
| Adjoint gradient vs central finite differences | 110×70 grid, slab waveguide feeding a 27×35 design region, 8 probe cells, h = 0.02 | cosine similarity 1.00000, fitted scale 1.0001, max per-cell error 2.6% | cosine > 0.999, scale within 2% |
| Parameterization chain rule | conic filter R = 2.5, projection β = 6, 8 probe cells | 0.37% max error | 1% |
| Optimizer makes progress | 5 Adam iterations on the same scene | J: 1.00 → 2.63 → 2.94 → 3.18 → 3.40 | J₅ > 1.2 J₁ |

Without the discrete frequency correction (physics.md) the same check gave
cosine 0.9986 and scale 0.976.

## GPU vs CPU (`e2e/run.mjs`, headless Chromium, SwiftShader)

| Quantity after 600 steps | Relative difference |
|---|---|
| Fields (Ez, Hx, Hy), normalized by peak \|Ez\| | 7.2e-7 |
| Whole-grid DFT | 4.2e-7 |
| Point-monitor DFT | 1.5e-7 |

Scene: dielectric disk, slab, lossy metal blob, a point source and a phase
shifted line source. Tolerance 1e-5. The script also runs three optimizer
iterations on the GPU and checks the objective goes up.

## not validated

- PML at oblique incidence (split-field PML is known to be worse at grazing angles).
- Absolute field amplitudes, all tests use ratios.
- TE, dispersive materials, 3D: not implemented.
