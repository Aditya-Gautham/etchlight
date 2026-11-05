# How etchlight works

This is the physics and numerics behind the app, written so that every
equation can be matched to a line of code. File references are to `src/`.

## 1. Units and the grid

Everything is in normalized units: the speed of light, the vacuum
permittivity and permeability are all 1, and the grid spacing `dx = dy = 1`
cell. A wavelength of `λ` cells has angular frequency `ω = 2π/λ`, and time is
measured in cell transit times. The time step is given as the Courant number
`S = dt/dx`, 0.5 by default. The app shows physical lengths by multiplying by
a user-chosen cell size (25 nm by default, so `λ = 62` cells is 1550 nm).

The solver is 2D with TM polarization: the electric field `Ez` points out of
the screen and the magnetic field `(Hx, Hy)` lies in the plane. On a Yee grid
the components are staggered by half a cell so that every curl is a centred
difference (`core/fdtd.ts`, header comment):

```
Ez(i, j)        integer nodes
Hx(i, j + 1/2)  between Ez(i, j) and Ez(i, j+1)
Hy(i + 1/2, j)  between Ez(i, j) and Ez(i+1, j)
```

Materials are a relative permittivity `ε(i, j)` and an electric conductivity
`σ(i, j)` at the `Ez` nodes. Permeability is 1 everywhere and materials are
non-dispersive. "Metal" in the app is a conductor with `σ = 20`, which gives a
skin depth of about one cell at the default wavelengths.

## 2. Update equations

Maxwell's curl equations in TM form are

```
∂Hx/∂t = -∂Ez/∂y
∂Hy/∂t =  ∂Ez/∂x
ε ∂Ez/∂t + σ Ez = ∂Hy/∂x - ∂Hx/∂y - Jz
```

The leapfrog discretization alternates H and E updates half a step apart. The
loss term is handled semi-implicitly (averaging `Ez` over the old and new
step), which is unconditionally stable for any `σ`. With `a = σ dt / 2ε`:

```
Ez_new = (1 - a)/(1 + a) · Ez_old + (dt/ε)/(1 + a) · (curl H)
```

`core/coefficients.ts` precomputes the two factors per cell (`ca`, `cb` for
E and `da`, `db` for H) so that the inner loop is a handful of multiply-adds.
The same arrays are uploaded as textures to the GPU, which is why the two
engines agree to float precision.

## 3. Perfectly matched layer

Open boundaries are emulated with Berenger's split-field PML
(`core/pml.ts`). Inside the layer `Ez` is split into two parts, `Ez = Ezx +
Ezy`, each damped by a conductivity that depends on one coordinate only:

```
ε ∂Ezx/∂t + σx Ezx =  ∂Hy/∂x        μ ∂Hy/∂t + σ*x Hy =  ∂Ez/∂x
ε ∂Ezy/∂t + σy Ezy = -∂Hx/∂y        μ ∂Hx/∂t + σ*y Hx = -∂Ez/∂y
```

The layer is reflectionless at its interface when the electric and magnetic
conductivities are impedance matched, `σ*/μ = σ/ε`. The code keeps this true
even where a dielectric waveguide runs into the PML by scaling the electric
conductivity by the local `ε` (`coefficients.ts`).

A sudden jump in `σ` would itself reflect, so the conductivity is graded as a
cubic from zero at the inner edge to `σmax` at the outer wall, with `σmax`
chosen from the textbook estimate for a target reflection of 1e-8 at normal
incidence (Taflove and Hagness, 3rd ed., eq. 7.60). The measured reflection
of the 16-cell layer is -54 dB (see `validation.md`); the shortfall from the
design value is the usual discretization error of the graded profile, and
reflection grows at grazing incidence, which is the known weakness of this
PML variant.

To keep the GPU shader branch-free, the split fields are stored everywhere,
not just in the layer; outside it `σx = σy = 0` and the two halves simply add.

