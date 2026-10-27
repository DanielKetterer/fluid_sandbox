// Save and load: a key-color PNG (one pixel per cell) plus a JSON velocity file.

import { Scenario, KEY_COLORS, FLUID, DEFAULT_PARAMS } from './state.js';

export const MAX_W = 320;
export const MAX_H = 200;
export const MIN_DIM = 16;
export const FORMAT = 'fluid-sandbox';

export function safeName(name) {
  const s = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'scenario';
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function mapCanvas(sc) {
  const cv = document.createElement('canvas');
  cv.width = sc.nx;
  cv.height = sc.ny;
  const g = cv.getContext('2d');
  const img = g.createImageData(sc.nx, sc.ny);
  for (let c = 0; c < sc.nx * sc.ny; c++) {
    const k = KEY_COLORS[sc.type[c]] || KEY_COLORS[FLUID];
    img.data[c * 4] = k[0];
    img.data[c * 4 + 1] = k[1];
    img.data[c * 4 + 2] = k[2];
    img.data[c * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return cv;
}

export function pngBlob(sc) {
  return new Promise((resolve, reject) => {
    mapCanvas(sc).toBlob(b => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png');
  });
}

const r3 = v => Math.round(v * 1000) / 1000;

export function flowObject(sc) {
  const n = sc.nx * sc.ny;
  const vx = new Array(n), vy = new Array(n), q = new Array(n);
  for (let c = 0; c < n; c++) { vx[c] = r3(sc.vx[c]); vy[c] = r3(sc.vy[c]); q[c] = r3(sc.q[c]); }
  return {
    format: FORMAT,
    version: 1,
    name: sc.name,
    width: sc.nx,
    height: sc.ny,
    layout: 'row-major, index = x + y * width, y increases downward, one value per cell (matches the PNG pixels)',
    units: {
      velocity: 'cells per second; for open and goal cells this is the fan target, for inflow cells the prescribed inflow',
      divergence: 'per second; positive = source, negative = sink (div u = q)',
    },
    params: { ...sc.params },
    velocity: { x: vx, y: vy },
    divergence: q,
    markers: sc.markers.map(m => ({ kind: m.kind, x: r3(m.x), y: r3(m.y), r: r3(m.r) })),
  };
}

export function flowBlob(sc) {
  return new Blob([JSON.stringify(flowObject(sc))], { type: 'application/json' });
}

// ---------- loading ----------

function nearestKey(r, g, b) {
  let best = 0, bd = Infinity;
  for (let k = 0; k < KEY_COLORS.length; k++) {
    const c = KEY_COLORS[k];
    const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

async function decodeImage(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file); } catch (e) { /* fall through */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a readable image.')); };
    im.src = url;
  });
}

// Returns { nx, ny, type, srcW, srcH, scaled }
export async function readMapPNG(file) {
  const img = await decodeImage(file);
  const w = img.width, h = img.height;
  if (w < MIN_DIM || h < MIN_DIM) throw new Error(`The map is ${w} x ${h}. It needs to be at least ${MIN_DIM} x ${MIN_DIM} pixels.`);
  const f = Math.max(1, Math.ceil(Math.max(w / MAX_W, h / MAX_H)));
  const nx = Math.floor(w / f), ny = Math.floor(h / f);
  const cv = document.createElement('canvas');
  cv.width = nx; cv.height = ny;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0, w, h, 0, 0, nx, ny);
  const d = g.getImageData(0, 0, nx, ny).data;
  const type = new Uint8Array(nx * ny);
  for (let c = 0; c < nx * ny; c++) {
    const a = d[c * 4 + 3];
    type[c] = a < 128 ? FLUID : nearestKey(d[c * 4], d[c * 4 + 1], d[c * 4 + 2]);
  }
  return { nx, ny, type, srcW: w, srcH: h, scaled: f > 1 };
}

function numArray(a, n, label) {
  if (!Array.isArray(a) || a.length !== n) throw new Error(`The velocity file's ${label} array should have ${n} values.`);
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const v = Number(a[k]);
    out[k] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

export async function readFlowJSON(file) {
  let obj;
  try { obj = JSON.parse(await file.text()); }
  catch (e) { throw new Error('The velocity file is not valid JSON.'); }
  if (!obj || obj.format !== FORMAT) throw new Error('This JSON is not a Fluid Sandbox velocity file.');
  const w = obj.width | 0, h = obj.height | 0;
  if (w < MIN_DIM || h < MIN_DIM) throw new Error('The velocity file has an invalid width or height.');
  const n = w * h;
  const vel = obj.velocity || {};
  return {
    width: w,
    height: h,
    name: typeof obj.name === 'string' ? obj.name : null,
    vx: numArray(vel.x, n, 'velocity.x'),
    vy: numArray(vel.y, n, 'velocity.y'),
    q: obj.divergence ? numArray(obj.divergence, n, 'divergence') : new Float32Array(n),
    params: obj.params && typeof obj.params === 'object' ? obj.params : {},
    markers: Array.isArray(obj.markers) ? obj.markers : [],
  };
}

const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);

export function cleanParams(p) {
  const d = DEFAULT_PARAMS;
  return {
    maxTime: clamp(p.maxTime, 1, 600, d.maxTime),
    emissionRate: clamp(p.emissionRate, 0, 400, d.emissionRate),
    viscosity: clamp(p.viscosity, 0, 20, d.viscosity),
    beadRadius: clamp(p.beadRadius, 0.2, 2, d.beadRadius),
    beadInertia: clamp(p.beadInertia, 0.005, 2, d.beadInertia),
    edges: p.edges === 'walls' ? 'walls' : 'open',
  };
}

// Build a scenario from a decoded map and an optional flow file.
export function buildScenario(map, flow, fallbackName) {
  const sc = new Scenario(map.nx, map.ny);
  sc.type.set(map.type);
  if (flow) {
    if (flow.width !== map.nx || flow.height !== map.ny) {
      throw new Error(`The velocity file is ${flow.width} x ${flow.height} but the map is ${map.nx} x ${map.ny}. Choose the files saved together.`);
    }
    sc.vx.set(flow.vx);
    sc.vy.set(flow.vy);
    sc.q.set(flow.q);
    sc.params = cleanParams({ ...DEFAULT_PARAMS, ...flow.params });
    sc.markers = flow.markers
      .filter(m => m && (m.kind === 'curl' || m.kind === 'source' || m.kind === 'sink'))
      .map(m => ({ kind: m.kind, x: +m.x || 0, y: +m.y || 0, r: Math.max(1, +m.r || 4) }));
    if (flow.name) sc.name = flow.name;
  }
  if (!flow || !flow.name) sc.name = fallbackName || 'loaded';
  // walls carry no flow
  for (let c = 0; c < sc.nx * sc.ny; c++) {
    if (sc.type[c] === 1) { sc.vx[c] = 0; sc.vy[c] = 0; sc.q[c] = 0; }
  }
  sc.touch();
  return sc;
}
