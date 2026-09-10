// Note-event model shared by the scanner, synthesiser, mesher and designer.
// Mirrors fpmb/score.py. A score is a plain object with the same JSON shape:
//   { title, length_beats, seconds_per_rev, meta, notes: [{beat, midi, track?, velocity}] }
// One revolution of the record holds `length_beats` beats.

import * as G from './geometry.js';
import { pymod, pyround } from './pyfn.js';

export function makeNote(beat, midi, track = null, velocity = 1.0) {
  return { beat, midi, track, velocity };
}

export function makeScore({ length_beats, notes = [], title = '', seconds_per_rev = G.SECONDS_PER_REV, meta = {} }) {
  return { title, length_beats, seconds_per_rev, meta, notes };
}

export const noteOrder = (a, b) => a.beat - b.beat || a.midi - b.midi;
export const beatToAngle = (sc, beat) => 360 * (beat / sc.length_beats);
export const beatToSeconds = (sc, beat) => sc.seconds_per_rev * beat / sc.length_beats;

/** The JSON form written by both the Python and the browser tools. */
export function toDict(sc) {
  return {
    title: sc.title,
    length_beats: sc.length_beats,
    seconds_per_rev: sc.seconds_per_rev,
    meta: sc.meta,
    notes: sc.notes.slice().sort(noteOrder).map((n) => {
      const o = { beat: n.beat, midi: n.midi };
      if (n.track !== null && n.track !== undefined) o.track = n.track;
      o.velocity = n.velocity ?? 1.0;
      return o;
    }),
  };
}

export function fromDict(d) {
  return makeScore({
    length_beats: Number(d.length_beats),
    title: d.title || '',
    seconds_per_rev: Number(d.seconds_per_rev ?? G.SECONDS_PER_REV),
    meta: d.meta ? structuredClone(d.meta) : {},
    notes: (d.notes || []).map((n) => makeNote(Number(n.beat), Math.trunc(Number(n.midi)), n.track ?? null, Number(n.velocity ?? 1))),
  });
}

export const cloneScore = (sc) => fromDict(toDict(sc));

// --------------------------------------------------------------- importers

