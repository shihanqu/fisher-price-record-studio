// Read the tune off a photograph of a Fisher-Price record, in the browser.
//
// A port of fpmb/extract.py, following the same steps:
//   1. segment the coloured disc, fit an ellipse to its outline and warp the
//      photo so the disc becomes a circle at 16 px/mm;
//   2. find the centre and drive holes and refine the warp to a homography
//      (under perspective the ellipse centre is not the disc centre);
//   3. unwrap the disc into polar coordinates (angle x radius);
//   4. locate the groove walls sector by sector;
//   5. for each of the 22 pin tracks build a signal that reads about 1 at wall
//      height and 0 on the groove floor, and pick peaks;
//   6. turn pin angles into beats and pitches.
// tests/test_js_parity.py runs this on the reference photos and checks that
// it finds the same pins as the Python version.

import * as G from './geometry.js';
import * as IP from './imgproc.js';
import * as SG from './signal.js';
import { arange, median, pymod, pyround } from './pyfn.js';
import { makeNote, makeScore } from './score.js';

export const PX_PER_MM = 16.0;          // working resolution of the straightened disc
export const RECT_MARGIN_MM = 4.0;
export const POLAR_DEG_STEP = 0.1;
export const POLAR_MM_STEP = 0.05;
export const POLAR_R_MIN = 24.0;
export const POLAR_R_MAX = G.DISC_RADIUS + 1.0;

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ------------------------------------------------------------------ 1. the disc

/** Mask of the record: the dominant strong hue near the middle of the photo, cleaned up. */
export function discMask(rgba, w, h, keepHoles = true) {
  const n = w * h;
  const { H, sat } = IP.hueAndSat(rgba, n);
  const cy = h >> 1, cx = w >> 1, r = Math.min(cx, cy) >> 1;
  const hist = new Float64Array(180);
  for (let y = cy - r; y < cy + r; y++) for (let x = cx - r; x < cx + r; x++) { const p = y * w + x; if (sat[p]) hist[H[p]]++; }
  const smooth = SG.gaussian1d(hist, 3, 'wrap');
  let hue0 = 0;
  for (let i = 1; i < 180; i++) if (smooth[i] > smooth[hue0]) hue0 = i;
  let m = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    if (!sat[p]) continue;
    const d = Math.abs(H[p] - hue0);
    if (Math.min(d, 180 - d) < 14) m[p] = 1;
  }
  m = IP.close(IP.open(m, w, h, 7), w, h, 7);
  const comp = IP.largestComponent(m, w, h);
  if (!comp) return null;
  const filled = IP.fillHoles(comp.mask, w, h);
  if (keepHoles) for (let p = 0; p < n; p++) filled[p] &= m[p];
  return filled;
}

/** Affine map taking the fitted ellipse to a circle of DISC_RADIUS mm, centred in a size x size image. */
function affineFromEllipse(e, pxPerMm, size) {
  const R = G.DISC_RADIUS * pxPerMm, c = size / 2;
  const ct = Math.cos(e.theta), st = Math.sin(e.theta);
  const A = [[(R / e.a) * ct, (R / e.a) * st, 0], [(-R / e.b) * st, (R / e.b) * ct, 0], [0, 0, 1]];
  A[0][2] = c - (A[0][0] * e.cx + A[0][1] * e.cy);
  A[1][2] = c - (A[1][0] * e.cx + A[1][1] * e.cy);
  return A;
}

// ------------------------------------------------------------------ 2. holes and homography

function findHoles(rmask, size, pxPerMm) {
  const c = size / 2, lim = (G.LABEL_RADIUS - 1.0) * pxPerMm;
  let holes = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const p = y * size + x;
    if (!rmask[p] && Math.hypot(x - c, y - c) < lim) holes[p] = 1;
  }
  holes = IP.open(holes, size, size, 3);
  const cands = [];
  for (const s of IP.components(holes, size, size).stats) {
    const area = s.area / pxPerMm ** 2, fill = s.area / ((Math.PI / 4) * s.bw * s.bh + 1e-6);
    if (area > 1.5 && area < 80 && s.bw / s.bh > 0.6 && s.bw / s.bh < 1.6 && fill > 0.6) cands.push({ x: s.cx, y: s.cy, area });
  }
  if (!cands.length) return null;
  const dist = (k) => Math.hypot(k.x - c, k.y - c);
  let centre = cands[0];
  for (const k of cands) if (dist(k) < dist(centre)) centre = k;
  if (dist(centre) > 6 * pxPerMm) centre = null;
  const drive = cands.filter((k) => Math.abs(dist(k) / pxPerMm - G.DRIVE_HOLE_OFFSET) < 3.0 && k.area < 30);
  return { centre, drive };
}

