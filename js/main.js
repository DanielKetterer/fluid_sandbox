// Fluid Sandbox: UI controller.

import { FLUID, WALL, GOAL, INFLOW, TYPE_LABELS } from './state.js';
import { FluidSolver } from './fluid.js';
import { Beads } from './beads.js';
import { Renderer } from './render.js';
import * as E from './edit.js';
import { EXAMPLES, buildExample } from './examples.js';
import * as IO from './io.js';

const DT = 1 / 60;
const $ = id => document.getElementById(id);

const TOOL_EL = { open: FLUID, wall: WALL, goal: GOAL, inflow: INFLOW };
const STAMP_TOOLS = new Set(['source', 'sink', 'curl-ccw', 'curl-cw']);
const TOOL_KEYS = { 1: 'open', 2: 'wall', 3: 'goal', 4: 'inflow', 5: 'select', 6: 'comb', 7: 'source', 8: 'sink', 9: 'curl-ccw', 0: 'curl-cw' };
const CURSOR_COLOR = {
  open: '#8f9cb8', wall: '#d4d8de', goal: '#ffffff', inflow: '#3fd0e0', comb: '#f3ead3',
  source: '#f2a541', sink: '#8b6cf0', 'curl-ccw': '#ef5a7a', 'curl-cw': '#4f8ff7',
};

const app = {
  sc: null,
  mode: 'edit', // edit | sim | result
  tool: 'wall',
  brush: 8,
  angle: 0,     // radians, counterclockwise on screen, 0 = pointing right
  speed: 20,
  strength: 0.5,
  selection: null,
  undo: [],
  redo: [],
  staticDirty: true,
  solver: null,
  beads: null,
  simTime: 0,
  playback: 1,
  showArrows: true,
  hover: null,
  drag: null,
  lasso: null,
};

const canvas = $('tank');
const frameEl = $('frame');
const stage = $('stage');
const panel = $('panel');
const renderer = new Renderer(canvas, frameEl);

// ---------------------------------------------------------------- helpers

function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), isError ? 4200 : 2600);
}

function curVec() {
  return [Math.cos(app.angle) * app.speed, -Math.sin(app.angle) * app.speed];
}

function toCell(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * app.sc.nx,
    y: ((e.clientY - r.top) / r.height) * app.sc.ny,
  };
}

