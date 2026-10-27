// Scenario state: the authored map, velocity field and divergence field.
// Grid convention: cell (i, j) spans [i, i+1] x [j, j+1], x to the right,
// y DOWNWARD (screen convention). Velocities are in cells per second.

export const FLUID = 0;
export const WALL = 1;
export const GOAL = 2;
export const INFLOW = 3;

export const TYPE_LABELS = ['Open fluid', 'Wall', 'Goal', 'Inflow'];

// Flat key colors used in the saved PNG (one pixel per cell).
export const KEY_COLORS = [
  [0, 0, 0],       // open fluid
  [128, 128, 128], // wall
  [255, 255, 255], // goal
  [0, 255, 255],   // inflow
];

export const DEFAULT_PARAMS = {
  maxTime: 30,        // simulated seconds
  emissionRate: 50,   // beads per second, all inflows combined
  viscosity: 0.01,    // kinematic viscosity, cells^2 / s
  beadRadius: 0.45,   // cells
  beadInertia: 0.06,  // drag response time, seconds
  edges: 'open',      // 'open' | 'walls'
};

export class Scenario {
  constructor(nx = 192, ny = 120) {
    this.nx = nx;
    this.ny = ny;
    const n = nx * ny;
    this.type = new Uint8Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.q = new Float32Array(n);
    this.markers = [];
    this.params = { ...DEFAULT_PARAMS };
    this.name = 'untitled';
    this.version = 0;
  }

  touch() { this.version++; }

  inside(i, j) { return i >= 0 && j >= 0 && i < this.nx && j < this.ny; }

  snapshot() {
    return {
      type: this.type.slice(),
      vx: this.vx.slice(),
      vy: this.vy.slice(),
      q: this.q.slice(),
      markers: this.markers.map(m => ({ ...m })),
    };
  }

  restore(s) {
    this.type.set(s.type);
    this.vx.set(s.vx);
    this.vy.set(s.vy);
    this.q.set(s.q);
    this.markers = s.markers.map(m => ({ ...m }));
    this.touch();
  }

  clearAll() {
    this.type.fill(FLUID);
    this.vx.fill(0);
    this.vy.fill(0);
    this.q.fill(0);
    this.markers = [];
    this.touch();
  }

  // Painted vorticity at cell centers, sign flipped so that visually
  // counterclockwise rotation (on screen, y down) is positive.
  spinField(out) {
    const { nx, ny, vx, vy } = this;
    out.fill(0);
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const c = i + j * nx;
        const dvdx = 0.5 * (vy[c + 1] - vy[c - 1]);
        const dudy = 0.5 * (vx[c + nx] - vx[c - nx]);
        out[c] = -(dvdx - dudy);
      }
    }
    return out;
  }

  // Measured strength of a marker from the current fields.
  // curl: mean tangential speed on a ring (positive = counterclockwise on screen)
  // source/sink: total flow rate inside 2R (cells^2 / s)
  markerStrength(m) {
    const { nx, ny } = this;
    if (m.kind === 'curl') {
      let s = 0, n = 0;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const i = Math.floor(m.x + ca * m.r), j = Math.floor(m.y + sa * m.r);
        if (!this.inside(i, j)) continue;
        const c = i + j * nx;
        // counterclockwise-on-screen tangent at angle a is (sin a, -cos a)
        s += this.vx[c] * sa - this.vy[c] * ca;
        n++;
      }
      return n ? s / n : 0;
    }
    let s = 0;
    const R = m.r * 2;
    const i0 = Math.max(0, Math.floor(m.x - R)), i1 = Math.min(nx - 1, Math.floor(m.x + R));
    const j0 = Math.max(0, Math.floor(m.y - R)), j1 = Math.min(ny - 1, Math.floor(m.y + R));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = i + 0.5 - m.x, dy = j + 0.5 - m.y;
        if (dx * dx + dy * dy <= R * R) s += this.q[i + j * nx];
      }
    }
    return s;
  }

  // Drop markers whose effect has been erased or painted over.
  pruneMarkers() {
    this.markers = this.markers.filter(m => {
      const i = Math.floor(m.x), j = Math.floor(m.y);
      if (!this.inside(i, j)) return false;
      const t = this.type[i + j * this.nx];
      if (t === WALL || t === INFLOW) return false;
      const s = this.markerStrength(m);
      return m.kind === 'curl' ? Math.abs(s) > 0.5 : Math.abs(s) > 2;
    });
  }
}