const NOTE_RE = /^([A-Ga-g])([#b]?)(-?\d)$/;
const NOTE_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 'C5' -> 72, 'Eb4' -> 63, 'D#4' -> 63. */
export function parseNoteName(name) {
  const m = NOTE_RE.exec(name.trim());
  if (!m) throw new Error(`bad note name '${name}'`);
  return 12 * (parseInt(m[3], 10) + 1) + NOTE_BASE[m[1].toUpperCase()] + { '': 0, '#': 1, b: -1 }[m[2]];
}

/**
 * Tiny text notation, one step per whitespace-separated token:
 *   C5 Eb5 G5 C6 . G5 Eb5+C5 . |
 * '.', '-' or '_' is a rest, '+' joins a chord, '|' is a bar line and is
 * ignored, and a token starting with '#' comments out the rest of the line.
 */
export function parseText(text, beatsPerStep = 1.0, title = '') {
  const notes = [];
  let step = 0;
  for (const line of text.split(/\r\n|\r|\n/)) {
    for (const tok of line.split(/\s+/).filter(Boolean)) {
      if (tok.startsWith('#')) break;
      if (tok === '|') continue;
      if (!['.', '-', '_'].includes(tok)) for (const part of tok.split('+')) notes.push(makeNote(step * beatsPerStep, parseNoteName(part)));
      step++;
    }
  }
  return makeScore({ length_beats: step * beatsPerStep, notes, title });
}

// --------------------------------------------------- fitting a loop to the comb

/** [semitones, unplayable] for the shift that keeps the most notes on the comb, smallest shift first. */
export function bestTransposition(midis, lo = -24, hi = 24) {
  const shifts = [];
  for (let s = lo; s <= hi; s++) shifts.push(s);
  shifts.sort((a, b) => Math.abs(a) - Math.abs(b));      // stable: -1 before +1, as in Python
  let best = null;
  for (const s of shifts) {
    const bad = midis.filter((m) => !G.isPlayable(m + s)).length;
    if (best === null || bad < best[1]) best = [s, bad];
    if (bad === 0) break;
  }
  return best;
}

/** Nearest playable pitch; ties go up unless preferUp is false. */
export function snapToComb(midi, preferUp = true) {
  if (G.isPlayable(midi)) return midi;
  const up = G.PITCH_SET.find((m) => m > midi);
  const dn = [...G.PITCH_SET].reverse().find((m) => m < midi);
  if (up === undefined) return dn;
  if (dn === undefined) return up;
  const du = up - midi, dd = midi - dn;
  if (du === dd) return preferUp ? up : dn;
  return du < dd ? up : dn;
}

/**
 * Give every note a physical track, respecting the minimum pin spacing.
 * Doubled pitches alternate between their two tines. Notes that cannot be
 * placed are dropped and reported. Mutates `sc` (pass a clone to keep the
 * original) and returns { assigned, dropped: [[beat, midi, why]], snapped: [[from, to, beat]] }.
 */
export function assignTracks(sc, transpose = 0, snap = true, minArcMm = G.MIN_PIN_ARC_MM) {
  const rep = { assigned: 0, dropped: [], snapped: [] };
  const lastAngle = {};
  const kept = [];
  for (const n of sc.notes.slice().sort(noteOrder)) {
    let m = n.midi + transpose;
    if (!G.isPlayable(m)) {
      if (!snap) { rep.dropped.push([n.beat, n.midi, 'not on comb']); continue; }
      const m2 = snapToComb(m);
      rep.snapped.push([n.midi, m2 - transpose, n.beat]);
      m = m2;
    }
    const ang = beatToAngle(sc, n.beat);
    const gap = (t) => (t in lastAngle ? (pymod(ang - lastAngle[t], 360) * Math.PI / 180) * G.trackRadius(t) : 1e9);
    let placed = false;
    for (const t of G.tracksFor(m).slice().sort((a, b) => gap(b) - gap(a))) {
      if (gap(t) >= minArcMm) {
        n.track = t; n.midi = m; lastAngle[t] = ang; kept.push(n); placed = true;
        break;
      }
    }
    if (!placed) rep.dropped.push([n.beat, n.midi, 'too close to previous pin on every track']);
  }
  // the loop repeats: the last pin on a track must also clear the first one
  const first = {};
  for (const n of kept) if (!(n.track in first)) first[n.track] = n;
  const final = [];
  for (const n of kept) {
    const f = first[n.track];
    if (n !== f) {
      const d = pymod(beatToAngle(sc, f.beat) - beatToAngle(sc, n.beat), 360);
      if ((d * Math.PI / 180) * G.trackRadius(n.track) < minArcMm) { rep.dropped.push([n.beat, n.midi, "wraps onto the loop's first pin"]); continue; }
    }
    final.push(n);
  }
  sc.notes = final;
  rep.assigned = final.length;
  return rep;
}

/** Tile the loop `repeats` times around the disc. */
export function repeatToFill(sc, repeats) {
  const out = makeScore({ length_beats: sc.length_beats * repeats, title: sc.title, seconds_per_rev: sc.seconds_per_rev, meta: { ...sc.meta } });
  for (let k = 0; k < repeats; k++) for (const n of sc.notes) out.notes.push(makeNote(n.beat + k * sc.length_beats, n.midi, n.track, n.velocity));
  return out;
}

/** Snap note times to `beatsPerRev` steps per revolution at the grid phase that fits best. */
export function quantise(sc, beatsPerRev) {
  const a = sc.notes.map((n) => 360 * n.beat / sc.length_beats);
  const step = 360 / beatsPerRev;
  const wrapErr = (x, ph) => pymod(x - ph + step / 2, step) - step / 2;
  let best = null;
  for (let k = 0; k < 40; k++) {
    const ph = k * (step / 40);
    let err = 0;
    for (const x of a) err += Math.abs(wrapErr(x, ph));
    if (best === null || err < best[0]) best = [err, ph];
  }
  const ph = best[1];
  const out = makeScore({ length_beats: beatsPerRev, title: sc.title, seconds_per_rev: sc.seconds_per_rev, meta: { ...sc.meta } });
  out.meta.quantise_rms_deg = a.length ? Math.sqrt(a.reduce((s, x) => s + wrapErr(x, ph) ** 2, 0) / a.length) : 0;
  out.meta.quantise_phase_deg = ph;      // beat b now sits at start_angle_deg + phase + b * step
  sc.notes.forEach((n, i) => out.notes.push(makeNote(pymod(pyround((a[i] - ph) / step), beatsPerRev), n.midi, n.track, n.velocity)));
  out.notes.sort(noteOrder);
  return out;
}

/** Human-readable lines for an assignTracks report. */
export function describeReport(rep, transpose = 0) {
  const lines = [`${rep.assigned} pins placed` + (transpose ? ` (transposed ${transpose > 0 ? '+' : ''}${transpose} semitones)` : '')];
  for (const [from, to, beat] of rep.snapped) lines.push(`snapped ${G.midiName(from)} to ${G.midiName(to)} at beat ${+beat.toFixed(3)}`);
  for (const [beat, midi, why] of rep.dropped) lines.push(`DROPPED ${G.midiName(midi)} at beat ${+beat.toFixed(3)}: ${why}`);
  return lines;
}