function toCss(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

const fmt = (v, d = 1) => (Math.abs(v) < 0.05 && d <= 1 ? '0' : v.toFixed(d));

// ---------------------------------------------------------------- layout

function relayout() {
  if (!app.sc) return;
  const cs = getComputedStyle(stage);
  const w = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const bar = $('statusbar').offsetHeight + 10;
  const narrow = window.matchMedia('(max-width: 860px)').matches;
  const h = narrow
    ? window.innerHeight * 0.62
    : stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - bar;
  renderer.layout(app.sc, Math.max(100, w - 10), Math.max(80, h));
  app.staticDirty = true;
  if (app.selection) app.selection.path = null;
}

new ResizeObserver(() => relayout()).observe(stage);

function updateEdgesUI() {
  const e = app.sc.params.edges;
  frameEl.classList.toggle('edges-open', e === 'open');
  frameEl.classList.toggle('edges-walls', e === 'walls');
  for (const b of document.querySelectorAll('[data-edges]')) b.setAttribute('aria-checked', String(b.dataset.edges === e));
}

// ---------------------------------------------------------------- scenario

function setScenario(sc) {
  if (app.mode !== 'edit') backToEditor();
  app.sc = sc;
  app.undo = [];
  app.redo = [];
  app.selection = null;
  $('name').value = sc.name;
  syncParams();
  updateEdgesUI();
  relayout();
  updateSelUI();
  updateUndoUI();
}

function pushUndo() {
  app.undo.push(app.sc.snapshot());
  if (app.undo.length > 60) app.undo.shift();
  app.redo = [];
  updateUndoUI();
}

function undo() {
  if (!app.undo.length) return;
  app.redo.push(app.sc.snapshot());
  app.sc.restore(app.undo.pop());
  afterRestore();
}

function redo() {
  if (!app.redo.length) return;
  app.undo.push(app.sc.snapshot());
  app.sc.restore(app.redo.pop());
  afterRestore();
}

function afterRestore() {
  clearSelection();
  app.staticDirty = true;
  updateUndoUI();
}

function updateUndoUI() {
  $('undo').disabled = !app.undo.length;
  $('redo').disabled = !app.redo.length;
}

// ---------------------------------------------------------------- tools

const TOOL_HINTS = {
  open: ['Open fluid', 'drag to paint plain water. It also erases.'],
  wall: ['Wall', 'drag to paint solid, no-slip walls.'],
  goal: ['Goal', 'drag to paint the area beads should reach.'],
  inflow: ['Inflow', 'drag to paint. It pushes fluid at the dial direction and speed.'],
  select: ['Select', 'lasso or click a region, then rotate and scale its vectors.'],
  comb: ['Comb', 'drag to paint fan velocity along your stroke.'],
  source: ['Source', 'click to add fluid here.'],
  sink: ['Sink', 'click to drain fluid, and beads, here.'],
  'curl-ccw': ['Curl left', 'click to add a counterclockwise stirrer.'],
  'curl-cw': ['Curl right', 'click to add a clockwise stirrer.'],
};

function setTool(t) {
  if (app.tool === 'select' && t !== 'select') clearSelection();
  app.tool = t;
  for (const b of document.querySelectorAll('.tool')) b.setAttribute('aria-checked', String(b.dataset.tool === t));
  const vecBox = $('vecBox');
  const showVec = t === 'inflow' || t === 'select' || t === 'comb';
  vecBox.hidden = !showVec;
  vecBox.dataset.mode = t;
  $('vecHint').textContent = t === 'inflow' ? 'Inflow direction' : t === 'select' ? 'Used by Fill' : '';
  $('strengthBox').hidden = !STAMP_TOOLS.has(t);
  $('selBox').hidden = t !== 'select';
  const [name, what] = TOOL_HINTS[t];
  $('toolHint').innerHTML = `<b>${name}:</b> ${what}`;
}

for (const b of document.querySelectorAll('.tool')) {
  b.addEventListener('click', () => setTool(b.dataset.tool));
}

function setBrush(v) {
  app.brush = Math.max(1, Math.min(40, Math.round(v)));
  $('brush').value = app.brush;
  $('brushOut').textContent = app.brush;
}
$('brush').addEventListener('input', e => setBrush(+e.target.value));

// direction dial
function setAngle(a) {
  let deg = Math.round((a * 180) / Math.PI);
  deg = ((deg + 180) % 360 + 360) % 360 - 180;
  app.angle = (deg * Math.PI) / 180;
  $('dialNeedle').setAttribute('transform', `rotate(${-deg} 32 32)`);
  $('dirOut').textContent = `${deg}°`;
  $('dial').setAttribute('aria-valuenow', String(deg));
}

{
  const dial = $('dial');
  const fromEvent = e => {
    const r = dial.getBoundingClientRect();
    let a = Math.atan2(-(e.clientY - (r.top + r.height / 2)), e.clientX - (r.left + r.width / 2));
    if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
    setAngle(a);
  };
  dial.addEventListener('pointerdown', e => { dial.setPointerCapture(e.pointerId); fromEvent(e); });
  dial.addEventListener('pointermove', e => { if (dial.hasPointerCapture(e.pointerId)) fromEvent(e); });
  dial.addEventListener('keydown', e => {
    const step = e.shiftKey ? 15 : 5;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { setAngle(app.angle + (step * Math.PI) / 180); e.preventDefault(); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { setAngle(app.angle - (step * Math.PI) / 180); e.preventDefault(); }
  });
}

$('speed').addEventListener('input', e => {
  app.speed = +e.target.value;
  $('speedOut').textContent = app.speed;
});

$('strength').addEventListener('input', e => {
  app.strength = +e.target.value / 100;
  $('strengthOut').textContent = `${e.target.value}%`;
});

// ---------------------------------------------------------------- params

function syncParams() {
  const p = app.sc.params;
  $('maxTime').value = p.maxTime; $('maxTimeOut').textContent = `${p.maxTime} s`;
  $('rate').value = p.emissionRate; $('rateOut').textContent = `${p.emissionRate}/s`;
  $('visc').value = Math.log10(Math.max(1e-3, p.viscosity)); $('viscOut').textContent = viscLabel(p.viscosity);
  $('beadR').value = p.beadRadius; $('beadROut').textContent = p.beadRadius.toFixed(2);
  $('inertia').value = Math.log10(p.beadInertia); $('inertiaOut').textContent = inertiaLabel(p.beadInertia);
}

const viscLabel = v => (v < 0.01 ? v.toFixed(3) : v < 1 ? v.toFixed(2) : v.toFixed(1));
const inertiaLabel = v => (v < 0.1 ? `${v.toFixed(3)} s` : `${v.toFixed(2)} s`);

$('maxTime').addEventListener('input', e => { app.sc.params.maxTime = +e.target.value; $('maxTimeOut').textContent = `${e.target.value} s`; });
$('rate').addEventListener('input', e => { app.sc.params.emissionRate = +e.target.value; $('rateOut').textContent = `${e.target.value}/s`; });
$('visc').addEventListener('input', e => {
  const v = Math.pow(10, +e.target.value);
  app.sc.params.viscosity = +v.toPrecision(2);
  $('viscOut').textContent = viscLabel(app.sc.params.viscosity);
});
$('beadR').addEventListener('input', e => { app.sc.params.beadRadius = +e.target.value; $('beadROut').textContent = (+e.target.value).toFixed(2); });
$('inertia').addEventListener('input', e => {
  const v = +Math.pow(10, +e.target.value).toPrecision(2);
  app.sc.params.beadInertia = v;
  $('inertiaOut').textContent = inertiaLabel(v);
});
for (const b of document.querySelectorAll('[data-edges]')) {
  b.addEventListener('click', () => { app.sc.params.edges = b.dataset.edges; updateEdgesUI(); });
}
$('name').addEventListener('input', e => { app.sc.name = e.target.value; });

// ---------------------------------------------------------------- painting

function paintStroke(a, b) {
  const el = TOOL_EL[app.tool];
  const [vx, vy] = curVec();
  E.paintSegment(app.sc, el, a.x, a.y, b.x, b.y, app.brush / 2, vx, vy);
  app.sc.touch();
  app.staticDirty = true;
}

function stampAt(p) {
  const sc = app.sc;
  const R = Math.max(2, app.brush / 2);
  const s = app.strength;
  let ok = false;
  switch (app.tool) {
    case 'source': ok = E.stampDivergence(sc, p.x, p.y, R, s * E.Q_MAX); break;
    case 'sink': ok = E.stampDivergence(sc, p.x, p.y, R, -s * E.Q_MAX); break;
    case 'curl-ccw': ok = E.stampCurl(sc, p.x, p.y, R, s * E.CURL_MAX); break;
    case 'curl-cw': ok = E.stampCurl(sc, p.x, p.y, R, -s * E.CURL_MAX); break;
  }
  if (ok) sc.touch();
  return ok;
}

// ---------------------------------------------------------------- selection

function clearSelection() {
  app.selection = null;
  updateSelUI();
}

function setSelection(mask) {
  const sc = app.sc;
  const cells = [];
  let sx = 0, sy = 0;
  for (let c = 0; c < mask.length; c++) {
    if (!mask[c]) continue;
    cells.push(c);
    sx += (c % sc.nx) + 0.5;
    sy += ((c / sc.nx) | 0) + 0.5;
  }
  if (!cells.length) { clearSelection(); return; }
  const cx = sx / cells.length, cy = sy / cells.length;
  let rad = 0;
  const bx = new Float32Array(cells.length), by = new Float32Array(cells.length);
  cells.forEach((c, k) => {
    bx[k] = sc.vx[c]; by[k] = sc.vy[c];
    rad = Math.max(rad, Math.hypot((c % sc.nx) + 0.5 - cx, ((c / sc.nx) | 0) + 0.5 - cy));
  });
  app.selection = { mask, cells: Int32Array.from(cells), bx, by, rot: 0, scale: 1, cx, cy, rad, dirty: false, path: null, knobBase: null };
  app.selection.knobBase = pickKnobBase(app.selection);
  updateSelUI();
}

function knobRadius(sel) {
  return Math.min(80, Math.max(34, sel.rad * renderer.cssCell * 0.6));
}

function pickKnobBase(sel) {
  const cs = renderer.cssCell;
  const W = app.sc.nx * cs, H = app.sc.ny * cs;
  const R = knobRadius(sel);
  for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const x = sel.cx * cs + R * Math.cos(a), y = sel.cy * cs - R * Math.sin(a);
    if (x > 10 && y > 10 && x < W - 10 && y < H - 10) return a;
  }
  return 0;
}

function handleGeom() {
  const sel = app.selection;
  if (!sel || app.tool !== 'select') return null;
  const cs = renderer.cssCell;
  const cx = sel.cx * cs, cy = sel.cy * cs;
  const R = knobRadius(sel);
  const a = sel.knobBase + sel.rot;
  return { cx, cy, R, hx: cx + R * Math.cos(a), hy: cy - R * Math.sin(a) };
}

function beginTransform() {
  const sel = app.selection;
  if (sel && !sel.dirty) { pushUndo(); sel.dirty = true; }
}

function applyTransform() {
  const sel = app.selection, sc = app.sc;
  if (!sel) return;
  const c = Math.cos(sel.rot), s = Math.sin(sel.rot);
  for (let k = 0; k < sel.cells.length; k++) {
    const x = sel.bx[k], y = sel.by[k], cell = sel.cells[k];
    // counterclockwise on screen with y pointing down
    sc.vx[cell] = (x * c + y * s) * sel.scale;
    sc.vy[cell] = (-x * s + y * c) * sel.scale;
  }
  sc.touch();
  syncSelSliders();
}

function syncSelSliders() {
  const sel = app.selection;
  if (!sel) return;
  const deg = Math.round((sel.rot * 180) / Math.PI);
  $('rot').value = deg; $('rotOut').textContent = `${deg}°`;
  const pct = Math.round(sel.scale * 100);
  $('mag').value = Math.min(400, pct); $('magOut').textContent = `${pct}%`;
}

function updateSelUI() {
  const sel = app.selection;
  $('selControls').hidden = !sel;
  $('selHint').textContent = sel
    ? `${sel.cells.length} cells selected. Drag the knob on the ring or use the sliders.`
    : 'Drag to lasso a region, click to pick a connected area. Shift adds, Alt removes.';
  if (sel) syncSelSliders();
}

function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function finishLasso(op) {
  const pts = app.lasso;
  app.lasso = null;
  const sc = app.sc;
  const n = sc.nx * sc.ny;
  const mask = new Uint8Array(n);
  let len = 0;
  for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y);

  if (len < 1.5) {
    // click: pick the connected region of the same element
    const i = Math.floor(pts[0].x), j = Math.floor(pts[0].y);
    if (!sc.inside(i, j)) return;
    const t = sc.type[i + j * sc.nx];
    if (t === WALL) { if (op === 'replace') clearSelection(); return; }
    const stack = [i + j * sc.nx];
    mask[stack[0]] = 1;
    while (stack.length) {
      const c = stack.pop();
      const ci = c % sc.nx, cj = (c / sc.nx) | 0;
      for (const [a, b] of [[ci + 1, cj], [ci - 1, cj], [ci, cj + 1], [ci, cj - 1]]) {
        if (!sc.inside(a, b)) continue;
        const d = a + b * sc.nx;
        if (!mask[d] && sc.type[d] === t) { mask[d] = 1; stack.push(d); }
      }
    }
  } else {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const i0 = Math.max(0, Math.floor(x0)), i1 = Math.min(sc.nx - 1, Math.floor(x1));
    const j0 = Math.max(0, Math.floor(y0)), j1 = Math.min(sc.ny - 1, Math.floor(y1));
    for (let j = j0; j <= j1; j++) {
      const py = j + 0.5;
      for (let i = i0; i <= i1; i++) {
        const c = i + j * sc.nx;
        if (sc.type[c] === WALL) continue;
        const px = i + 0.5;
        let inside = false;
        for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
          const ya = pts[a].y, yb = pts[b].y;
          if ((ya > py) !== (yb > py) && px < ((pts[b].x - pts[a].x) * (py - ya)) / (yb - ya) + pts[a].x) inside = !inside;
        }
        if (inside) mask[c] = 1;
      }
    }
  }

  const prev = app.selection;
  if (prev && op !== 'replace') {
    for (let c = 0; c < n; c++) {
      mask[c] = op === 'add' ? (prev.mask[c] | mask[c]) : (prev.mask[c] & (mask[c] ^ 1));
    }
  }
  setSelection(mask);
}