## 4. Sources and the DFT

Sources inject a current density. A "soft" source adds `-(dt/ε) Jz` to `Ez`
after the curl update, so existing waves pass through it instead of
reflecting off it as they would from a hard-set field value. Two waveforms
exist (`core/waveform.ts`):

- a Gaussian-modulated pulse `exp(-((t - t0)/τ)²) cos(ω(t - t0) + φ)`, which
  is broadband and is what you want when measuring a spectrum;
- a ramped continuous wave `ramp(t) cos(ωt + φ)` with a smoothstep ramp over
  a few periods, which drives the system to a steady state at one frequency.

A line source is a line of in-phase point sources, which radiates a plane wave
in both directions until diffraction from its ends arrives.

Monitors accumulate a running discrete Fourier transform of `Ez` at a list of
wavelengths, `X(ω) = Σ Ez(t) e^{-iωt} dt`. For a steady CW field
`Ez(t) = Re[E e^{iωt}]` integrated over `N` whole periods this gives
`(NT/2) E`, which is how `core/adjoint.ts` recovers the complex phasor `E`.
The same accumulation over the whole grid at the carrier frequency gives the
intensity view in the app.

## 5. Stability and dispersion

The leapfrog scheme is stable in 2D only when `S ≤ 1/√2`. The test suite runs
the same scene at `S = 0.70` and `S = 0.72` and checks that one stays bounded
and the other blows up.

The Yee scheme is dispersive: numerical waves travel slightly slower than
`c`, by an amount that grows as the wavelength approaches the cell size. The
1D dispersion relation is `sin(k dx/2) = (n dx/dt) sin(ω dt/2)`; at 20 cells
per wavelength and `S = 0.5` the phase velocity error is 0.6%, at 10 cells it
is 1.6%. This matters in two places. First, the Fresnel test had to use a
wavelength of 40 cells in vacuum so that it is still 20 cells inside the n=2
medium; at 10 cells the reflection coefficient came out 5% high, not because
the solver is wrong but because the medium's *numerical* index was 2.03.
Second, the silicon presets use `λ = 62` cells so that the wavelength inside
silicon (n = 3.48) is still 18 cells.

## 6. The adjoint method

Inverse design asks: how should the permittivity in a design region change to
increase an objective `J`, such as the intensity at a target? With thousands
of design cells, finite differences would need thousands of simulations per
step. The adjoint method gets the full gradient from two.

In the frequency domain the TM equation is `A(ε) E = b` with
`A = -∇² - ω²ε` and `b = iω J` (time convention `e^{iωt}`). For an objective
`J = Eᴴ W E` with a diagonal weight `W` over the target cells, a change `δε`
gives `δE = ω² A⁻¹ (δε ∘ E)` and therefore

```
δJ = 2 Re( Eᴴ W δE ) = 2ω² Re Σ_r δε(r) · [Eᴴ W A⁻¹]_r · E(r)
```

Because `A` is symmetric (the discrete curl-curl operator is, and so is the
PML in this formulation; the reciprocity test checks it to 1e-7), the row
vector `Eᴴ W A⁻¹` is the transpose of `λ = A⁻¹ W Ē`, the field produced by a
source `W Ē` placed at the target cells. So

```
dJ/dε(r) = 2ω² Re[ E(r) λ(r) ]
```

where `E` comes from the forward simulation and `λ` from a second, "adjoint"
simulation whose source is the conjugate of the forward field at the targets.
Both are ordinary FDTD runs to steady state followed by a DFT
(`core/adjoint.ts: solvePhasor`, `adjointSources`, `gradientEps`).

### The discrete correction

The derivation above is for the continuous equations; the solver integrates
discrete ones. Two things differ. The leapfrog scheme turns `iω` into
`i ω̃ = (2/dt) sin(ω dt/2)`, and because the source is injected after the curl
update it is effectively sampled half a step late, which multiplies the
source term by `e^{iω dt/2}`. The adjoint source amplitude must divide by the
same factor, `κ = i ω̃ e^{iω dt/2}`, and the gradient uses `ω̃²`.