/** Homography that puts the holes where they belong and the rim on a circle (iterated, like the Python). */
function refineHomography(rmask, size, holes, pxPerMm) {
  const c = size / 2, R = G.DISC_RADIUS * pxPerMm;
  const holeSrc = [], holeDst = [];
  if (holes.drive.length === 4) {
    const ang = holes.drive.map((p) => Math.atan2(p.y - c, p.x - c));
    let s4 = 0, c4 = 0;
    for (const a of ang) { s4 += Math.sin(4 * a); c4 += Math.cos(4 * a); }
    const phase = Math.atan2(s4 / 4, c4 / 4) / 4;
    holes.drive.forEach((p, i) => {
      const a2 = phase + pyround((ang[i] - phase) / (Math.PI / 2)) * (Math.PI / 2);
      holeSrc.push([p.x, p.y]);
      holeDst.push([c + G.DRIVE_HOLE_OFFSET * pxPerMm * Math.cos(a2), c + G.DRIVE_HOLE_OFFSET * pxPerMm * Math.sin(a2)]);
    });
  }
  if (holes.centre) { holeSrc.push([holes.centre.x, holes.centre.y]); holeDst.push([c, c]); }
  const comp = IP.largestComponent(rmask, size, size);
  const rim = IP.hullOfMask(comp, size).filter(([x, y]) => Math.abs(Math.hypot(x - c, y - c) - R) < 0.06 * R);
  if (rim.length < 8) return IP.eye3();
  let H = IP.eye3();
  if (holeSrc.length >= 4) H = IP.findHomography(holeSrc, holeDst) || IP.eye3();
  for (let it = 0; it < 4; it++) {
    const rimDst = rim.map((p) => { const [x, y] = IP.apply3(H, p); const a = Math.atan2(y - c, x - c); return [c + R * Math.cos(a), c + R * Math.sin(a)]; });
    const rep = holeSrc.length ? Math.max(1, Math.floor(rim.length / holeSrc.length)) : 0;
    const src = rim.slice(), dst = rimDst.slice();
    for (let k = 0; k < rep; k++) { src.push(...holeSrc); dst.push(...holeDst); }
    const H2 = IP.findHomography(src, dst);
    if (!H2) break;
    H = H2;
  }
  return H;
}

// ------------------------------------------------------------------ 4. grooves