$('rot').addEventListener('input', e => {
  if (!app.selection) return;
  beginTransform();
  app.selection.rot = (+e.target.value * Math.PI) / 180;
  applyTransform();
});
$('mag').addEventListener('input', e => {
  if (!app.selection) return;
  beginTransform();
  app.selection.scale = +e.target.value / 100;
  applyTransform();
});
$('selFill').addEventListener('click', () => fillSelection(...curVec()));
$('selZero').addEventListener('click', () => fillSelection(0, 0));
$('selDone').addEventListener('click', () => clearSelection());

function fillSelection(vx, vy) {
  const sel = app.selection;
  if (!sel) return;
  beginTransform();
  sel.bx.fill(vx); sel.by.fill(vy);
  sel.rot = 0; sel.scale = 1;
  applyTransform();
}

// ---------------------------------------------------------------- pointer

canvas.addEventListener('pointerdown', e => {
  if (app.mode !== 'edit') return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  const p = toCell(e);
  app.hover = p;
  const t = app.tool;
  if (t in TOOL_EL) {
    pushUndo();
    paintStroke(p, p);
    app.drag = { kind: 'paint', last: p };
  } else if (t === 'comb') {
    pushUndo();
    app.drag = { kind: 'comb', last: p, dir: null, changed: false };
  } else if (t === 'select') {
    const css = toCss(e);
    const h = handleGeom();
    if (h && Math.hypot(css.x - h.hx, css.y - h.hy) < 16) {
      beginTransform();
      app.drag = { kind: 'rotate', a0: Math.atan2(-(css.y - h.cy), css.x - h.cx), rot0: app.selection.rot };
    } else {
      app.lasso = [p];
      app.drag = { kind: 'lasso', op: e.shiftKey ? 'add' : e.altKey ? 'sub' : 'replace' };
    }
  } else if (STAMP_TOOLS.has(t)) {
    pushUndo();
    if (!stampAt(p)) { app.undo.pop(); updateUndoUI(); toast('Curls, sources and sinks go on open fluid or goal cells.'); }
  }
});