This is not a cosmetic detail. Before the correction the adjoint gradient
agreed with finite differences to a cosine similarity of 0.9986 and a fitted
scale of 0.976, with per-cell errors up to 80% where the gradient was small.
After it, cosine similarity is 1.00000, the scale is 1.0001 and the largest
per-cell error is 2.6%. The finite-difference check in `tests/adjoint.test.ts`
exists so that the derivation above is verified every time the tests run.

## 7. Parameterization and the optimizer

Optimizing `ε` cell by cell produces designs that are impossible to make and
full of single-pixel features. Following the topology-optimization
literature, the optimizer works on a density `ρ ∈ [0, 1]` per design cell
which passes through two maps before it becomes permittivity
(`core/parameterization.ts`):

1. a conic filter of radius `R` cells, which enforces a minimum feature size;
2. a smoothed Heaviside projection
   `ρ̂ = (tanh(βη) + tanh(β(ρ̃ - η))) / (tanh(βη) + tanh(β(1 - η)))`
   with threshold `η = 0.5`, which pushes the design toward binary as the
   sharpness `β` grows.

Then `ε = εmin + (εmax - εmin) ρ̂`. The chain rule back to `ρ` needs the
transpose of the filter, which is not identical to the filter because of the
per-pixel normalization at the edges; the code applies the true transpose and
a finite-difference test checks it.

The update is Adam with a gradient normalized by its root-mean-square so the
step size is in `ρ` units. `β` starts at 2 and multiplies by 1.4 every 6
iterations up to 64, a schedule in the spirit of Jensen and Sigmund (2011).
The objective is a weighted sum of `|E|²` over target rectangles, with
negative weights for regions the light should avoid.

## 8. GPU implementation

`gpu/gl-fdtd.ts` keeps `(Ezx, Ezy, Hx, Hy)` in one RGBA32F texture and
ping-pongs between two of them. A time step is two full-screen fragment
passes: the H update reads `Ez` at the cell and its right and upper
neighbours; the E update reads `Hy` to the left and `Hx` below and adds the
source. Optional passes accumulate the whole-grid DFT and the point-monitor
DFTs (one texel per monitor and frequency). WebGL2 with the
`EXT_color_buffer_float` extension is enough; no WebGPU is required.

One lesson from the parity test: GPU `cos()` is allowed to be approximate, and
the first version evaluated `cos(ωt + φ)` in the shader. The fields differed
from the CPU by 1e-3 at the source cells. All time-dependent trigonometry is
now evaluated in double precision on the CPU and passed in as uniforms; the
shader only does multiply-adds. The engines now agree to 7e-7 of the peak
field after 600 steps, which is float32 rounding.

## References

- A. Taflove and S. C. Hagness, *Computational Electrodynamics: The
  Finite-Difference Time-Domain Method*, 3rd ed., Artech House, 2005.
- J.-P. Berenger, "A perfectly matched layer for the absorption of
  electromagnetic waves," *J. Comput. Phys.* 114, 185 (1994).
- J. S. Jensen and O. Sigmund, "Topology optimization for nano-photonics,"
  *Laser & Photonics Reviews* 5, 308 (2011).
- A. Y. Piggott et al., "Inverse design and demonstration of a compact and
  broadband on-chip wavelength demultiplexer," *Nature Photonics* 9, 374
  (2015).
- T. W. Hughes et al., "Forward-mode differentiation of Maxwell's equations,"
  *ACS Photonics* 6, 3010 (2019), and the `ceviche` code.
- A. M. Hammond et al., "High-performance hybrid time/frequency-domain
  topology optimization for large-scale photonics inverse design," *Optics
  Express* 30, 4467 (2022), and the Meep adjoint solver.