/** +1 on wall tops, -1 on groove floors, 0 elsewhere, for the nominal layout at a given scale and offset. */
function wallTemplate(rads, scale, off) {
  const t = new Float64Array(rads.length);
  const set = (lo, hi, v) => { for (let j = 0; j < rads.length; j++) if (rads[j] > lo && rads[j] < hi) t[j] = v; };
  for (const r0 of G.GROOVE_INNER_RADII) {
    const ri = r0 * scale + off, ro = ri + G.GROOVE_WIDTH * scale;
    set(ri + 0.2, ro - 0.2, -1);
    set(ri - (G.GROOVE_PITCH - G.GROOVE_WIDTH) * scale + 0.1, ri - 0.1, 1);
  }
  const last = G.GROOVE_INNER_RADII[G.N_GROOVES - 1];
  set(last * scale + off + G.GROOVE_WIDTH * scale + 0.1, (last + G.GROOVE_PITCH) * scale + off, 1);
  return t;
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/**
 * Where the groove walls actually are: a global scale and offset, then a
 * radial offset per 10-degree sector, smoothed and interpolated to every angle.
 */
function fitGrooves(pol, nA, nR, angs, rads, valid, nSectors = 36) {
  // hp = pol minus a radial Gaussian (sigma 2 mm), zeroed where the disc is hidden.
  // Only sums of hp over angles are needed, so the Gaussian is applied to row
  // sums (it is linear); hidden samples are corrected one by one.
  const { k, radius } = SG.gaussianKernel(2.0 / POLAR_MM_STEP);
  const per = Math.floor(nA / nSectors);
  const secHp = [];
  for (let s = 0; s < nSectors; s++) {
    const all = new Float64Array(nR), vis = new Float64Array(nR), corr = new Float64Array(nR);
    const a0 = s * per, a1 = s === nSectors - 1 ? nA : a0 + per;
    for (let a = a0; a < a1; a++) {
      const row = a * nR;
      for (let r = 0; r < nR; r++) {
        const v = pol[row + r];
        all[r] += v;
        if (valid[row + r]) vis[r] += v;
        else corr[r] += SG.gaussianAtReflect(pol, row, nR, r, k, radius);
      }
    }
    const gAll = SG.gaussian1d(all, 2.0 / POLAR_MM_STEP, 'reflect');
    const hp = new Float64Array(nR);
    for (let r = 0; r < nR; r++) hp[r] = vis[r] - gAll[r] + corr[r];
    secHp.push({ hp, count: a1 - a0, centre: (angs[a0] + angs[a1 - 1]) / 2 });
  }
  const prof = new Float64Array(nR);
  for (const s of secHp) for (let r = 0; r < nR; r++) prof[r] += s.hp[r] / nA;

  let best = null;
  for (const scale of [0.99, 0.995, 1.0, 1.005, 1.01]) {
    for (const off of arange(-1.0, 1.0, 0.025)) {
      const cval = dot(prof, wallTemplate(rads, scale, off));
      if (best === null || Math.abs(cval) > Math.abs(best[0])) best = [cval, scale, off];
    }
  }
  const [corr, scale, off0] = best;
  const sign = corr > 0 ? 1 : -1;                      // +1: walls brighter than floors
  const offs = [], centres = [];
  for (const s of secHp) {
    const p = s.hp.map((v) => (v / s.count) * sign);
    let bo = off0, bc = -1e9;
    for (const off of arange(off0 - 0.6, off0 + 0.6, 0.025)) {
      const cval = dot(p, wallTemplate(rads, scale, off));
      if (cval > bc) { bo = off; bc = cval; }
    }
    offs.push(bo); centres.push(s.centre);
  }
  const offsS = SG.gaussian1d(offs, 1.0, 'wrap');
  const extC = [...centres.map((c) => c - 360), ...centres, ...centres.map((c) => c + 360)];
  const extO = [...offsS, ...offsS, ...offsS];
  const perAngle = new Float64Array(nA);
  let j = 0;
  for (let i = 0; i < nA; i++) {
    const a = angs[i];
    while (j + 2 < extC.length && extC[j + 1] <= a) j++;
    perAngle[i] = extO[j] + ((extO[j + 1] - extO[j]) * (a - extC[j])) / (extC[j + 1] - extC[j]);
  }
  return { off: perAngle, scale, sign, fit: { global_offset_mm: off0, scale, sector_offsets_mm: offs, walls_brighter: sign > 0 } };
}

// ------------------------------------------------------------------ 5. pins

/** Mean over a radial band [lo[i], hi[i]] at every angle i (the band may move with angle). */
function band(img, nA, nR, lo, hi) {
  let wsum = 0;
  for (let i = 0; i < nA; i++) wsum += hi[i] - lo[i];
  const n = Math.max(2, Math.trunc(wsum / nA / POLAR_MM_STEP));
  const out = new Float64Array(nA);
  for (let i = 0; i < nA; i++) {
    const row = i * nR;
    let s = 0;
    for (let j = 0; j < n; j++) {
      const f = (lo[i] + ((hi[i] - lo[i]) * j) / (n - 1) - POLAR_R_MIN) / POLAR_MM_STEP;
      if (f <= 0) s += img[row];
      else if (f >= nR - 1) s += img[row + nR - 1];
      else { const k0 = Math.floor(f), t = f - k0; s += img[row + k0] * (1 - t) + img[row + k0 + 1] * t; }
    }
    out[i] = s / n;
  }
  return out;
}

function detectPins(pol, nA, nR, angs, off, scale, sign, minStrength, valid, snrMin = 8.0, minStrengthSnr = 0.3) {
  const win = Math.trunc(12.0 / POLAR_DEG_STEP);
  const N = pol.length;
  // Floor map: a low percentile along the angle at every radius removes whatever is
  // constant around the disc (floor shading, wall faces seen in perspective) but keeps the sparse pins.
  const A = new Float32Array(N);
  for (let i = 0; i < N; i++) A[i] = pol[i] * sign;
  const F = SG.rankFilterColumnsWrap(A, nA, nR, win, Math.trunc(0.25 * win));
  const hp = new Float32Array(N), vf = new Float32Array(N);
  for (let i = 0; i < N; i++) { hp[i] = A[i] - F[i]; vf[i] = valid[i]; }
  const shift = (base, d) => { const o = new Float64Array(nA); for (let i = 0; i < nA; i++) o[i] = base[i] + d; return o; };
  const zip = (a, b, fn) => { const o = new Float64Array(nA); for (let i = 0; i < nA; i++) o[i] = fn(a[i], b[i]); return o; };
  const sm = 0.3 / POLAR_DEG_STEP;
  const pins = [], details = [];
  for (let g = 0; g < G.N_GROOVES; g++) {
    const ri = new Float64Array(nA), ro = new Float64Array(nA);
    for (let i = 0; i < nA; i++) { ri[i] = G.GROOVE_INNER_RADII[g] * scale + off[i]; ro[i] = ri[i] + G.GROOVE_WIDTH * scale; }
    const wallW = (G.GROOVE_PITCH - G.GROOVE_WIDTH) * scale;
    // reference: neighbouring wall tops relative to this groove's floor
    const fl = band(F, nA, nR, shift(ri, 0.6), shift(ro, -0.6));
    const wIn = zip(band(A, nA, nR, shift(ri, -wallW + 0.15), shift(ri, -0.15)), fl, (a, b) => a - b);
    const wOut = zip(band(A, nA, nR, shift(ro, 0.15), shift(ro, wallW - 0.15)), fl, (a, b) => a - b);
    for (const side of [0, 1]) {
      const track = 2 * g + side;
      // three radial bands from the wall face to the pin tip: root, near, far
      const [root, near, far, wref, lo, hi] = side === 0
        ? [band(hp, nA, nR, shift(ri, 0.10), shift(ri, 0.35)), band(hp, nA, nR, shift(ri, 0.10), shift(ri, 0.55)), band(hp, nA, nR, shift(ri, 0.55), shift(ri, 0.95)), wIn, shift(ri, 0.1), shift(ri, 0.95)]
        : [band(hp, nA, nR, shift(ro, -0.35), shift(ro, -0.10)), band(hp, nA, nR, shift(ro, -0.55), shift(ro, -0.10)), band(hp, nA, nR, shift(ro, -0.95), shift(ro, -0.55)), wOut, shift(ro, -0.95), shift(ro, -0.1)];
      // Where the neighbouring wall is in shadow its level collapses and would
      // inflate every ratio, so it never drops below half its typical value.
      const wall = SG.medianFilterWrap(wref, win);
      const wallFloor = 0.5 * median(wall);
      for (let i = 0; i < nA; i++) wall[i] = Math.max(Math.max(wall[i], wallFloor), 1e-3);
      const zr = SG.gaussian1d(zip(root, wall, (a, b) => a / b), sm, 'wrap');
      const zn = SG.gaussian1d(zip(near, wall, (a, b) => a / b), sm, 'wrap');
      const zf = SG.gaussian1d(zip(far, wall, (a, b) => a / b), sm, 'wrap');
      // a real pin is at wall height from the wall face to its tip
      const z = new Float64Array(nA);
      for (let i = 0; i < nA; i++) z[i] = Math.min(zr[i], zn[i], zf[i]);
      // lighting-independent view: how far the band stands above the floor's own noise
      const raw = zip(SG.gaussian1d(near, sm, 'wrap'), SG.gaussian1d(far, sm, 'wrap'), Math.min);
      const dev = zip(raw, SG.medianFilterWrap(raw, win), (a, b) => Math.abs(a - b));
      const noise = SG.medianFilterWrap(dev, win);
      const snr = new Float64Array(nA);
      for (let i = 0; i < nA; i++) snr[i] = raw[i] / Math.max(1.4826 * noise[i], 1e-6);
      let lh = 0;
      for (let i = 0; i < nA; i++) lh += lo[i] + hi[i];
      const pinDeg = G.DEG * (G.PIN_TANGENTIAL / ((0.5 * lh) / nA));
      const dist = Math.trunc(Math.max(1, (1.8 * pinDeg) / POLAR_DEG_STEP));
      const wlim = [(0.4 * pinDeg) / POLAR_DEG_STEP, (3.0 * pinDeg) / POLAR_DEG_STEP];
      const vb = band(vf, nA, nR, shift(lo, -0.5), shift(hi, 0.5));
      const found = new Map();
      // path 1: strong relative to the wall top
      const p1 = SG.findPeaks(SG.tile3(z), { height: minStrength, prominence: 0.3, distance: dist, width: wlim });
      p1.peaks.forEach((p, q) => { if (p >= nA && p < 2 * nA) found.set(p - nA, p1.heights[q]); });
      // path 2: well clear of the floor noise and at least a little of wall height
      for (const p of SG.findPeaks(SG.tile3(snr), { height: snrMin, prominence: snrMin * 0.6, distance: dist, width: wlim }).peaks) {
        if (p < nA || p >= 2 * nA) continue;
        const i = p - nA;
        if (z[i] < minStrengthSnr) continue;
        let near_ = false;
        for (const j of found.keys()) if (Math.abs(i - j) < dist) { near_ = true; break; }
        if (!near_) found.set(i, Math.max(z[i], minStrength));
      }
      for (const i of [...found.keys()].sort((a, b) => a - b)) {
        if (!(vb[i] > 0.99)) continue;
        pins.push([track, angs[i], found.get(i)]);
        details.push({ track, angle: angs[i], z: z[i], snr: snr[i], zn: zn[i], zf: zf[i], wall: wall[i], path: z[i] >= minStrength ? 'wall' : 'snr' });
      }
    }
  }
  return { pins, details };
}

// ------------------------------------------------------------------ 6. pins -> score

/**
 * Pins to a score. Time runs with increasing angle (the record turns clockwise
 * seen from above) and the tone-arm offset is undone. Beat 0 goes in the
 * middle of the longest silence unless startAngle is given.
 */
export function pinsToScore(pins, title = '', secondsPerRev = G.SECONDS_PER_REV, beatsPerRev = 360, startAngle = null) {
  const ev = pins.map(([track, ang, s]) => [pymod(ang + G.headOffsetDeg(G.trackRadius(track)), 360), track, s]);
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  if (!ev.length) return makeScore({ length_beats: beatsPerRev, title, seconds_per_rev: secondsPerRev });
  if (startAngle === null) {
    let bi = 0, bg = -1;
    for (let i = 0; i < ev.length; i++) {
      const gap = (i + 1 < ev.length ? ev[i + 1][0] : ev[0][0] + 360) - ev[i][0];
      if (gap > bg) { bg = gap; bi = i; }
    }
    startAngle = pymod(ev[bi][0] + bg * 0.5, 360);
  }
  const sc = makeScore({ length_beats: beatsPerRev, title, seconds_per_rev: secondsPerRev, meta: { start_angle_deg: startAngle } });
  for (const [t, track, s] of ev) sc.notes.push(makeNote((pymod(t - startAngle, 360) / 360) * beatsPerRev, G.TRACK_MIDI[track], track, Math.min(1, s)));
  sc.notes.sort((a, b) => a.beat - b.beat);
  return sc;
}

// ------------------------------------------------------------------ driver

/**
 * Run the whole pipeline on an RGBA image ({data, width, height}).
 * Returns the score, the raw pins [track, angle, strength], warnings, the
 * groove fit and a straightened copy of the photo for display.
 */
export function extractFromRGBA({ data, width: w, height: h }, opts = {}) {
  const { title = '', sourceName = '', minStrength = 0.5, secondsPerRev = G.SECONDS_PER_REV, pxPerMm = PX_PER_MM, overlaySize = 1033, onProgress = () => {} } = opts;
  const timings = {};
  let t = nowMs();
  const lap = (name) => { const t2 = nowMs(); timings[name] = Math.round(t2 - t); t = t2; };
  const warnings = [];

  onProgress('Finding the record in the photo');
  const mask = discMask(data, w, h, true);
  const comp = mask && IP.largestComponent(mask, w, h);
  if (!comp || comp.area < 2000) throw new Error("Couldn't find a record in this photo. Make sure the whole grooved side is in view.");
  const ell = IP.fitEllipse(IP.hullOfMask(comp, w));
  const size = Math.trunc(2 * (G.DISC_RADIUS + RECT_MARGIN_MM) * pxPerMm);
  const A = affineFromEllipse(ell, pxPerMm, size);
  lap('disc');

  onProgress('Straightening the disc');
  const rmask = IP.warpMaskNearest(mask, w, h, IP.inv3(A), size, size);
  const holes = findHoles(rmask, size, pxPerMm);
  let H = IP.eye3();
  if (holes) {
    H = refineHomography(rmask, size, holes, pxPerMm);
    if (holes.drive.length !== 4) warnings.push(`found ${holes.drive.length} drive holes (expected 4); perspective refinement is rim-only`);
  } else {
    warnings.push('no holes found; perspective refinement is rim-only');
  }
  const Tinv = IP.inv3(IP.mul3(H, A));
  const rect = IP.warpGray(IP.rgbaToGray(data, w * h), w, h, Tinv, size, size);
  const blur = IP.gaussianBlurApprox(rect, size, size, 3.0 * pxPerMm);   // local contrast normalisation
  for (let i = 0; i < rect.length; i++) rect[i] -= blur[i];
  const angs = arange(0, 360, POLAR_DEG_STEP), rads = arange(POLAR_R_MIN, POLAR_R_MAX, POLAR_MM_STEP);
  const nA = angs.length, nR = rads.length;
  const pol = IP.remapPolar(rect, size, size, size / 2, size / 2, pxPerMm, angs, rads);
  lap('straighten');

  // where the disc surface is actually visible (not under a finger or the tone arm)
  const rmask2 = IP.warpMaskNearest(mask, w, h, Tinv, size, size);
  const filled = IP.fillHoles(IP.largestComponent(rmask2, size, size).mask, size, size);
  let occ = new Uint8Array(size * size);
  for (let p = 0; p < occ.length; p++) occ[p] = filled[p] & (rmask2[p] ^ 1);
  occ = IP.open(occ, size, size, Math.trunc(2.5 * pxPerMm) | 1);
  occ = IP.dilate(occ, size, size, Math.trunc(1.5 * pxPerMm) | 1);
  const vm = new Float32Array(size * size);
  for (let p = 0; p < vm.length; p++) vm[p] = filled[p] && !occ[p] ? 255 : 0;
  const vpol = IP.remapPolar(vm, size, size, size / 2, size / 2, pxPerMm, angs, rads);
  const valid = new Uint8Array(nA * nR);
  for (let i = 0; i < valid.length; i++) valid[i] = vpol[i] > 127 ? 1 : 0;
  const bandLo = G.GROOVE_INNER_RADII[0], bandHi = G.GROOVE_INNER_RADII[G.N_GROOVES - 1] + G.GROOVE_WIDTH;
  const visibleByAngle = new Float64Array(nA);
  let vsum = 0, vcount = 0;
  for (let i = 0; i < nA; i++) {
    let s = 0, c = 0;
    for (let j = 0; j < nR; j++) if (rads[j] > bandLo && rads[j] < bandHi) { s += valid[i * nR + j]; c++; }
    visibleByAngle[i] = s / c; vsum += s; vcount += c;
  }
  const coverage = vsum / vcount;
  if (coverage < 0.98) warnings.push(`only ${Math.round(100 * coverage)}% of the groove area is visible; notes in hidden sectors are missing`);
  lap('visibility');

  onProgress('Locating the grooves');
  const gf = fitGrooves(pol, nA, nR, angs, rads, valid);
  if (Math.abs(gf.fit.global_offset_mm) > 0.9 || !(gf.scale > 0.975 && gf.scale < 1.025)) {
    warnings.push(`groove fit is far from nominal (offset ${gf.fit.global_offset_mm.toFixed(2)} mm, scale ${gf.scale.toFixed(3)})`);
  }
  lap('grooves');

  onProgress('Reading the pins on 22 tracks');
  const { pins, details } = detectPins(pol, nA, nR, angs, gf.off, gf.scale, gf.sign, minStrength, valid);
  const score = pinsToScore(pins, title, secondsPerRev);
  Object.assign(score.meta, {
    source_image: sourceName || title, n_pins: pins.length, visible_fraction: coverage,
    groove_fit: { global_offset_mm: gf.fit.global_offset_mm, scale: gf.scale, walls_brighter: gf.fit.walls_brighter },
  });
  lap('pins');

  const D = overlaySize, k = size / D;
  const overlay = { width: D, height: D, pxPerMm: pxPerMm / k, data: IP.warpRGBA(data, w, h, IP.mul3(Tinv, [[k, 0, 0], [0, k, 0], [0, 0, 1]]), D, D) };
  lap('overlay');
  return { score, pins, pinDetails: details, warnings, grooveFit: gf.fit, coverage, visibleByAngle, homography: H, ellipse: ell, overlay, timings };
}
