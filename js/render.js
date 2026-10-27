// Canvas rendering: tank tint (speed, spin, sources), static elements,
// animated inflow chevrons, marker glyphs, velocity arrows and beads.

import { FLUID, WALL, GOAL, INFLOW } from './state.js';

const INK = [10, 22, 48];
const INK_HI = [26, 52, 98];
const ROSE = [239, 90, 122];
const BLUE = [79, 143, 247];
const AMBER = [242, 165, 65];
const VIOLET = [139, 108, 240];

const WALL_FILL = '#8b9099';
const INFLOW_FILL = '#0b6c7c';
const INFLOW_EDGE = '#3fd0e0';
const CHEVRON = '#a6f4ff';
const BEAD = '#f3ead3';
const BEAD_GREEN = '#3ddc84';

const SPIN_REF = 6;     // 1/s, spin that reaches full tint
const Q_REF = 3;        // 1/s, divergence that reaches full glow
const SPEED_REF = 40;   // cells/s, speed that reaches full brightening
const ARROW_HALF = 10;  // cells/s, speed at which an arrow reaches half length

// slate blue -> pale -> amber
const RAMP_STOPS = [[96, 118, 186], [226, 214, 182], [242, 165, 65]];
const RAMP_N = 24;
const RAMP = [];
for (let k = 0; k < RAMP_N; k++) {
  const t = k / (RAMP_N - 1);
  const seg = t < 0.5 ? 0 : 1;
  const u = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
  const a = RAMP_STOPS[seg], b = RAMP_STOPS[seg + 1];
  RAMP.push(`rgb(${Math.round(a[0] + (b[0] - a[0]) * u)},${Math.round(a[1] + (b[1] - a[1]) * u)},${Math.round(a[2] + (b[2] - a[2]) * u)})`);
}

function mix(out, b, t) {
  out[0] += (b[0] - out[0]) * t;
  out[1] += (b[1] - out[1]) * t;
  out[2] += (b[2] - out[2]) * t;
}

export class Renderer {
  constructor(canvas, frame) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.frame = frame;
    this.staticCanvas = document.createElement('canvas');
    this.tintCanvas = document.createElement('canvas');
    this.tintCtx = this.tintCanvas.getContext('2d');
    this.img = null;
    this.spinBuf = null;
    this.tintVersion = -1;
    this.inflowPath = null;
    this.inflowCells = [];
    this.selPath = null;
    this.cssCell = 6;
    this.reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  layout(sc, availW, availH) {
    const { nx, ny } = sc;
    const cs = Math.max(2, Math.min(availW / nx, availH / ny));
    const cssW = Math.floor(cs * nx), cssH = Math.floor(cs * ny);
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.dpr = dpr;
    this.cssCell = cssW / nx;
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.kx = this.canvas.width / nx;
    this.ky = this.canvas.height / ny;
    this.staticCanvas.width = this.canvas.width;
    this.staticCanvas.height = this.canvas.height;
    if (this.tintCanvas.width !== nx || this.tintCanvas.height !== ny) {
      this.tintCanvas.width = nx;
      this.tintCanvas.height = ny;
      this.img = this.tintCtx.createImageData(nx, ny);
      this.spinBuf = new Float32Array(nx * ny);
    }
    this.tintVersion = -1;
    this.nx = nx; this.ny = ny;
  }

  X(i) { return Math.round(i * this.kx); }
  Y(j) { return Math.round(j * this.ky); }

  // ---------- static layer: walls, goals, inflow base ----------
  rebuildStatic(sc) {
    const g = this.staticCanvas.getContext('2d');
    const { nx, ny, type } = sc;
    g.clearRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);

