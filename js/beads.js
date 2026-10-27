// Finite-size beads carried by the fluid.
//
// Each bead feels Stokes-like drag toward the local fluid velocity with
// response time tau (beadInertia): dv/dt = (u_fluid - v) / tau. Small tau
// gives tracers; large tau gives heavy beads that fling outward on curves.
// Beads collide with walls and with each other (one-way coupled: the fluid
// moves beads, beads do not push the fluid).
//
// A sink drains fluid volume at rate -q per unit area, so a bead sitting in
// a sink cell is removed with the same rate: P(absorb in dt) = 1 - exp(q dt).

import { WALL, GOAL, INFLOW } from './state.js';

const REST_WALL = 0.35;
const REST_BEAD = 0.2;

export class Beads {
  constructor(sc, solver, cap = 4000) {
    this.sc = sc;
    this.solver = solver;
    this.cap = cap;
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.green = new Uint8Array(cap);
    this.count = 0;
    this.emitted = 0;
    this.greenCount = 0;
    this.lost = 0;
    this.acc = 0;
    this.r = sc.params.beadRadius;
    this.tau = Math.max(0.005, sc.params.beadInertia);
    this.rate = sc.params.emissionRate;
    this.open = sc.params.edges === 'open';
    this.tmp = [0, 0];

    // emitters: inflow cells weighted by speed (flux-proportional)
    const cells = [], cum = [];
    let total = 0;
    const { nx, ny } = sc;
    for (let c = 0; c < nx * ny; c++) {
      if (sc.type[c] !== INFLOW) continue;
      const s = Math.hypot(sc.vx[c], sc.vy[c]);
      if (s < 0.05) continue;
      total += s;
      cells.push(c);
      cum.push(total);
    }
    this.emitCells = Int32Array.from(cells);
    this.emitCum = Float64Array.from(cum);
    this.emitTotal = total;

    // spatial hash for bead-bead contacts
    this.hcell = Math.max(1, 2 * this.r);
    this.hw = Math.ceil(nx / this.hcell) + 1;
    this.hh = Math.ceil(ny / this.hcell) + 1;
    this.head = new Int32Array(this.hw * this.hh);
    this.next = new Int32Array(cap);
  }

