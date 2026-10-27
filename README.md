# Fluid Sandbox

A 2D Navier-Stokes playground. Paint walls, inflows and a goal, shape the flow with fans, sources, sinks and curls, then release beads and see what fraction reaches the goal.

Live: https://danielketterer.github.io/fluid_sandbox/

## Playing

- **Paint** with Open (also the eraser), Wall, Goal or Inflow. The brush slider (or the scroll wheel, or `[` and `]`) sets the thickness. Inflow uses the direction dial and speed.
- **Shape the flow**
  - **Select**: drag a lasso or click a connected area, then rotate and scale its vectors with the knob on the ring, the sliders, or the scroll wheel (Shift + scroll rotates). Fill sets every vector in the selection to the dial direction and speed.
  - **Comb**: drag to paint velocity along your stroke.
  - **Source, Sink, Curl left, Curl right**: click to stamp one. Strength is a slider and the radius follows the brush. Clicks add up.
- **Run settings**: max time, bead rate, viscosity, bead size, bead inertia, and whether the tank edges are open or walled.
- **Simulate** locks the editor, releases beads from the inflows, and tracks the share that touch the goal. The run ends at max time, or when you press Stop.
- **Save** downloads `name.png` and `name.flow.json`. **Load** asks for the PNG, then the JSON.

Keys: `1`-`4` elements, `5`-`0` modifiers, `Space` simulate or stop, `Ctrl+Z` / `Ctrl+Y` undo and redo, `Esc` deselect, `Delete` zeroes the selection.

## The model

The tank solves the incompressible Navier-Stokes equations with forcing and a prescribed divergence:

```
du/dt + (u . grad) u = -grad p + nu lap u + f
div u = q
```

on a staggered (MAC) grid, 160 x 100 cells by default, with dt = 1/60 s. Each step:

1. **Forcing.** Painted velocity on open fluid is a fan: each face relaxes toward the painted target at 5/s, weighted by how much of the face touches painted cells. Curls are stamped into this field, so they stir for the whole run.
2. **Advection.** MacCormack with an RK2 backtrace and a min/max limiter, which keeps vortices much crisper than plain semi-Lagrangian advection.
3. **Viscosity.** Implicit diffusion, `(I - nu dt lap) u = u*`, by Jacobi iteration. Walls are no-slip.
4. **Projection.** A red-black SOR pressure solve that makes `div u = q` in every fluid cell. Sources (`q > 0`) and sinks (`q < 0`) are real mass sources and drains, which is why a click-stamped source survives the pressure solve instead of being projected away.

Inflow cells are prescribed-velocity boundaries. Open edges hold `p = 0` outside the tank, so fluid can leave or enter. With walled edges the Neumann problem needs zero net source, so any imbalance (an inflow with no sink) is spread evenly over the tank.

**Beads** have a uniform radius and feel drag toward the local fluid velocity with response time `tau` (the inertia setting): `dv/dt = (u - v) / tau`. Small `tau` makes tracers; large `tau` makes heavy beads that fling outward on curves. They collide with walls and with each other. Coupling is one-way: the fluid moves beads, but beads do not push the fluid. A sink drains fluid volume at rate `-q`, so a bead in a sink cell is absorbed with the same rate, `P = 1 - exp(q dt)` per step.

The score is beads that ever touched the goal divided by beads released.

## Files

The **map PNG** has one pixel per cell in four key colors. You can draw maps in any paint program and load them; any other color snaps to the nearest key, and transparent pixels count as open fluid. Images larger than 320 x 200 are scaled down.

| Element    | Color             |
|------------|-------------------|
| Open fluid | black `#000000`   |
| Wall       | gray `#808080`    |
| Goal       | white `#FFFFFF`   |
| Inflow     | cyan `#00FFFF`    |

The **velocity file** (`.flow.json`) holds the fields over the same grid, row-major (`index = x + y * width`, y increasing downward):

```json
{
  "format": "fluid-sandbox",
  "version": 1,
  "name": "vortex-street",
  "width": 160,
  "height": 100,
  "params": { "maxTime": 40, "emissionRate": 70, "viscosity": 0.003,
              "beadRadius": 0.45, "beadInertia": 0.05, "edges": "open" },
  "velocity": { "x": [ ... ], "y": [ ... ] },
  "divergence": [ ... ],
  "markers": [ { "kind": "curl", "x": 80, "y": 50, "r": 18 } ]
}
```

Velocities are in cells per second. For open and goal cells they are fan targets; for inflow cells they are the prescribed inflow. Divergence is per second, positive for sources. Markers only position the source, sink and curl glyphs.

## Running locally

It is a static site with no build step. Serve the folder with any static server, for example:

```
python3 -m http.server
```

then open http://localhost:8000. (Opening `index.html` directly from disk will not work, because browsers block ES modules on `file://`.)

## Code

| File               | What it does                                                       |
|--------------------|--------------------------------------------------------------------|
| `js/fluid.js`      | MAC-grid Navier-Stokes solver                                      |
| `js/beads.js`      | Bead emission, drag, collisions, goal and sink bookkeeping         |
| `js/state.js`      | Scenario data: cell types, velocity and divergence fields, markers |
| `js/edit.js`       | Painting and stamping primitives                                   |
| `js/render.js`     | Canvas rendering                                                   |
| `js/io.js`         | PNG and JSON save and load                                         |
| `js/examples.js`   | Built-in scenarios                                                 |
| `js/main.js`       | UI controller                                                      |
