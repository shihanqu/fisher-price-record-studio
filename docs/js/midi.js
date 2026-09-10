// Minimal Standard MIDI File reader and writer: enough for loops of notes.
// writeMidi() produces the same bytes as fpmb/synth.py's write_midi (mido).

import { makeNote, makeScore } from './score.js';
import { pyround } from './pyfn.js';

function vlq(n) {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >>> 8) & 255, n & 255];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

/** Type-0 MIDI file for a score; one score beat is one quarter note. Program 10 is the GM music box. */
export function writeMidi(sc, { secondsPerRev = sc.seconds_per_rev, program = 10 } = {}) {
  const tpb = 480;
  let tempo = Math.trunc((secondsPerRev / sc.length_beats) * 1e6);   // microseconds per quarter note
  let quartersPerBeat = 1;                                           // tempo has to fit in 24 bits
  while (tempo > 0xffffff) { quartersPerBeat *= 2; tempo = Math.trunc((secondsPerRev / sc.length_beats / quartersPerBeat) * 1e6); }
  const ticks = tpb * quartersPerBeat;
  const events = [];
  for (const n of sc.notes) {
    const on = pyround(n.beat * ticks);
    events.push({ tick: on, on: 1, note: n.midi, vel: Math.trunc(Math.max(1, Math.min(127, (n.velocity ?? 1) * 110))) });
    events.push({ tick: on + Math.trunc(0.6 * tpb), on: 0, note: n.midi, vel: 0 });
  }
  events.sort((a, b) => a.tick - b.tick || a.on - b.on || a.note - b.note || a.vel - b.vel);
  const trk = [0x00, 0xff, 0x51, 0x03, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255, 0x00, 0xc0, program & 0x7f];
  let t = 0, running = 0xc0;
  for (const e of events) {
    const status = e.on ? 0x90 : 0x80;
    trk.push(...vlq(e.tick - t));
    if (status !== running) trk.push(status);
    trk.push(e.note & 0x7f, e.vel & 0x7f);
    running = status;
    t = e.tick;
  }
  trk.push(0x00, 0xff, 0x2f, 0x00);
  return new Uint8Array([...ascii('MThd'), ...u32(6), ...u16(0), ...u16(1), ...u16(tpb),
    ...ascii('MTrk'), ...u32(trk.length), ...trk]);
}

/** Parse a MIDI file into { format, tpb, tracks: [[{tick, kind, note, velocity, channel}]] }. */
export function readMidi(buffer) {
  const b = new Uint8Array(buffer);
  let p = 0;
  const need = (n) => { if (p + n > b.length) throw new Error('MIDI file is truncated'); };
  const r32 = () => { need(4); const v = ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3]; p += 4; return v; };
  const r16 = () => { need(2); const v = (b[p] << 8) + b[p + 1]; p += 2; return v; };
  const tag = () => { need(4); const s = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]); p += 4; return s; };
  const rvlq = () => { let v = 0, c; do { need(1); c = b[p++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80); return v; };

  if (tag() !== 'MThd') throw new Error('not a MIDI file');
  const hlen = r32();
  const format = r16(), ntracks = r16(), division = r16();
  p += hlen - 6;
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
  const tracks = [];
  while (p + 8 <= b.length && tracks.length < ntracks) {
    const id = tag(), len = r32(), end = p + len;
    if (id !== 'MTrk') { p = end; continue; }
    const events = [];
    let tick = 0, running = 0;
    while (p < end) {
      tick += rvlq();
      let status = b[p];
      if (status < 0x80) status = running; else p++;
      if (status === 0xff) {
        const type = b[p++], n = rvlq();
        p += n;
        if (type === 0x2f) break;
      } else if (status === 0xf0 || status === 0xf7) {
        p += rvlq();
      } else if (status >= 0x80) {
        running = status;
        const hi = status & 0xf0, ch = status & 0x0f;
        const d1 = b[p++], d2 = hi === 0xc0 || hi === 0xd0 ? 0 : b[p++];
        if (hi === 0x90) events.push({ tick, kind: 'note_on', note: d1, velocity: d2, channel: ch });
        else if (hi === 0x80) events.push({ tick, kind: 'note_off', note: d1, velocity: d2, channel: ch });
      } else {
        throw new Error('corrupt MIDI track');
      }
    }
    p = end;
    tracks.push(events);
  }
  return { format, tpb: division, tracks };
}

/** A score from a MIDI file: beats are quarter notes; tempo is ignored (the record's speed sets it). */
export function scoreFromMidi(buffer, title = '') {
  const mid = readMidi(buffer);
  const notes = [];
  let length = 0;
  for (const events of mid.tracks) {
    for (const e of events) {
      if (e.kind === 'note_on' && e.velocity > 0) notes.push(makeNote(e.tick / mid.tpb, e.note, null, e.velocity / 127));
      length = Math.max(length, e.tick / mid.tpb);
    }
  }
  return makeScore({ length_beats: Math.max(1, Math.ceil(length)), notes, title });
}
