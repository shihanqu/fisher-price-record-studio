// Physical geometry of a Fisher-Price #995 record and the player's comb.
//
// This mirrors fpmb/geometry.py; tests/test_js_parity.py checks the two agree.
// Lengths are millimetres, angles degrees, maths convention (counter-clockwise
// positive, 0 = +x) looking at the grooved side of the record.

export const DISC_RADIUS = 60.58;
export const DISC_THICKNESS = 3.2;
export const CENTER_HOLE_RADIUS = 3.22;
export const DRIVE_HOLE_RADIUS = 1.55;
export const DRIVE_HOLE_OFFSET = 21.8;
export const LABEL_RADIUS = 25.6;
export const LABEL_INSET = 1.0;

export const GROOVE_DEPTH = 1.2;
export const GROOVE_WIDTH = 2.0;
export const GROOVE_PITCH = 2.775;
// Inner wall face of each of the 11 grooves, innermost first.
export const GROOVE_INNER_RADII = [28.15, 30.89, 33.71, 36.425, 39.225, 42.0, 44.825, 47.555, 50.315, 53.11, 55.9];
export const N_GROOVES = GROOVE_INNER_RADII.length;

export const PIN_RADIAL = 1.0;       // how far a pin reaches into the groove from its wall
export const PIN_TANGENTIAL = 1.0;   // pin width along the direction of travel
export const PIN_HEIGHT = GROOVE_DEPTH;
// Two tines ride in every groove, one against each wall: 22 tracks.
export const N_TRACKS = 2 * N_GROOVES;

/** Radial centre line of a pin on physical track 0..21 (innermost first). */
export function trackRadius(track) {
  const r0 = GROOVE_INNER_RADII[track >> 1];
  return track % 2 === 0 ? r0 + PIN_RADIAL / 2 : r0 + GROOVE_WIDTH - PIN_RADIAL / 2;
}

/** Radius of the wall face a track's pins grow out of. */
export function trackWallRadius(track) {
  const r0 = GROOVE_INNER_RADII[track >> 1];
  return track % 2 === 0 ? r0 : r0 + GROOVE_WIDTH;
}

export const TRACK_RADII = Array.from({ length: N_TRACKS }, (_, t) => trackRadius(t));

// MIDI note sounded by each track, innermost first: Ab major from Eb4 to Bb6,
// with Ab5 Bb5 C6 Db6 Eb6 F6 doubled so quick repeats are possible.
export const TRACK_MIDI = [63, 68, 70, 72, 75, 77, 79, 80, 80, 82, 82, 84, 84, 85, 85, 87, 87, 89, 89, 91, 92, 94];
export const PITCH_SET = [...new Set(TRACK_MIDI)].sort((a, b) => a - b);
export const TRACKS_FOR_MIDI = {};
TRACK_MIDI.forEach((m, t) => (TRACKS_FOR_MIDI[m] ||= []).push(t));
export const tracksFor = (m) => TRACKS_FOR_MIDI[m] || [];
export const isPlayable = (m) => tracksFor(m).length > 0;

// Measured on the player in data/: about 45 s per turn when freshly wound.
export const SECONDS_PER_REV = 45.0;
// The comb sits about 2 mm off the radial line; a pin for musical time T is
// placed at  T_angle - degrees(HEAD_OFFSET_MM / radius).
export const HEAD_OFFSET_MM = 2.0;
// Closest two pins on one track may be, along the groove.
export const MIN_PIN_ARC_MM = 2.2;

export const DEG = 180 / Math.PI;
export const headOffsetDeg = (radius) => (HEAD_OFFSET_MM / radius) * DEG;

const FLAT_NAMES = 'C Db D Eb E F Gb G Ab A Bb B'.split(' ');
const SHARP_NAMES = 'C C# D D# E F F# G G# A A# B'.split(' ');
export function midiName(m, flats = true) {
  return (flats ? FLAT_NAMES : SHARP_NAMES)[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}
export const midiFreq = (m) => 440 * 2 ** ((m - 69) / 12);

/**
 * Where the comb touches the record while the arm reads musical angle
 * `thetaDeg`. The tines sit HEAD_OFFSET_MM to one side of the arm's radial
 * line, so the pins that sound together lie on a line parallel to the radius
 * rather than on it (a pin for time T is placed at T - HEAD_OFFSET_MM / r).
 * Returns image points [x, y] (y pointing down) for a disc centred at
 * (cx, cy) drawn at pxPerMm, from radius r0 to r1 in mm.
 */
export function armLine(thetaDeg, cx, cy, pxPerMm, r0 = 26, r1 = 61, stepMm = 1) {
  const pts = [];
  const n = Math.max(1, Math.round((r1 - r0) / stepMm));
  for (let i = 0; i <= n; i++) {
    const r = r0 + ((r1 - r0) * i) / n;
    const a = thetaDeg / DEG - HEAD_OFFSET_MM / r;
    pts.push([cx + r * pxPerMm * Math.cos(a), cy - r * pxPerMm * Math.sin(a)]);
  }
  return pts;
}