canvas.addEventListener('pointermove', e => {
  const p = toCell(e);
  app.hover = p;
  updateReadout();
  const d = app.drag;
  if (!d || app.mode !== 'edit') return;
  if (d.kind === 'paint') {
    paintStroke(d.last, p);
    d.last = p;
  } else if (d.kind === 'comb') {
    const dx = p.x - d.last.x, dy = p.y - d.last.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.6) return;
    let ux = dx / len, uy = dy / len;
    if (d.dir) {
      ux = d.dir[0] * 0.45 + ux * 0.55; uy = d.dir[1] * 0.45 + uy * 0.55;
      const l = Math.hypot(ux, uy) || 1; ux /= l; uy /= l;
    }
    d.dir = [ux, uy];
    E.combSegment(app.sc, d.last.x, d.last.y, p.x, p.y, app.brush / 2, ux * app.speed, uy * app.speed);
    app.sc.touch();
    d.changed = true;
    d.last = p;
  } else if (d.kind === 'lasso') {
    const last = app.lasso[app.lasso.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) > 0.3) app.lasso.push(p);
  } else if (d.kind === 'rotate') {
    const css = toCss(e);
    const h = handleGeom();
    if (!h) return;
    let rot = d.rot0 + wrapAngle(Math.atan2(-(css.y - h.cy), css.x - h.cx) - d.a0);
    if (e.shiftKey) rot = Math.round(rot / (Math.PI / 12)) * (Math.PI / 12);
    app.selection.rot = wrapAngle(rot);
    applyTransform();
  }
});

