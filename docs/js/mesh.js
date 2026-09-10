// Build a printable record in the browser with manifold (WebAssembly build),
// the same CSG library fpmb/mesh.py uses, so the STL matches the command line.
//
// The model follows the original record: a flat disc with a recessed centre
// label, a centre hole and four drive holes, eleven 2 mm grooves cut 1.2 mm
// deep, and a 1 x 1 mm pin growing out of the inner or outer groove wall for
// every note.

import Module from '../vendor/manifold/manifold.js';
import * as G from './geometry.js';
import { pymod } from './pyfn.js';
import { assignTracks, beatToAngle } from './score.js';
import { textPolygons } from './strokefont.js';

let wasmPromise = null;
/** Load (once) and return the manifold WebAssembly module. */
export function loadManifold() {
  if (!wasmPromise) wasmPromise = Module().then((wasm) => { wasm.setup(); return wasm; });
  return wasmPromise;
}

export const MESH_DEFAULTS = {
  thickness: G.DISC_THICKNESS,
  bottomInset: false,     // recess the label area on the underside too
  pinTangential: G.PIN_TANGENTIAL,
  pinRadial: G.PIN_RADIAL,
  pinOverlap: 0.25,       // how far a pin is buried in its wall
  segments: 720,          // circle resolution (0.5 degree)
  label: '',
  labelSize: 5.0,
  labelDepth: 0.6,
};

/** Where a note at `beat` on `track` sits on the disc, tone-arm offset included. */
export const pinAngle = (sc, beat, track) => pymod(beatToAngle(sc, beat) - G.headOffsetDeg(G.trackRadius(track)), 360);

// Every manifold object lives in WebAssembly memory and must be freed by hand.
// Each build collects what it creates and deletes it all at the end.
function arena() {
  const made = [];
  return { own: (o) => (made.push(o), o), release: (keep) => { for (const o of made) if (o !== keep) o.delete(); made.length = 0; } };
}

function makeBlank({ Manifold }, opt) {
  const { own, release } = arena();
  const T = opt.thickness, seg = opt.segments;
  const cyl = (r, h, z0, s) => own(own(Manifold.cylinder(h, r, r, s)).translate([0, 0, z0]));
  let m = cyl(G.DISC_RADIUS, T, 0, seg);
  m = own(m.subtract(cyl(G.LABEL_RADIUS, G.LABEL_INSET + 0.01, T - G.LABEL_INSET, seg >> 1)));
  if (opt.bottomInset) m = own(m.subtract(cyl(G.LABEL_RADIUS, G.LABEL_INSET + 0.01, -0.01, seg >> 1)));
  m = own(m.subtract(cyl(G.CENTER_HOLE_RADIUS, T + 2, -1, 96)));
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    m = own(m.subtract(own(cyl(G.DRIVE_HOLE_RADIUS, T + 2, -1, 64).translate([G.DRIVE_HOLE_OFFSET * Math.cos(a), G.DRIVE_HOLE_OFFSET * Math.sin(a), 0]))));
  }
  for (const r0 of G.GROOVE_INNER_RADII) {
    const ring = own(cyl(r0 + G.GROOVE_WIDTH, G.GROOVE_DEPTH + 0.01, T - G.GROOVE_DEPTH, seg).subtract(cyl(r0, G.GROOVE_DEPTH + 0.02, T - G.GROOVE_DEPTH - 0.005, seg)));
    m = own(m.subtract(ring));
  }
  release(m);
  return m;
}

let blank = null;   // { key, manifold }: the disc without pins, reused while the options stay the same

/**
 * Build the record for a score. Notes without a track are assigned one first
 * (the score is modified). Returns the triangle mesh and a few stats.
 */
export async function buildRecord(sc, options = {}) {
  const opt = { ...MESH_DEFAULTS, ...options };
  const wasm = await loadManifold();
  const { Manifold, CrossSection } = wasm;
  if (sc.notes.some((n) => n.track === null || n.track === undefined)) assignTracks(sc);
  const key = `${opt.thickness}|${opt.bottomInset}|${opt.segments}`;
  if (!blank || blank.key !== key) {
    if (blank) blank.manifold.delete();
    blank = { key, manifold: makeBlank(wasm, opt) };
  }
  const { own, release } = arena();
  try {
    const T = opt.thickness;
    let m = blank.manifold;
    const pins = sc.notes.filter((n) => n.track !== null && n.track !== undefined).map((n) => {
      const r0 = G.GROOVE_INNER_RADII[n.track >> 1];
      const [rIn, rOut] = n.track % 2 === 0
        ? [r0 - opt.pinOverlap, r0 + opt.pinRadial]
        : [r0 + G.GROOVE_WIDTH - opt.pinRadial, r0 + G.GROOVE_WIDTH + opt.pinOverlap];
      const box = own(Manifold.cube([rOut - rIn, opt.pinTangential, G.GROOVE_DEPTH + 0.05]));
      const placed = own(box.translate([rIn, -opt.pinTangential / 2, T - G.GROOVE_DEPTH - 0.05]));
      return own(placed.rotate([0, 0, pinAngle(sc, n.beat, n.track)]));
    });
    if (pins.length) m = own(m.add(own(Manifold.union(pins))));
    if (opt.label) {
      const polys = textPolygons(opt.label, opt.labelSize, opt.labelSize * 0.16);
      if (polys.length) {
        const cs = own(new CrossSection(polys, 'Positive'));
        if (cs.area() > 0) m = own(m.add(own(own(Manifold.extrude(cs, opt.labelDepth)).translate([0, -G.LABEL_RADIUS * 0.55, T - G.LABEL_INSET]))));
      }
    }
    const mesh = m.getMesh();
    return {
      numProp: mesh.numProp, vertProperties: mesh.vertProperties, triVerts: mesh.triVerts,
      triangles: mesh.triVerts.length / 3, volume: m.volume(), genus: m.genus(),
    };
  } finally {
    release();
  }
}

/** Binary STL bytes for a mesh from buildRecord(). */
export function toSTL({ vertProperties: v, triVerts: f, numProp = 3 }) {
  const nTri = f.length / 3;
  const buf = new ArrayBuffer(84 + nTri * 50);
  const dv = new DataView(buf);
  const header = 'fpmb record';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, nTri, true);
  let o = 84;
  const P = (i, k) => v[f[i] * numProp + k];
  for (let t = 0; t < nTri; t++) {
    const a = 3 * t, b = a + 1, c = a + 2;
    const ux = P(b, 0) - P(a, 0), uy = P(b, 1) - P(a, 1), uz = P(b, 2) - P(a, 2);
    const wx = P(c, 0) - P(a, 0), wy = P(c, 1) - P(a, 1), wz = P(c, 2) - P(a, 2);
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) + 1e-12;
    nx /= len; ny /= len; nz /= len;
    for (const val of [nx, ny, nz]) { dv.setFloat32(o, val, true); o += 4; }
    for (const i of [a, b, c]) for (let k = 0; k < 3; k++) { dv.setFloat32(o, P(i, k), true); o += 4; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return buf;
}
