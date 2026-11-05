# how etchlight works

Notes on the physics and numerics, with pointers into `src/`.

## units and grid

c = ε₀ = μ₀ = 1 and dx = dy = 1 cell. A wavelength of λ cells has ω = 2π/λ. Time is in cell transit times and the time step is the Courant number S = dt/dx, 0.5 by default. The app multiplies by a cell size (25 nm default) to show physical lengths, so λ = 62 cells is 1550 nm.

2D, TM polarization: Ez out of the screen, Hx and Hy in plane. Yee staggering (`core/fdtd.ts`):

```
Ez(i, j)        integer nodes
Hx(i, j+1/2)    between Ez(i,j) and Ez(i,j+1)
Hy(i+1/2, j)    between Ez(i,j) and Ez(i+1,j)
```

Materials are ε(i,j) and σ(i,j) at the Ez nodes. μ = 1 everywhere, no dispersion. "Metal" in the app is σ = 20, skin depth about one cell at the default wavelengths.

## update equations

```
∂Hx/∂t = -∂Ez/∂y
∂Hy/∂t =  ∂Ez/∂x
ε ∂Ez/∂t + σ Ez = ∂Hy/∂x - ∂Hx/∂y - Jz
```

Leapfrog, H and E half a step apart. The loss term is semi-implicit (average of old and new Ez), stable for any σ. With a = σ dt / 2ε:

```
Ez_new = (1-a)/(1+a) · Ez_old + (dt/ε)/(1+a) · (curl H)
```

`core/coefficients.ts` precomputes the factors per cell (ca, cb for E; da, db for H). The same arrays get uploaded as textures for the GPU, which is why the two engines match to float precision.

## PML

Berenger split-field PML (`core/pml.ts`). Inside the layer Ez = Ezx + Ezy, each damped by a conductivity along one axis:

```
ε ∂Ezx/∂t + σx Ezx =  ∂Hy/∂x      μ ∂Hy/∂t + σ*x Hy =  ∂Ez/∂x
ε ∂Ezy/∂t + σy Ezy = -∂Hx/∂y      μ ∂Hx/∂t + σ*y Hx = -∂Ez/∂y
```

No reflection at the interface requires σ*/μ = σ/ε. The code scales the electric conductivity by the local ε so this stays true when a waveguide runs into the layer.

σ is graded as a cubic from 0 at the inner edge to σmax at the wall, with σmax from the usual estimate for R = 1e-8 at normal incidence (Taflove & Hagness eq. 7.60). Measured reflection for the 16 cell layer is -54 dB. It gets worse at grazing incidence, which is the known weakness of this PML.

The split fields are stored everywhere, not only inside the layer, so the GPU shader has no branches. Outside the layer σx = σy = 0 and the halves just add.

## sources and DFT

Sources are soft: they add -(dt/ε) Jz to Ez after the curl update, so waves pass through them. Two waveforms (`core/waveform.ts`):

- Gaussian pulse, exp(-((t-t0)/τ)²) cos(ω(t-t0) + φ). Broadband, for spectra.
- Ramped CW, ramp(t) cos(ωt + φ), smoothstep ramp over a few periods. Drives the system to a steady state at one frequency.

A line source is a row of in-phase point sources, which gives a plane wave until the diffraction from its ends arrives.

Monitors accumulate X(ω) = Σ Ez(t) e^{-iωt} dt. For a steady CW field Ez = Re[E e^{iωt}] over N full periods this is (NT/2) E, which is how `core/adjoint.ts` gets the phasor back. The same accumulation over the whole grid at the carrier gives the intensity view.

## stability and dispersion

2D leapfrog needs S ≤ 1/√2. The tests run the same scene at S = 0.70 and 0.72 and check one is bounded and the other blows up.

The scheme is dispersive. 1D: sin(k dx/2) = (n dx/dt) sin(ω dt/2). At 20 cells per wavelength and S = 0.5 the phase velocity error is 0.6%; at 10 cells it is 1.6%. This bit me in the Fresnel test: at 10 cells inside the n=2 medium |r| came out 0.3506 instead of 0.333, because the medium's numerical index was 2.03. The test now uses 40 cells in vacuum (20 inside). The silicon presets use λ = 62 so the wavelength inside silicon is still 18 cells.