    const regionPath = t => {
      const p = new Path2D();
      for (let j = 0; j < ny; j++) {
        let i = 0;
        while (i < nx) {
          if (type[i + j * nx] !== t) { i++; continue; }
          const i0 = i;
          while (i < nx && type[i + j * nx] === t) i++;
          const x0 = this.X(i0), x1 = this.X(i), y0 = this.Y(j), y1 = this.Y(j + 1);
          p.rect(x0, y0, x1 - x0, y1 - y0);
        }
      }
      return p;
    };
    const edgePath = t => {
      const p = new Path2D();
      const is = (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny) ? true : type[i + j * nx] === t;
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          if (type[i + j * nx] !== t) continue;
          const x0 = this.X(i), x1 = this.X(i + 1), y0 = this.Y(j), y1 = this.Y(j + 1);
          if (!is(i, j - 1)) { p.moveTo(x0, y0); p.lineTo(x1, y0); }
          if (!is(i, j + 1)) { p.moveTo(x0, y1); p.lineTo(x1, y1); }
          if (!is(i - 1, j)) { p.moveTo(x0, y0); p.lineTo(x0, y1); }
          if (!is(i + 1, j)) { p.moveTo(x1, y0); p.lineTo(x1, y1); }
        }
      }
      return p;
    };

    // walls: gray, black outline drawn inside the wall region
    const wallRegion = regionPath(WALL);
    g.fillStyle = WALL_FILL;
    g.fill(wallRegion);
    g.save();
    g.clip(wallRegion);
    g.strokeStyle = '#000';
    g.lineWidth = 2 * Math.max(1.5 * this.dpr, this.kx * 0.32);
    g.lineJoin = 'miter';
    g.stroke(edgePath(WALL));
    g.restore();

    // goals: black and white checker, squares of 2x2 cells
    for (let parity = 0; parity < 2; parity++) {
      g.fillStyle = parity ? '#000' : '#fff';
      for (let j = 0; j < ny; j++) {
        let i = 0;
        while (i < nx) {
          const c = i + j * nx;
          if (type[c] !== GOAL || (((i >> 1) + (j >> 1)) & 1) !== parity) { i++; continue; }
          const i0 = i;
          while (i < nx && type[i + j * nx] === GOAL && (((i >> 1) + (j >> 1)) & 1) === parity) i++;
          g.fillRect(this.X(i0), this.Y(j), this.X(i) - this.X(i0), this.Y(j + 1) - this.Y(j));
        }
      }
    }
    const goalRegion = regionPath(GOAL);
    g.save();
    g.clip(goalRegion);
    g.strokeStyle = '#fff';
    g.lineWidth = 2 * Math.max(1, this.dpr);
    g.stroke(edgePath(GOAL));
    g.restore();

    // inflow base
    this.inflowPath = regionPath(INFLOW);
    g.fillStyle = INFLOW_FILL;
    g.fill(this.inflowPath);
    g.save();
    g.clip(this.inflowPath);
    g.strokeStyle = INFLOW_EDGE;
    g.lineWidth = 2 * Math.max(1, this.dpr);
    g.stroke(edgePath(INFLOW));
    g.restore();

    // chevron lattice points inside inflow regions
    const A = 4;
    this.inflowCells = [];
    for (let j = (A >> 1); j < ny; j += A) {
      for (let i = (A >> 1); i < nx; i += A) {
        if (type[i + j * nx] === INFLOW) this.inflowCells.push(i + j * nx);
      }
    }
    this.hasInflow = sc.type.includes(INFLOW);
  }

  // Path2D outlining a cell mask (for selections), device pixels.
  maskOutline(sc, mask) {
    const { nx, ny } = sc;
    const p = new Path2D();
    const on = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && mask[i + j * nx];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!mask[i + j * nx]) continue;
        const x0 = this.X(i), x1 = this.X(i + 1), y0 = this.Y(j), y1 = this.Y(j + 1);
        if (!on(i, j - 1)) { p.moveTo(x0, y0); p.lineTo(x1, y0); }
        if (!on(i, j + 1)) { p.moveTo(x0, y1); p.lineTo(x1, y1); }
        if (!on(i - 1, j)) { p.moveTo(x0, y0); p.lineTo(x0, y1); }
        if (!on(i + 1, j)) { p.moveTo(x1, y0); p.lineTo(x1, y1); }
      }
    }
    return p;
  }

  // ---------- tint: speed, spin, divergence ----------
  updateTint(sc, solver) {
    const { nx, ny, type } = sc;
    const data = this.img.data;
    const spin = solver ? solver.computeSpin() : sc.spinField(this.spinBuf);
    const q = sc.q;
    const col = [0, 0, 0];
    const W = nx + 1;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = i + j * nx;
        const o = c * 4;
        const t = type[c];
        col[0] = INK[0]; col[1] = INK[1]; col[2] = INK[2];
        if (t === FLUID || t === GOAL) {
          let ux, uy;
          if (solver) {
            ux = 0.5 * (solver.u[i + j * W] + solver.u[i + 1 + j * W]);
            uy = 0.5 * (solver.v[i + j * nx] + solver.v[i + (j + 1) * nx]);
          } else {
            ux = sc.vx[c]; uy = sc.vy[c];
          }
          const sp = Math.min(1, Math.hypot(ux, uy) / SPEED_REF);
          if (sp > 0) mix(col, INK_HI, sp * 0.9);
          const s = spin[c];
          if (s !== 0) {
            const k = Math.pow(Math.min(1, Math.abs(s) / SPIN_REF), 0.75) * 0.55;
            mix(col, s > 0 ? ROSE : BLUE, k);
          }
          const qc = q[c];
          if (qc !== 0) {
            const k = Math.pow(Math.min(1, Math.abs(qc) / Q_REF), 0.6) * 0.75;
            mix(col, qc > 0 ? AMBER : VIOLET, k);
          }
        }
        data[o] = col[0]; data[o + 1] = col[1]; data[o + 2] = col[2]; data[o + 3] = 255;
      }
    }
    this.tintCtx.putImageData(this.img, 0, 0);
  }

  // ---------- frame ----------
  draw(sc, view) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const t = this.reduced && view.mode !== 'sim' ? 0 : view.time;
    const sim = view.mode !== 'edit' ? view.solver : null;

    if (sim || this.tintVersion !== sc.version) {
      this.updateTint(sc, sim);
      this.tintVersion = sim ? -1 : sc.version;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.tintCanvas, 0, 0, W, H);
    ctx.drawImage(this.staticCanvas, 0, 0);

    this.drawChevrons(sc, t, sim);
    this.drawMarkers(sc, t, !!sim);
    if (view.showArrows) this.drawArrows(sc, sim);
    if (sim && view.beads) this.drawBeads(view.beads);
    if (view.mode === 'edit') this.drawEditOverlay(sc, view, t);
  }

  drawChevrons(sc, t, sim) {
    if (!this.hasInflow || !this.inflowCells.length) return;
    const ctx = this.ctx, kx = this.kx, ky = this.ky, nx = sc.nx;
    const A = 4;
    ctx.save();
    ctx.clip(this.inflowPath);
    ctx.strokeStyle = CHEVRON;
    ctx.lineWidth = Math.max(1.2 * this.dpr, kx * 0.32);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const size = Math.min(A * 0.32, 1.4) * kx;
    for (const c of this.inflowCells) {
      const vx = sc.vx[c], vy = sc.vy[c];
      const s = Math.hypot(vx, vy);
      if (s < 0.05) continue;
      const dx = vx / s, dy = vy / s;
      const i = c % nx, j = (c / nx) | 0;
      const phase = ((t * (0.35 + s * 0.06)) % 1 + 1) % 1;
      const off = (phase - 0.5) * A;
      const cx = (i + 0.5 + dx * off) * kx, cy = (j + 0.5 + dy * off) * ky;
      ctx.globalAlpha = Math.sin(Math.PI * phase) * 0.9;
      // ">" pointing along (dx, dy)
      const px = -dy, py = dx;
      ctx.beginPath();
      ctx.moveTo(cx - dx * size + px * size, cy - dy * size + py * size);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx - dx * size - px * size, cy - dy * size - py * size);
      ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  drawMarkers(sc, t, sim) {
    const ctx = this.ctx, kx = this.kx;
    for (const m of sc.markers) {
      const s = sc.markerStrength(m);
      const cx = m.x * kx, cy = m.y * this.ky, R = m.r * kx;
      ctx.lineWidth = Math.max(1.5 * this.dpr, kx * 0.28);
      ctx.lineCap = 'round';
      if (m.kind === 'curl') {
        if (Math.abs(s) < 0.5) continue;
        const ccw = s > 0;
        const col = ccw ? ROSE : BLUE;
        const a = Math.min(1, Math.abs(s) / 20);
        ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${(sim ? 0.35 : 0.85) * (0.4 + 0.6 * a)})`;
        ctx.fillStyle = ctx.strokeStyle;
        // screen angle grows clockwise (y down), so counterclockwise spin
        // means decreasing angle
        const rot = (ccw ? -1 : 1) * t * 1.2;
        const rr = R * 0.9;
        for (let k = 0; k < 2; k++) {
          const a0 = rot + k * Math.PI;
          const a1 = a0 + (ccw ? -1 : 1) * Math.PI * 0.62;
          ctx.beginPath();
          ctx.arc(cx, cy, rr, a0, a1, ccw);
          ctx.stroke();
          // arrowhead at a1, pointing along the direction of travel
          const hx = cx + rr * Math.cos(a1), hy = cy + rr * Math.sin(a1);
          const tx = (ccw ? 1 : -1) * Math.sin(a1), ty = (ccw ? -1 : 1) * Math.cos(a1);
          const hs = Math.min(9 * this.dpr, Math.max(4 * this.dpr, R * 0.16));
          ctx.beginPath();
          ctx.moveTo(hx + tx * hs, hy + ty * hs);
          ctx.lineTo(hx - tx * hs * 0.2 + (-ty) * hs * 0.55, hy - ty * hs * 0.2 + tx * hs * 0.55);
          ctx.lineTo(hx - tx * hs * 0.2 - (-ty) * hs * 0.55, hy - ty * hs * 0.2 - tx * hs * 0.55);
          ctx.closePath();
          ctx.fill();
        }
      } else {
        if (Math.abs(s) < 2) continue;
        const src = s > 0;
        const col = src ? AMBER : VIOLET;
        const base = sim ? 0.4 : 0.9;
        for (let k = 0; k < 3; k++) {
          let f = ((t * 0.55 + k / 3) % 1 + 1) % 1;
          if (!src) f = 1 - f;
          const rad = R * (0.35 + 1.25 * f);
          const alpha = base * (src ? (1 - f) : f) * 0.9;
          ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${alpha})`;
          ctx.beginPath();
          ctx.arc(cx, cy, rad, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${base})`;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(2 * this.dpr, R * 0.18), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  drawArrows(sc, solver) {
    const ctx = this.ctx, kx = this.kx, ky = this.ky;
    const { nx, ny, type } = sc;
    const A = Math.max(3, Math.round(20 / this.cssCell));
    const maxLen = A * kx * 0.92;
    const buckets = Array.from({ length: RAMP_N }, () => new Path2D());
    const under = new Path2D();
    const dots = new Path2D();
    const tmp = [0, 0];
    const dotR = Math.max(0.8, 0.9 * this.dpr);
    let anyBucket = new Uint8Array(RAMP_N);
    for (let j = A >> 1; j < ny; j += A) {
      for (let i = A >> 1; i < nx; i += A) {
        const c = i + j * nx;
        const tp = type[c];
        if (tp !== FLUID && tp !== GOAL) continue;
        let ux, uy;
        if (solver) { solver.cellVel(i, j, tmp); ux = tmp[0]; uy = tmp[1]; }
        else { ux = sc.vx[c]; uy = sc.vy[c]; }
        const s = Math.hypot(ux, uy);
        const cx = (i + 0.5) * kx, cy = (j + 0.5) * ky;
        if (s < 0.3) {
          dots.moveTo(cx + dotR, cy);
          dots.arc(cx, cy, dotR, 0, Math.PI * 2);
          continue;
        }
        const L = maxLen * s / (s + ARROW_HALF);
        const dx = ux / s, dy = uy / s;
        const x0 = cx - dx * L * 0.5, y0 = cy - dy * L * 0.5;
        const x1 = cx + dx * L * 0.5, y1 = cy + dy * L * 0.5;
        const hs = Math.min(L * 0.42, kx * 1.3 + 2 * this.dpr);
        const px = -dy, py = dx;
        const b = Math.min(RAMP_N - 1, Math.floor(Math.min(1, s / SPEED_REF) * (RAMP_N - 1) + 0.5));
        for (const p of [buckets[b], under]) {
          p.moveTo(x0, y0); p.lineTo(x1, y1);
          p.moveTo(x1 - dx * hs + px * hs * 0.5, y1 - dy * hs + py * hs * 0.5);
          p.lineTo(x1, y1);
          p.lineTo(x1 - dx * hs - px * hs * 0.5, y1 - dy * hs - py * hs * 0.5);
        }
        anyBucket[b] = 1;
      }
    }
    const lw = Math.max(1.1 * this.dpr, kx * 0.2);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = solver ? 0.4 : 0.85;
    ctx.fillStyle = 'rgba(150,165,205,0.45)';
    ctx.fill(dots);
    ctx.strokeStyle = 'rgba(6,12,28,0.85)';
    ctx.lineWidth = lw + 2 * this.dpr;
    ctx.stroke(under);
    ctx.lineWidth = lw;
    for (let b = 0; b < RAMP_N; b++) {
      if (!anyBucket[b]) continue;
      ctx.strokeStyle = RAMP[b];
      ctx.stroke(buckets[b]);
    }
    ctx.globalAlpha = 1;
  }

  drawBeads(beads) {
    const ctx = this.ctx, kx = this.kx, ky = this.ky;
    const r = Math.max(1.2 * this.dpr, beads.r * kx);
    const ivory = new Path2D(), green = new Path2D(), halo = new Path2D();
    for (let k = 0; k < beads.count; k++) {
      const x = beads.x[k] * kx, y = beads.y[k] * ky;
      if (beads.green[k]) {
        green.moveTo(x + r, y); green.arc(x, y, r, 0, Math.PI * 2);
        halo.moveTo(x + r * 2.2, y); halo.arc(x, y, r * 2.2, 0, Math.PI * 2);
      } else {
        ivory.moveTo(x + r, y); ivory.arc(x, y, r, 0, Math.PI * 2);
      }
    }
    ctx.fillStyle = 'rgba(61,220,132,0.16)';
    ctx.fill(halo);
    ctx.fillStyle = BEAD;
    ctx.fill(ivory);
    ctx.fillStyle = BEAD_GREEN;
    ctx.fill(green);
  }

  drawEditOverlay(sc, view, t) {
    const ctx = this.ctx, kx = this.kx, ky = this.ky, dpr = this.dpr;
    const sel = view.selection;
    if (sel) {
      if (!sel.path) sel.path = this.maskOutline(sc, sel.mask);
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([5 * dpr, 5 * dpr]);
      ctx.lineDashOffset = -t * 18 * dpr;
      ctx.strokeStyle = '#000';
      ctx.stroke(sel.path);
      ctx.lineDashOffset = -t * 18 * dpr + 5 * dpr;
      ctx.strokeStyle = BEAD;
      ctx.stroke(sel.path);
      ctx.setLineDash([]);
      // rotation ring and knob
      const h = view.handle;
      if (h) {
        ctx.strokeStyle = 'rgba(243,234,211,0.35)';
        ctx.lineWidth = 1 * dpr;
        ctx.setLineDash([2 * dpr, 4 * dpr]);
        ctx.beginPath();
        ctx.arc(h.cx * dpr, h.cy * dpr, h.R * dpr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(243,234,211,0.7)';
        ctx.beginPath();
        ctx.moveTo(h.cx * dpr, h.cy * dpr);
        ctx.lineTo(h.hx * dpr, h.hy * dpr);
        ctx.stroke();
        ctx.fillStyle = BEAD;
        ctx.strokeStyle = '#0a1630';
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        ctx.arc(h.hx * dpr, h.hy * dpr, 7 * dpr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    if (view.lasso && view.lasso.length > 1) {
      ctx.strokeStyle = BEAD;
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.beginPath();
      ctx.moveTo(view.lasso[0].x * kx, view.lasso[0].y * ky);
      for (const p of view.lasso) ctx.lineTo(p.x * kx, p.y * ky);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const hv = view.hover;
    if (hv && view.cursor) {
      const cx = hv.x * kx, cy = hv.y * ky;
      ctx.lineWidth = 1.25 * dpr;
      if (view.cursor.kind === 'brush') {
        const R = Math.max(0.5, view.cursor.r) * kx;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 3 * dpr;
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = view.cursor.color;
        ctx.lineWidth = 1.25 * dpr;
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      } else if (view.cursor.kind === 'cross') {
        const s = 7 * dpr;
        ctx.strokeStyle = BEAD;
        ctx.beginPath();
        ctx.moveTo(cx - s, cy); ctx.lineTo(cx + s, cy);
        ctx.moveTo(cx, cy - s); ctx.lineTo(cx, cy + s);
        ctx.stroke();
      }
    }
  }
}