function endPointer(e) {
  const d = app.drag;
  app.drag = null;
  if (!d) return;
  if (d.kind === 'paint') {
    app.sc.pruneMarkers();
    app.sc.touch();
  } else if (d.kind === 'comb') {
    if (!d.changed) { app.undo.pop(); updateUndoUI(); }
    else { app.sc.pruneMarkers(); app.sc.touch(); }
  } else if (d.kind === 'lasso') {
    finishLasso(d.op);
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { if (!app.drag) { app.hover = null; updateReadout(); } });

canvas.addEventListener('wheel', e => {
  if (app.mode !== 'edit') return;
  e.preventDefault();
  const delta = e.deltaY || e.deltaX;
  if (app.tool === 'select' && app.selection) {
    beginTransform();
    const sel = app.selection;
    if (e.shiftKey) sel.rot = wrapAngle(sel.rot - delta * 0.003);
    else sel.scale = Math.max(0, Math.min(4, sel.scale * Math.exp(-delta * 0.0015)));
    applyTransform();
  } else {
    setBrush(app.brush - Math.sign(delta));
  }
}, { passive: false });

function updateReadout() {
  const el = $('readout');
  const p = app.hover, sc = app.sc;
  if (!p) { el.textContent = ''; return; }
  const i = Math.floor(p.x), j = Math.floor(p.y);
  if (!sc.inside(i, j)) { el.textContent = ''; return; }
  const c = i + j * sc.nx;
  const t = sc.type[c];
  let vx, vy, label;
  if (app.mode !== 'edit' && app.solver) {
    const v = app.solver.velAt(p.x, p.y, [0, 0]);
    vx = v[0]; vy = v[1]; label = 'flow';
  } else {
    vx = sc.vx[c]; vy = sc.vy[c]; label = t === INFLOW ? 'inflow' : 'fan';
  }
  const s = Math.hypot(vx, vy);
  const parts = [`x ${i}, y ${j}`, TYPE_LABELS[t].toLowerCase()];
  if (t !== WALL) {
    parts.push(s > 0.05
      ? `${label} ${fmt(s)} cells/s at ${Math.round((Math.atan2(-vy, vx) * 180) / Math.PI)}\u00b0`
      : `${label} 0`);
    if (Math.abs(sc.q[c]) > 0.005) parts.push(`q ${sc.q[c].toFixed(2)}/s`);
  }
  el.replaceChildren(...parts.map(p => { const sp = document.createElement('span'); sp.textContent = p; return sp; }));
}

// ---------------------------------------------------------------- simulation

function startSim() {
  clearSelection();
  const sc = app.sc;
  app.solver = new FluidSolver(sc);
  app.beads = new Beads(sc, app.solver);
  app.simTime = 0;
  app.mode = 'sim';
  panel.classList.add('locked');
  frameEl.classList.add('running');
  $('simulate').textContent = 'Stop';
  $('simulate').classList.add('running');
  $('result').hidden = true;
  $('hud').hidden = false;
  $('editStatus').hidden = true;
  updateHUD();
  if (!app.beads.emitTotal) toast('No moving inflow in the tank, so no beads will be released.');
}

function endSim() {
  app.mode = 'result';
  $('simulate').textContent = 'Simulate';
  $('simulate').classList.remove('running');
  const b = app.beads;
  const pct = b.emitted ? (100 * b.greenCount) / b.emitted : 0;
  $('resultPct').textContent = b.emitted ? `${pct.toFixed(1)}%` : 'No beads';
  $('resultSub').textContent = b.emitted
    ? `of released beads reached the goal in ${app.simTime.toFixed(1)} s`
    : 'Add an inflow with some speed, then run again.';
  $('rEmitted').textContent = b.emitted;
  $('rGreen').textContent = b.greenCount;
  $('rLost').textContent = b.lost;
  $('rAlive').textContent = b.count;
  $('result').hidden = false;
  updateHUD();
  $('back').focus({ preventScroll: true });
}

function backToEditor() {
  app.mode = 'edit';
  app.solver = null;
  app.beads = null;
  panel.classList.remove('locked');
  frameEl.classList.remove('running');
  $('simulate').textContent = 'Simulate';
  $('simulate').classList.remove('running');
  $('hud').hidden = true;
  $('editStatus').hidden = false;
  $('result').hidden = true;
}

function updateHUD() {
  const b = app.beads;
  if (!b) return;
  const pct = b.emitted ? (100 * b.greenCount) / b.emitted : 0;
  $('hudPct').textContent = `${pct.toFixed(1)}%`;
  const T = app.sc.params.maxTime;
  $('hudClock').textContent = `${app.simTime.toFixed(1)} / ${T} s`;
  $('hudBar').style.width = `${Math.min(100, (100 * app.simTime) / T)}%`;
  $('hudEmitted').textContent = b.emitted;
  $('hudGreen').textContent = b.greenCount;
  $('hudLost').textContent = b.lost;
}

$('simulate').addEventListener('click', () => {
  if (app.mode === 'sim') endSim();
  else { if (app.mode === 'result') backToEditor(); startSim(); }
});
$('again').addEventListener('click', () => { backToEditor(); startSim(); });
$('back').addEventListener('click', () => backToEditor());

for (const b of document.querySelectorAll('[data-speed]')) {
  b.addEventListener('click', () => {
    app.playback = +b.dataset.speed;
    for (const o of document.querySelectorAll('[data-speed]')) o.setAttribute('aria-checked', String(o === b));
  });
}
document.querySelector('[data-speed="1"]').setAttribute('aria-checked', 'true');
document.querySelector('[data-speed="2"]').setAttribute('aria-checked', 'false');
document.querySelector('[data-speed="4"]').setAttribute('aria-checked', 'false');

$('hudArrows').addEventListener('click', e => {
  app.showArrows = !app.showArrows;
  e.currentTarget.setAttribute('aria-pressed', String(app.showArrows));
});

// ---------------------------------------------------------------- files

$('save').addEventListener('click', async () => {
  const sc = app.sc;
  sc.name = $('name').value.trim() || sc.name || 'scenario';
  const base = IO.safeName(sc.name);
  try {
    const png = await IO.pngBlob(sc);
    IO.download(png, `${base}.png`);
    setTimeout(() => IO.download(IO.flowBlob(sc), `${base}.flow.json`), 400);
    toast(`Saved ${base}.png and ${base}.flow.json`);
  } catch (err) {
    toast(`Save failed: ${err.message}`, true);
  }
});

const pending = { map: null, flow: null, name: '' };

function loadMsg(text, ok = false) {
  const m = $('loadMsg');
  m.textContent = text;
  m.classList.toggle('ok', ok);
}

$('load').addEventListener('click', () => {
  pending.map = null; pending.flow = null; pending.name = '';
  $('pngName').textContent = '';
  $('jsonName').textContent = '';
  $('pickJson').disabled = true;
  $('loadApply').disabled = true;
  loadMsg('');
  $('loadDialog').showModal();
});

$('pickPng').addEventListener('click', () => $('filePng').click());
$('pickJson').addEventListener('click', () => $('fileJson').click());

const stripExt = n => n.replace(/(\.flow)?\.(png|json|jpe?g|gif|webp|bmp)$/i, '');

$('filePng').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const map = await IO.readMapPNG(f);
    pending.map = map;
    pending.flow = null;
    pending.name = stripExt(f.name);
    $('pngName').textContent = `${f.name}: ${map.nx} x ${map.ny} cells${map.scaled ? ` (scaled down from ${map.srcW} x ${map.srcH})` : ''}`;
    $('jsonName').textContent = '';
    $('pickJson').disabled = false;
    $('loadApply').disabled = false;
    loadMsg('');
    $('pickJson').focus();
  } catch (err) {
    pending.map = null;
    $('pngName').textContent = '';
    $('pickJson').disabled = true;
    $('loadApply').disabled = true;
    loadMsg(err.message);
  }
});

