// Incompressible Navier-Stokes on a staggered (MAC) grid.
//
//   du/dt + (u . grad) u = -grad p + nu lap u + f
//   div u = q
//
// Splitting per step: forcing -> advection (MacCormack, limited)
// -> implicit viscosity (Jacobi) -> pressure projection (red-black SOR).
// The projection enforces div u = q, so painted sources and sinks are real
// mass sources and drains rather than something the pressure solve erases.
//
// Forcing: painted vectors act as fans. Each free face relaxes toward the
// painted target velocity at FORCE_RATE (1/s), weighted by how much of the
// face touches painted cells.
//
// Inflow cells are prescribed-velocity boundaries. Walls are no-slip.
// Open edges use p = 0 outside the domain, so fluid can leave or enter.

import { FLUID, WALL, GOAL, INFLOW } from './state.js';

const OUT = 255;
export const FORCE_RATE = 5.0;

export class FluidSolver {
  constructor(sc) {
    const nx = sc.nx, ny = sc.ny;
    this.nx = nx;
    this.ny = ny;
    const nu = (nx + 1) * ny;
    const nv = nx * (ny + 1);
    const nc = nx * ny;
    this.u = new Float32Array(nu);
    this.v = new Float32Array(nv);
    this.u2 = new Float32Array(nu);
    this.v2 = new Float32Array(nv);
    this.uHat = new Float32Array(nu);
    this.vHat = new Float32Array(nv);
    this.uMin = new Float32Array(nu);
    this.uMax = new Float32Array(nu);
    this.vMin = new Float32Array(nv);
    this.vMax = new Float32Array(nv);
    this.u0 = new Float32Array(nu);
    this.v0 = new Float32Array(nv);
    this.ubx = new Float32Array(nu);
    this.uby = new Float32Array(nu);
    this.vbx = new Float32Array(nv);
    this.vby = new Float32Array(nv);

    this.uFix = new Uint8Array(nu);
    this.uFixVal = new Float32Array(nu);
    this.vFix = new Uint8Array(nv);
    this.vFixVal = new Float32Array(nv);
    this.uFw = new Float32Array(nu);
    this.uFt = new Float32Array(nu);
    this.vFw = new Float32Array(nv);
    this.vFt = new Float32Array(nv);

    this.p = new Float32Array(nc);
    this.rhs = new Float32Array(nc);
    this.q = new Float32Array(nc);
    this.fluid = new Uint8Array(nc);
    this.nFree = new Uint8Array(nc);
    this.nbr = new Uint8Array(nc);
    this.spin = new Float32Array(nc);

    this.pressureIters = 34;
    this.omega = 1.85;
    this.setup(sc);
  }