## adjoint method

Frequency domain, TM: A(ε) E = b with A = -∇² - ω²ε and b = iωJ (e^{iωt} convention). Objective J = Eᴴ W E, W diagonal over the target cells. A change δε gives δE = ω² A⁻¹ (δε ∘ E), so

```
δJ = 2 Re(Eᴴ W δE) = 2ω² Re Σ_r δε(r) [Eᴴ W A⁻¹]_r E(r)
```

A is symmetric (the reciprocity test checks this to 1e-7, including the PML and lossy material), so Eᴴ W A⁻¹ is the transpose of λ = A⁻¹ W Ē. λ is just the field from a source W Ē at the targets. So

```
dJ/dε(r) = 2ω² Re[E(r) λ(r)]
```

E from the forward run, λ from an "adjoint" run whose source is the conjugate of the forward field at the targets. Both are plain FDTD runs to steady state plus a DFT (`solvePhasor`, `adjointSources`, `gradientEps` in `core/adjoint.ts`).

### discrete correction

The derivation is for the continuous equations and the solver integrates discrete ones. Two differences: leapfrog turns iω into iω̃ = (2/dt) sin(ω dt/2), and injecting the source after the curl update samples it half a step late, which multiplies the source term by e^{iω dt/2}. The adjoint source has to divide by κ = iω̃ e^{iω dt/2}, and the gradient uses ω̃².

Before this correction the gradient had cosine similarity 0.9986 with finite differences and a fitted scale of 0.976, with some cells off by 80%. After: 1.00000, 1.0001, max 2.6%. The finite difference check is in `tests/adjoint.test.ts` so this stays verified.

## parameterization

Optimizing ε cell by cell gives single-pixel junk. Standard topology optimization approach instead (`core/parameterization.ts`): a density ρ ∈ [0,1] per design cell goes through

1. a conic filter of radius R cells (minimum feature size), then
2. a tanh projection ρ̂ = (tanh(βη) + tanh(β(ρ̃-η))) / (tanh(βη) + tanh(β(1-η))), η = 0.5, which pushes toward binary as β grows.

ε = εmin + (εmax - εmin) ρ̂. Backprop needs the transpose of the filter, which isn't the same as the filter at the edges because of per-pixel normalization; the code does the real transpose and there's a finite difference test for it.

Updates are Adam on ρ with the gradient normalized by its RMS. β starts at 2 and multiplies by 1.4 every 6 iterations up to 64 (roughly Jensen & Sigmund 2011). The objective is a weighted sum of |E|² over target rectangles, negative weights for regions to avoid.

## GPU

`gpu/gl-fdtd.ts` keeps (Ezx, Ezy, Hx, Hy) in one RGBA32F texture and ping-pongs between two. A step is two fragment passes: the H pass reads Ez at the cell and its right/upper neighbours, the E pass reads Hy to the left and Hx below and adds the source. Optional passes accumulate the whole-grid DFT and the monitor DFTs (one texel per monitor and frequency). Needs WebGL2 + EXT_color_buffer_float, no WebGPU.

GPU cos() is allowed to be approximate. The first version computed cos(ωt+φ) in the shader and differed from the CPU by 1e-3 at the source cells. Now all time dependent trig runs in double on the CPU and gets passed in as uniforms. The engines agree to 7e-7 of the peak field after 600 steps.

## references

- Taflove, Hagness. Computational Electrodynamics: The Finite-Difference Time-Domain Method, 3rd ed. Artech House, 2005.
- Berenger. A perfectly matched layer for the absorption of electromagnetic waves. J. Comput. Phys. 114, 185 (1994).
- Jensen, Sigmund. Topology optimization for nano-photonics. Laser & Photonics Reviews 5, 308 (2011).
- Piggott et al. Inverse design and demonstration of a compact and broadband on-chip wavelength demultiplexer. Nature Photonics 9, 374 (2015).
- Hughes et al. Forward-mode differentiation of Maxwell's equations. ACS Photonics 6, 3010 (2019). (ceviche)
- Hammond et al. High-performance hybrid time/frequency-domain topology optimization for large-scale photonics inverse design. Optics Express 30, 4467 (2022). (Meep adjoint)