$('fileJson').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !pending.map) return;
  try {
    const flow = await IO.readFlowJSON(f);
    if (flow.width !== pending.map.nx || flow.height !== pending.map.ny) {
      throw new Error(`The velocity file is ${flow.width} x ${flow.height} but the map is ${pending.map.nx} x ${pending.map.ny}. Choose the files saved together.`);
    }
    pending.flow = flow;
    $('jsonName').textContent = `${f.name}: matches the map`;
    loadMsg('');
    $('loadApply').focus();
  } catch (err) {
    pending.flow = null;
    $('jsonName').textContent = '';
    loadMsg(err.message);
  }
});

$('loadApply').addEventListener('click', () => {
  if (!pending.map) return;
  try {
    const sc = IO.buildScenario(pending.map, pending.flow, pending.name);
    $('loadDialog').close();
    setScenario(sc);
    $('example').value = '';
    toast(pending.flow ? `Loaded ${sc.name}` : `Loaded ${sc.name} with still water`);
  } catch (err) {
    loadMsg(err.message);
  }
});

// drag and drop: a PNG, optionally with its .flow.json
stage.addEventListener('dragover', e => { e.preventDefault(); });
stage.addEventListener('drop', async e => {
  e.preventDefault();
  if (app.mode === 'sim') return;
  const files = [...(e.dataTransfer?.files || [])];
  const png = files.find(f => /image\//.test(f.type) || /\.png$/i.test(f.name));
  const json = files.find(f => /\.json$/i.test(f.name));
  if (!png) { toast('Drop the map PNG, optionally together with its .flow.json.', true); return; }
  try {
    const map = await IO.readMapPNG(png);
    const flow = json ? await IO.readFlowJSON(json) : null;
    const sc = IO.buildScenario(map, flow, stripExt(png.name));
    setScenario(sc);
    $('example').value = '';
    toast(`Loaded ${sc.name}`);
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------------------------------------------------------------- misc actions

$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('clear').addEventListener('click', () => {
  pushUndo();
  app.sc.clearAll();
  clearSelection();
  app.staticDirty = true;
  toast('Tank cleared. Undo brings it back.');
});

{
  const sel = $('example');
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'Custom';
  none.hidden = true;
  sel.appendChild(none);
  for (const ex of EXAMPLES) {
    const o = document.createElement('option');
    o.value = ex.id;
    o.textContent = ex.label;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    if (!sel.value) return;
    setScenario(buildExample(sel.value));
    sel.blur();
  });
}

$('helpBtn').addEventListener('click', () => {
  const d = $('helpDialog');
  d.showModal();
  d.scrollTop = 0;
});

document.addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' && e.target.type !== 'range') return;
  if (tag === 'select' || tag === 'textarea') return;
  if (document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    if (app.mode !== 'edit') return;
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') {
    if (app.mode !== 'edit') return;
    e.preventDefault();
    redo();
    return;
  }
  if (mod || e.altKey) return;
  if (e.key === ' ') {
    if (tag === 'button') return;
    e.preventDefault();
    if (app.mode === 'edit') startSim();
    else if (app.mode === 'sim') endSim();
    else backToEditor();
    return;
  }
  if (app.mode !== 'edit') {
    if (e.key === 'Escape' && app.mode === 'result') backToEditor();
    return;
  }
  if (TOOL_KEYS[e.key] !== undefined) { setTool(TOOL_KEYS[e.key]); return; }
  if (e.key === '[') setBrush(app.brush - 1);
  else if (e.key === ']') setBrush(app.brush + 1);
  else if (e.key === 'Escape') clearSelection();
  else if ((e.key === 'Delete' || e.key === 'Backspace') && app.selection) { e.preventDefault(); fillSelection(0, 0); }
});

// ---------------------------------------------------------------- loop

function cursorFor() {
  if (app.mode !== 'edit' || !app.hover) return null;
  const t = app.tool;
  if (t === 'select') return { kind: 'cross' };
  if (STAMP_TOOLS.has(t)) return { kind: 'brush', r: Math.max(2, app.brush / 2), color: CURSOR_COLOR[t] };
  return { kind: 'brush', r: app.brush / 2, color: CURSOR_COLOR[t] };
}

let lastHud = 0;
function frame(now) {
  const t = now / 1000;
  if (app.mode === 'sim') {
    const visc = app.sc.params.viscosity;
    const maxT = app.sc.params.maxTime;
    for (let s = 0; s < app.playback; s++) {
      app.solver.step(DT, visc);
      app.beads.step(DT);
      app.simTime += DT;
      if (app.simTime >= maxT - 1e-9) { endSim(); break; }
    }
    if (app.mode === 'sim' && now - lastHud > 80) { updateHUD(); lastHud = now; }
    if (app.hover) updateReadout();
  }
  if (app.staticDirty) { renderer.rebuildStatic(app.sc); app.staticDirty = false; }
  renderer.draw(app.sc, {
    mode: app.mode,
    time: t,
    solver: app.solver,
    beads: app.beads,
    showArrows: app.showArrows,
    selection: app.tool === 'select' ? app.selection : null,
    handle: handleGeom(),
    lasso: app.lasso,
    hover: app.hover,
    cursor: cursorFor(),
  });
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- boot

setTool('wall');
setBrush(8);
setAngle(0);
setScenario(buildExample('vortex-street'));
$('example').value = 'vortex-street';
requestAnimationFrame(frame);

// for debugging from the console
window.fluidSandbox = { app, renderer, startSim, endSim, setScenario, buildExample };