  setup(sc) {
    const { nx, ny } = this;
    const open = sc.params.edges === 'open';
    this.open = open;
    const type = sc.type, svx = sc.vx, svy = sc.vy;
    const kind = (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny) ? (open ? OUT : WALL) : type[i + j * nx];
    const isFl = k => k === FLUID || k === GOAL;
    const forced = c => (svx[c] * svx[c] + svy[c] * svy[c]) > 1e-6;

    // u faces: face (i, j) sits between cells (i-1, j) and (i, j)
    const W = nx + 1;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const f = i + j * W;
        const a = kind(i - 1, j), b = kind(i, j);
        this.uFix[f] = 0; this.uFixVal[f] = 0; this.uFw[f] = 0; this.uFt[f] = 0;
        if (a === WALL || b === WALL) {
          this.uFix[f] = 1;
        } else if (a === INFLOW || b === INFLOW) {
          let s = 0, n = 0;
          if (a === INFLOW) { s += svx[(i - 1) + j * nx]; n++; }
          if (b === INFLOW) { s += svx[i + j * nx]; n++; }
          this.uFix[f] = 1;
          this.uFixVal[f] = s / n;
        } else {
          let s = 0, w = 0, tot = 0;
          if (isFl(a)) { tot++; const c = (i - 1) + j * nx; if (forced(c)) { s += svx[c]; w++; } }
          if (isFl(b)) { tot++; const c = i + j * nx; if (forced(c)) { s += svx[c]; w++; } }
          if (w > 0) { this.uFt[f] = s / w; this.uFw[f] = w / tot; }
        }
      }
    }

    // v faces: face (i, j) sits between cells (i, j-1) and (i, j)
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i < nx; i++) {
        const f = i + j * nx;
        const a = kind(i, j - 1), b = kind(i, j);
        this.vFix[f] = 0; this.vFixVal[f] = 0; this.vFw[f] = 0; this.vFt[f] = 0;
        if (a === WALL || b === WALL) {
          this.vFix[f] = 1;
        } else if (a === INFLOW || b === INFLOW) {
          let s = 0, n = 0;
          if (a === INFLOW) { s += svy[i + (j - 1) * nx]; n++; }
          if (b === INFLOW) { s += svy[i + j * nx]; n++; }
          this.vFix[f] = 1;
          this.vFixVal[f] = s / n;
        } else {
          let s = 0, w = 0, tot = 0;
          if (isFl(a)) { tot++; const c = i + (j - 1) * nx; if (forced(c)) { s += svy[c]; w++; } }
          if (isFl(b)) { tot++; const c = i + j * nx; if (forced(c)) { s += svy[c]; w++; } }
          if (w > 0) { this.vFt[f] = s / w; this.vFw[f] = w / tot; }
        }
      }
    }

    // pressure unknowns
    let dirichlet = false;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = i + j * nx;
        const fl = isFl(type[c]);
        this.fluid[c] = fl ? 1 : 0;
        this.q[c] = fl ? sc.q[c] : 0;
        this.p[c] = 0;
        let n = 0, bits = 0;
        if (fl) {
          const nb = [[i + 1, j, 1], [i - 1, j, 2], [i, j + 1, 4], [i, j - 1, 8]];
          for (const [a, b, bit] of nb) {
            const k = kind(a, b);
            if (isFl(k)) { n++; bits |= bit; }
            else if (k === OUT) { n++; dirichlet = true; }
          }
        }
        this.nFree[c] = n;
        this.nbr[c] = bits;
      }
    }
    this.hasDirichlet = dirichlet;

    // initial state: painted field (projected), fixed faces applied
    for (let f = 0; f < this.u.length; f++) this.u[f] = this.uFix[f] ? this.uFixVal[f] : (this.uFw[f] > 0 ? this.uFt[f] : 0);
    for (let f = 0; f < this.v.length; f++) this.v[f] = this.vFix[f] ? this.vFixVal[f] : (this.vFw[f] > 0 ? this.vFt[f] : 0);
    for (let k = 0; k < 20; k++) this.project();
  }

  // ---------- sampling ----------
  // u nodes live at (i, j + 0.5), i in [0, nx], j in [0, ny - 1]
  sampleU(f, x, y) {
    const nx = this.nx, ny = this.ny, W = nx + 1;
    let fx = x, fy = y - 0.5;
    if (fx < 0) fx = 0; else if (fx > nx) fx = nx;
    if (fy < 0) fy = 0; else if (fy > ny - 1) fy = ny - 1;
    let i0 = fx | 0, j0 = fy | 0;
    if (i0 > nx - 1) i0 = nx - 1;
    if (j0 > ny - 2) j0 = ny - 2;
    const tx = fx - i0, ty = fy - j0;
    const k = i0 + j0 * W;
    const a = f[k], b = f[k + 1], c = f[k + W], d = f[k + W + 1];
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }

  // v nodes live at (i + 0.5, j), i in [0, nx - 1], j in [0, ny]
  sampleV(f, x, y) {
    const nx = this.nx, ny = this.ny;
    let fx = x - 0.5, fy = y;
    if (fx < 0) fx = 0; else if (fx > nx - 1) fx = nx - 1;
    if (fy < 0) fy = 0; else if (fy > ny) fy = ny;
    let i0 = fx | 0, j0 = fy | 0;
    if (i0 > nx - 2) i0 = nx - 2;
    if (j0 > ny - 1) j0 = ny - 1;
    const tx = fx - i0, ty = fy - j0;
    const k = i0 + j0 * nx;
    const a = f[k], b = f[k + 1], c = f[k + nx], d = f[k + nx + 1];
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }

  // same as sampleU/sampleV but records the stencil min/max in this._mn/_mx
  sampleUmm(f, x, y) {
    const nx = this.nx, ny = this.ny, W = nx + 1;
    let fx = x, fy = y - 0.5;
    if (fx < 0) fx = 0; else if (fx > nx) fx = nx;
    if (fy < 0) fy = 0; else if (fy > ny - 1) fy = ny - 1;
    let i0 = fx | 0, j0 = fy | 0;
    if (i0 > nx - 1) i0 = nx - 1;
    if (j0 > ny - 2) j0 = ny - 2;
    const tx = fx - i0, ty = fy - j0;
    const k = i0 + j0 * W;
    const a = f[k], b = f[k + 1], c = f[k + W], d = f[k + W + 1];
    this._mn = Math.min(a, b, c, d);
    this._mx = Math.max(a, b, c, d);
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }

  sampleVmm(f, x, y) {
    const nx = this.nx, ny = this.ny;
    let fx = x - 0.5, fy = y;
    if (fx < 0) fx = 0; else if (fx > nx - 1) fx = nx - 1;
    if (fy < 0) fy = 0; else if (fy > ny) fy = ny;
    let i0 = fx | 0, j0 = fy | 0;
    if (i0 > nx - 2) i0 = nx - 2;
    if (j0 > ny - 1) j0 = ny - 1;
    const tx = fx - i0, ty = fy - j0;
    const k = i0 + j0 * nx;
    const a = f[k], b = f[k + 1], c = f[k + nx], d = f[k + nx + 1];
    this._mn = Math.min(a, b, c, d);
    this._mx = Math.max(a, b, c, d);
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }

  velAt(x, y, out) {
    out[0] = this.sampleU(this.u, x, y);
    out[1] = this.sampleV(this.v, x, y);
    return out;
  }

  // ---------- steps ----------
  step(dt, visc) {
    this.applyForcing(dt);
    this.advect(dt);
    if (visc > 1e-5) this.diffuse(dt, visc);
    this.applyFixed();
    this.project();
  }

  applyForcing(dt) {
    const { u, v, uFw, uFt, vFw, vFt } = this;
    for (let f = 0; f < u.length; f++) {
      const w = uFw[f];
      if (w > 0) u[f] += (1 - Math.exp(-FORCE_RATE * w * dt)) * (uFt[f] - u[f]);
    }
    for (let f = 0; f < v.length; f++) {
      const w = vFw[f];
      if (w > 0) v[f] += (1 - Math.exp(-FORCE_RATE * w * dt)) * (vFt[f] - v[f]);
    }
  }

  applyFixed() {
    const { u, v, uFix, uFixVal, vFix, vFixVal } = this;
    for (let f = 0; f < u.length; f++) if (uFix[f]) u[f] = uFixVal[f];
    for (let f = 0; f < v.length; f++) if (vFix[f]) v[f] = vFixVal[f];
  }

  advect(dt) {
    const { nx, ny, u, v, uHat, vHat, uMin, uMax, vMin, vMax, u2, v2, uFix, uFixVal, vFix, vFixVal, ubx, uby, vbx, vby } = this;
    const W = nx + 1;
    const h = 0.5 * dt;

    // pass 1: semi-Lagrangian backward (RK2 midpoint), record limiter bounds
    // and the backtrace displacement for the correction pass
    for (let j = 0; j < ny; j++) {
      const y = j + 0.5;
      for (let i = 0; i <= nx; i++) {
        const f = i + j * W;
        if (uFix[f]) { uHat[f] = uFixVal[f]; continue; }
        const x = i;
        const ax = u[f], ay = this.sampleV(v, x, y);
        const mx = x - h * ax, my = y - h * ay;
        const dx = dt * this.sampleU(u, mx, my), dy = dt * this.sampleV(v, mx, my);
        ubx[f] = dx; uby[f] = dy;
        uHat[f] = this.sampleUmm(u, x - dx, y - dy);
        uMin[f] = this._mn; uMax[f] = this._mx;
      }
    }
    for (let j = 0; j <= ny; j++) {
      const y = j;
      for (let i = 0; i < nx; i++) {
        const f = i + j * nx;
        if (vFix[f]) { vHat[f] = vFixVal[f]; continue; }
        const x = i + 0.5;
        const ax = this.sampleU(u, x, y), ay = v[f];
        const mx = x - h * ax, my = y - h * ay;
        const dx = dt * this.sampleU(u, mx, my), dy = dt * this.sampleV(v, mx, my);
        vbx[f] = dx; vby[f] = dy;
        vHat[f] = this.sampleVmm(v, x - dx, y - dy);
        vMin[f] = this._mn; vMax[f] = this._mx;
      }
    }

    // pass 2: MacCormack correction. The forward trace reuses the backtrace
    // displacement (exact for locally uniform flow), then the result is
    // limited to the stencil range so it cannot create new extrema.
    for (let j = 0; j < ny; j++) {
      const y = j + 0.5;
      for (let i = 0; i <= nx; i++) {
        const f = i + j * W;
        if (uFix[f]) { u2[f] = uFixVal[f]; continue; }
        const back = this.sampleU(uHat, i + ubx[f], y + uby[f]);
        let val = uHat[f] + 0.5 * (u[f] - back);
        if (val < uMin[f] || val > uMax[f]) val = uHat[f];
        u2[f] = val;
      }
    }
    for (let j = 0; j <= ny; j++) {
      const y = j;
      for (let i = 0; i < nx; i++) {
        const f = i + j * nx;
        if (vFix[f]) { v2[f] = vFixVal[f]; continue; }
        const back = this.sampleV(vHat, i + 0.5 + vbx[f], y + vby[f]);
        let val = vHat[f] + 0.5 * (v[f] - back);
        if (val < vMin[f] || val > vMax[f]) val = vHat[f];
        v2[f] = val;
      }
    }
    u.set(u2);
    v.set(v2);
  }

  // Implicit viscosity: (I - nu dt lap) u = u*, Jacobi iterations.
  diffuse(dt, visc) {
    const { nx, ny, open } = this;
    const a = visc * dt;
    const inv = 1 / (1 + 4 * a);
    // Jacobi contraction factor is 4a / (1 + 4a); iterate to ~1e-3.
    const rho = 4 * a * inv;
    const iters = Math.min(24, Math.max(1, Math.ceil(Math.log(1e-3) / Math.log(rho))));
    const W = nx + 1;

    // u faces
    {
      const rhs = this.u0; rhs.set(this.u);
      let cur = this.u, nxt = this.u2;
      const fix = this.uFix;
      for (let it = 0; it < iters; it++) {
        for (let j = 0; j < ny; j++) {
          for (let i = 0; i <= nx; i++) {
            const f = i + j * W;
            if (fix[f]) { nxt[f] = cur[f]; continue; }
            const c = cur[f];
            const L = i > 0 ? cur[f - 1] : c;
            const R = i < nx ? cur[f + 1] : c;
            const U = j > 0 ? cur[f - W] : (open ? c : 0);
            const D = j < ny - 1 ? cur[f + W] : (open ? c : 0);
            nxt[f] = (rhs[f] + a * (L + R + U + D)) * inv;
          }
        }
        const t = cur; cur = nxt; nxt = t;
      }
      if (cur !== this.u) this.u.set(cur);
    }
    // v faces
    {
      const rhs = this.v0; rhs.set(this.v);
      let cur = this.v, nxt = this.v2;
      const fix = this.vFix;
      for (let it = 0; it < iters; it++) {
        for (let j = 0; j <= ny; j++) {
          for (let i = 0; i < nx; i++) {
            const f = i + j * nx;
            if (fix[f]) { nxt[f] = cur[f]; continue; }
            const c = cur[f];
            const L = i > 0 ? cur[f - 1] : (open ? c : 0);
            const R = i < nx - 1 ? cur[f + 1] : (open ? c : 0);
            const U = j > 0 ? cur[f - nx] : c;
            const D = j < ny ? cur[f + nx] : c;
            nxt[f] = (rhs[f] + a * (L + R + U + D)) * inv;
          }
        }
        const t = cur; cur = nxt; nxt = t;
      }
      if (cur !== this.v) this.v.set(cur);
    }
  }

  // Pressure projection: makes div u = q in every fluid cell.
  project() {
    const { nx, ny, u, v, p, rhs, fluid, nFree, nbr, q, uFix, vFix } = this;
    const W = nx + 1;
    let sum = 0, cnt = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = i + j * nx;
        if (!fluid[c]) { rhs[c] = 0; continue; }
        const D = u[i + 1 + j * W] - u[i + j * W] + v[i + (j + 1) * nx] - v[i + j * nx];
        const r = q[c] - D;
        rhs[c] = r;
        sum += r; cnt++;
      }
    }
    // Closed domain: the Neumann problem needs zero net source. Spread any
    // imbalance (e.g. an inflow with no sink) evenly so the solve stays sane.
    if (!this.hasDirichlet && cnt > 0) {
      const m = sum / cnt;
      for (let c = 0; c < rhs.length; c++) if (fluid[c]) rhs[c] -= m;
    }

    const om = this.omega;
    for (let it = 0; it < this.pressureIters; it++) {
      for (let color = 0; color < 2; color++) {
        for (let j = 0; j < ny; j++) {
          let i = (j + color) & 1;
          let c = i + j * nx;
          for (; i < nx; i += 2, c += 2) {
            const n = nFree[c];
            if (n === 0) continue;
            const b = nbr[c];
            let s = rhs[c];
            if (b & 1) s += p[c + 1];
            if (b & 2) s += p[c - 1];
            if (b & 4) s += p[c + nx];
            if (b & 8) s += p[c - nx];
            p[c] += om * (s / n - p[c]);
          }
        }
      }
    }

    // subtract the pressure gradient on free faces (outside open edge: p = 0)
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const f = i + j * W;
        if (uFix[f]) continue;
        const pl = i > 0 ? p[i - 1 + j * nx] : 0;
        const pr = i < nx ? p[i + j * nx] : 0;
        u[f] -= pr - pl;
      }
    }
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i < nx; i++) {
        const f = i + j * nx;
        if (vFix[f]) continue;
        const pt = j > 0 ? p[i + (j - 1) * nx] : 0;
        const pb = j < ny ? p[i + j * nx] : 0;
        v[f] -= pb - pt;
      }
    }
  }

  // Max |div u - q| over fluid cells (diagnostic).
  divergenceError() {
    const { nx, ny, u, v, fluid, q, hasDirichlet } = this;
    const W = nx + 1;
    let mean = 0, cnt = 0;
    if (!hasDirichlet) {
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const c = i + j * nx;
        if (!fluid[c]) continue;
        mean += (u[i + 1 + j * W] - u[i + j * W] + v[i + (j + 1) * nx] - v[i + j * nx]) - q[c];
        cnt++;
      }
      mean = cnt ? mean / cnt : 0;
    }
    let err = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = i + j * nx;
      if (!fluid[c]) continue;
      const D = u[i + 1 + j * W] - u[i + j * W] + v[i + (j + 1) * nx] - v[i + j * nx];
      err = Math.max(err, Math.abs(D - q[c] - mean));
    }
    return err;
  }

  // Cell-centered spin (counterclockwise on screen positive) for display.
  computeSpin() {
    const { nx, ny, u, v, spin, fluid } = this;
    const W = nx + 1;
    spin.fill(0);
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const c = i + j * nx;
        if (!fluid[c]) continue;
        const vR = 0.5 * (v[(i + 1) + j * nx] + v[(i + 1) + (j + 1) * nx]);
        const vL = 0.5 * (v[(i - 1) + j * nx] + v[(i - 1) + (j + 1) * nx]);
        const uD = 0.5 * (u[i + (j + 1) * W] + u[i + 1 + (j + 1) * W]);
        const uU = 0.5 * (u[i + (j - 1) * W] + u[i + 1 + (j - 1) * W]);
        spin[c] = -(0.5 * (vR - vL) - 0.5 * (uD - uU));
      }
    }
    return spin;
  }

  cellVel(i, j, out) {
    const nx = this.nx, W = nx + 1;
    out[0] = 0.5 * (this.u[i + j * W] + this.u[i + 1 + j * W]);
    out[1] = 0.5 * (this.v[i + j * nx] + this.v[i + (j + 1) * nx]);
    return out;
  }
}