  spawn() {
    if (this.count >= this.cap || this.emitTotal <= 0) return;
    const t = Math.random() * this.emitTotal;
    let lo = 0, hi = this.emitCum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.emitCum[mid] < t) lo = mid + 1; else hi = mid;
    }
    const c = this.emitCells[lo];
    const nx = this.sc.nx;
    const i = c % nx, j = (c / nx) | 0;
    const k = this.count++;
    this.x[k] = i + Math.random();
    this.y[k] = j + Math.random();
    this.vx[k] = this.sc.vx[c];
    this.vy[k] = this.sc.vy[c];
    this.green[k] = 0;
    this.emitted++;
  }

  remove(k) {
    const last = --this.count;
    if (k !== last) {
      this.x[k] = this.x[last];
      this.y[k] = this.y[last];
      this.vx[k] = this.vx[last];
      this.vy[k] = this.vy[last];
      this.green[k] = this.green[last];
    }
  }

  step(dt) {
    // emission
    if (this.emitTotal > 0) {
      this.acc += this.rate * dt;
      while (this.acc >= 1) { this.acc -= 1; this.spawn(); }
    }
    const n0 = this.count;
    if (n0 === 0) return;

    // substeps so no bead moves more than ~0.35 cells per substep
    let vmax = 0;
    for (let k = 0; k < n0; k++) {
      const s = Math.abs(this.vx[k]) + Math.abs(this.vy[k]);
      if (s > vmax) vmax = s;
    }
    const sub = Math.min(6, Math.max(1, Math.ceil((vmax * dt) / 0.35)));
    const h = dt / sub;
    const a = 1 - Math.exp(-h / this.tau);
    const solver = this.solver, tmp = this.tmp;

    for (let s = 0; s < sub; s++) {
      for (let k = 0; k < this.count; k++) {
        solver.velAt(this.x[k], this.y[k], tmp);
        this.vx[k] += (tmp[0] - this.vx[k]) * a;
        this.vy[k] += (tmp[1] - this.vy[k]) * a;
        this.x[k] += this.vx[k] * h;
        this.y[k] += this.vy[k] * h;
        this.collideWalls(k);
      }
      this.collideBeads();
      for (let k = 0; k < this.count; k++) this.collideWalls(k);
    }

    // bookkeeping: goal, exits, sinks
    const sc = this.sc, nx = sc.nx, ny = sc.ny, type = sc.type, q = solver.q;
    for (let k = this.count - 1; k >= 0; k--) {
      const x = this.x[k], y = this.y[k];
      if (x < 0 || y < 0 || x >= nx || y >= ny) {
        if (this.open) { this.lost++; this.remove(k); continue; }
        this.x[k] = Math.min(nx - 1e-3, Math.max(1e-3, x));
        this.y[k] = Math.min(ny - 1e-3, Math.max(1e-3, y));
      }
      const c = (this.x[k] | 0) + (this.y[k] | 0) * nx;
      if (!this.green[k] && type[c] === GOAL) { this.green[k] = 1; this.greenCount++; }
      const qc = q[c];
      if (qc < 0 && Math.random() < 1 - Math.exp(qc * dt)) { this.lost++; this.remove(k); }
    }
  }

  collideWalls(k) {
    const sc = this.sc, nx = sc.nx, ny = sc.ny, type = sc.type, r = this.r, open = this.open;
    let x = this.x[k], y = this.y[k], vx = this.vx[k], vy = this.vy[k];
    const i0 = Math.floor(x - r), i1 = Math.floor(x + r);
    const j0 = Math.floor(y - r), j1 = Math.floor(y + r);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const outside = i < 0 || j < 0 || i >= nx || j >= ny;
        const solid = outside ? !open : type[i + j * nx] === WALL;
        if (!solid) continue;
        const cx = x < i ? i : (x > i + 1 ? i + 1 : x);
        const cy = y < j ? j : (y > j + 1 ? j + 1 : y);
        let dx = x - cx, dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 >= r * r) continue;
        let nxn, nyn, pen;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          nxn = dx / d; nyn = dy / d; pen = r - d;
        } else {
          // center inside the solid cell: leave through the nearest face
          const l = x - i, rr = i + 1 - x, t = y - j, b = j + 1 - y;
          const m = Math.min(l, rr, t, b);
          if (m === l) { nxn = -1; nyn = 0; pen = l + r; }
          else if (m === rr) { nxn = 1; nyn = 0; pen = rr + r; }
          else if (m === t) { nxn = 0; nyn = -1; pen = t + r; }
          else { nxn = 0; nyn = 1; pen = b + r; }
        }
        x += nxn * pen; y += nyn * pen;
        const vn = vx * nxn + vy * nyn;
        if (vn < 0) { vx -= (1 + REST_WALL) * vn * nxn; vy -= (1 + REST_WALL) * vn * nyn; }
      }
    }
    this.x[k] = x; this.y[k] = y; this.vx[k] = vx; this.vy[k] = vy;
  }

  collideBeads() {
    const n = this.count;
    if (n < 2) return;
    const { head, next, hw, hh, hcell } = this;
    const X = this.x, Y = this.y, VX = this.vx, VY = this.vy;
    const d0 = 2 * this.r, d02 = d0 * d0;
    head.fill(-1);
    for (let k = 0; k < n; k++) {
      let gi = Math.floor(X[k] / hcell), gj = Math.floor(Y[k] / hcell);
      if (gi < 0) gi = 0; else if (gi >= hw) gi = hw - 1;
      if (gj < 0) gj = 0; else if (gj >= hh) gj = hh - 1;
      const b = gi + gj * hw;
      next[k] = head[b];
      head[b] = k;
    }
    for (let k = 0; k < n; k++) {
      let gi = Math.floor(X[k] / hcell), gj = Math.floor(Y[k] / hcell);
      if (gi < 0) gi = 0; else if (gi >= hw) gi = hw - 1;
      if (gj < 0) gj = 0; else if (gj >= hh) gj = hh - 1;
      for (let dj = -1; dj <= 1; dj++) {
        const bj = gj + dj;
        if (bj < 0 || bj >= hh) continue;
        for (let di = -1; di <= 1; di++) {
          const bi = gi + di;
          if (bi < 0 || bi >= hw) continue;
          for (let m = head[bi + bj * hw]; m !== -1; m = next[m]) {
            if (m <= k) continue;
            let dx = X[m] - X[k], dy = Y[m] - Y[k];
            let d2 = dx * dx + dy * dy;
            if (d2 >= d02) continue;
            let d;
            if (d2 < 1e-12) { const a = Math.random() * 6.283; dx = Math.cos(a); dy = Math.sin(a); d = 1e-6; }
            else { d = Math.sqrt(d2); dx /= d; dy /= d; }
            const pen = 0.5 * (d0 - d);
            X[k] -= dx * pen; Y[k] -= dy * pen;
            X[m] += dx * pen; Y[m] += dy * pen;
            const vr = (VX[m] - VX[k]) * dx + (VY[m] - VY[k]) * dy;
            if (vr < 0) {
              const jimp = -0.5 * (1 + REST_BEAD) * vr;
              VX[k] -= jimp * dx; VY[k] -= jimp * dy;
              VX[m] += jimp * dx; VY[m] += jimp * dy;
            }
          }
        }
      }
    }
  }
}
