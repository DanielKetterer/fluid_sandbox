// Editing primitives shared by the UI and the built-in examples.

import { FLUID, WALL, GOAL, INFLOW } from './state.js';

export const Q_MAX = 600;     // full-strength source flow rate, cells^2 / s
export const CURL_MAX = 50;   // full-strength curl peak speed, cells / s

export function forDisk(sc, cx, cy, r, fn) {
  const rr = Math.max(0.5, r);
  const i0 = Math.max(0, Math.floor(cx - rr)), i1 = Math.min(sc.nx - 1, Math.floor(cx + rr));
  const j0 = Math.max(0, Math.floor(cy - rr)), j1 = Math.min(sc.ny - 1, Math.floor(cy + rr));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const dx = i + 0.5 - cx, dy = j + 0.5 - cy;
      if (dx * dx + dy * dy <= rr * rr) fn(i + j * sc.nx, i, j);
    }
  }
}

export function setCell(sc, c, el, vx = 0, vy = 0) {
  switch (el) {
    case FLUID:
      sc.type[c] = FLUID; sc.vx[c] = 0; sc.vy[c] = 0; sc.q[c] = 0; break;
    case WALL:
      sc.type[c] = WALL; sc.vx[c] = 0; sc.vy[c] = 0; sc.q[c] = 0; break;
    case GOAL:
      sc.type[c] = GOAL; break;
    case INFLOW:
      sc.type[c] = INFLOW; sc.vx[c] = vx; sc.vy[c] = vy; sc.q[c] = 0; break;
  }
}

export function paintDisk(sc, el, cx, cy, r, vx = 0, vy = 0) {
  forDisk(sc, cx, cy, r, c => setCell(sc, c, el, vx, vy));
}

export function paintSegment(sc, el, x0, y0, x1, y1, r, vx = 0, vy = 0) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const step = Math.max(0.35, r * 0.4);
  const n = Math.max(1, Math.ceil(d / step));
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    paintDisk(sc, el, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, vx, vy);
  }
}

export function paintRect(sc, el, i0, j0, i1, j1, vx = 0, vy = 0) {
  for (let j = Math.max(0, j0); j <= Math.min(sc.ny - 1, j1); j++) {
    for (let i = Math.max(0, i0); i <= Math.min(sc.nx - 1, i1); i++) {
      setCell(sc, i + j * sc.nx, el, vx, vy);
    }
  }
}

// Comb: set velocity of non-wall cells in a disk.
export function combDisk(sc, cx, cy, r, vx, vy) {
  forDisk(sc, cx, cy, r, c => {
    if (sc.type[c] === WALL) return;
    sc.vx[c] = vx; sc.vy[c] = vy;
  });
}

export function combSegment(sc, x0, y0, x1, y1, r, vx, vy) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const step = Math.max(0.35, r * 0.4);
  const n = Math.max(1, Math.ceil(d / step));
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    combDisk(sc, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, vx, vy);
  }
}

// Source (Q > 0) or sink (Q < 0): add a Gaussian mass source with total
// flow rate Q (cells^2/s) and radius R to the open-fluid cells.
export function stampDivergence(sc, cx, cy, R, Q) {
  R = Math.max(1.5, R);
  const cells = [], ws = [];
  let sum = 0;
  forDisk(sc, cx, cy, 2.5 * R, (c, i, j) => {
    const t = sc.type[c];
    if (t === WALL || t === INFLOW) return;
    const dx = i + 0.5 - cx, dy = j + 0.5 - cy;
    const w = Math.exp(-(dx * dx + dy * dy) / (R * R));
    cells.push(c); ws.push(w); sum += w;
  });
  if (sum <= 0) return false;
  for (let k = 0; k < cells.length; k++) sc.q[cells[k]] += Q * ws[k] / sum;
  sc.markers.push({ kind: Q > 0 ? 'source' : 'sink', x: cx, y: cy, r: R });
  return true;
}

// Curl: add a smooth vortex to the painted field. Peak tangential speed S
// at radius R; S > 0 is counterclockwise on screen (y down).
export function stampCurl(sc, cx, cy, R, S) {
  R = Math.max(1.5, R);
  let any = false;
  forDisk(sc, cx, cy, 3.5 * R, (c, i, j) => {
    if (sc.type[c] === WALL) return;
    const dx = i + 0.5 - cx, dy = j + 0.5 - cy;
    const r = Math.hypot(dx, dy);
    if (r < 1e-6) return;
    const s = r / R;
    // smooth taper to zero between 2.5R and 3.5R so the edge leaves no ring
    const taper = s < 2.5 ? 1 : 0.5 * (1 + Math.cos(Math.PI * Math.min(1, s - 2.5)));
    const vt = S * s * Math.exp(0.5 * (1 - s * s)) * taper;
    // counterclockwise-on-screen tangent at (dx, dy) is (dy, -dx) / r
    sc.vx[c] += vt * dy / r;
    sc.vy[c] += vt * -dx / r;
    any = true;
  });
  if (any) sc.markers.push({ kind: 'curl', x: cx, y: cy, r: R });
  return any;
}
