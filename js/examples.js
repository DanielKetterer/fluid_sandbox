// Built-in scenarios, generated in code.

import { Scenario, WALL, GOAL, INFLOW } from './state.js';
import { paintRect, paintDisk, stampCurl, stampDivergence, combDisk } from './edit.js';

const NX = 160, NY = 100;

function vortexStreet() {
  const sc = new Scenario(NX, NY);
  sc.name = 'vortex-street';
  Object.assign(sc.params, { edges: 'open', viscosity: 0.003, emissionRate: 70, maxTime: 40, beadInertia: 0.05 });
  paintRect(sc, WALL, 0, 0, NX - 1, 5);
  paintRect(sc, WALL, 0, NY - 6, NX - 1, NY - 1);
  paintRect(sc, INFLOW, 0, 6, 2, NY - 7, 24, 0);
  paintDisk(sc, WALL, 40, 50.6, 7.5);
  paintRect(sc, GOAL, 118, 26, 131, 39);
  return sc;
}

function whirlpool() {
  const sc = new Scenario(NX, NY);
  sc.name = 'whirlpool';
  Object.assign(sc.params, { edges: 'walls', viscosity: 0.02, emissionRate: 50, maxTime: 40, beadInertia: 0.01 });
  // inflow against the left wall: a true source of fluid
  paintRect(sc, INFLOW, 0, 8, 4, 17, 22, 0);
  // baffles
  paintRect(sc, WALL, 34, 0, 36, 30);
  paintRect(sc, WALL, 124, 66, 126, NY - 1);
  // goal island on the spiral
  paintRect(sc, GOAL, 100, 62, 111, 73);
  stampCurl(sc, 80, 50, 18, 18);
  // drain balancing the inflow (10 cells x 22 cells/s)
  stampDivergence(sc, 80, 50, 4, -220);
  return sc;
}

function fanMaze() {
  const sc = new Scenario(NX, NY);
  sc.name = 'fan-maze';
  Object.assign(sc.params, { edges: 'open', viscosity: 0.01, emissionRate: 60, maxTime: 45, beadInertia: 0.06 });
  // outer frame with one exit at the bottom right
  paintRect(sc, WALL, 0, 0, NX - 1, 2);
  paintRect(sc, WALL, 0, NY - 3, NX - 1, NY - 1);
  paintRect(sc, WALL, 0, 3, 2, NY - 3);
  paintRect(sc, WALL, NX - 3, 3, NX - 1, 69);
  // baffles that make an S
  paintRect(sc, WALL, 0, 34, 118, 37);
  paintRect(sc, WALL, 42, 64, NX - 1, 67);
  // inflow at top left
  paintRect(sc, INFLOW, 3, 8, 5, 28, 18, 0);
  // fans: right along the top, down the right gap, left through the middle,
  // down the left gap, right along the bottom
  for (let x = 12; x < 112; x += 3) combDisk(sc, x, 18, 7, 14, 0);
  for (let y = 12; y < 58; y += 3) combDisk(sc, 139, y, 9, 0, 14);
  for (let x = 128; x > 50; x -= 3) combDisk(sc, x, 51, 7, -14, 0);
  for (let y = 44; y < 88; y += 3) combDisk(sc, 20, y, 9, 0, 14);
  for (let x = 30; x < 132; x += 3) combDisk(sc, x, 82, 7, 14, 0);
  // goal at the exit
  paintRect(sc, GOAL, 144, 72, NX - 1, NY - 4);
  return sc;
}

function blank() {
  const sc = new Scenario(NX, NY);
  sc.name = 'untitled';
  return sc;
}

export const EXAMPLES = [
  { id: 'vortex-street', label: 'Vortex street', build: vortexStreet },
  { id: 'whirlpool', label: 'Whirlpool', build: whirlpool },
  { id: 'fan-maze', label: 'Fan maze', build: fanMaze },
  { id: 'blank', label: 'Blank tank', build: blank },
];

export function buildExample(id) {
  const ex = EXAMPLES.find(e => e.id === id) || EXAMPLES[0];
  const sc = ex.build();
  sc.touch();
  return sc;
}
