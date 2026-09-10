// Sound: an offline renderer that writes WAV files (mirrors fpmb/synth.py)
// and a WebAudio player for live playback.

import * as G from './geometry.js';

// ---------------------------------------------------------------- offline WAV

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One music-box tine: three stretched partials decaying at different rates, plus an attack click. */
export function pluckSamples(freq, sr, dur = 2.5, amp = 0.3) {
  const n = Math.floor(sr * dur);
  const out = new Float32Array(n);
  const partials = [[1.0, 1.0, 1.6], [6.27, 0.12, 8.0], [17.55, 0.03, 20.0]].filter(([ratio]) => freq * ratio <= (sr / 2) * 0.9);
  const rand = mulberry32(Math.trunc(freq));
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let s = 0;
    for (const [ratio, gain, decay] of partials) s += gain * Math.sin(2 * Math.PI * freq * ratio * t) * Math.exp(-decay * t);
    const u = Math.max(rand(), 1e-12), v = rand();
    const noise = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    s += Math.exp(-t * 400) * noise * 0.05;
    out[i] = amp * s * (1 - Math.exp(-t * 3000));
  }
  return out;
}

/** Mix `loops` revolutions of a score into a buffer normalised to 0.9 peak. */
export function renderMix(sc, { sr = 44100, loops = 1, tail = 2.0, secondsPerRev = sc.seconds_per_rev } = {}) {
  const buf = new Float32Array(Math.floor(sr * (secondsPerRev * loops + tail)) + 1);
  const cache = new Map();
  for (let k = 0; k < loops; k++) {
    for (const n of sc.notes) {
      const i0 = Math.floor((k * secondsPerRev + (secondsPerRev * n.beat) / sc.length_beats) * sr);
      if (!cache.has(n.midi)) cache.set(n.midi, pluckSamples(G.midiFreq(n.midi), sr));
      const s = cache.get(n.midi), v = n.velocity ?? 1;
      const i1 = Math.min(buf.length, i0 + s.length);
      for (let i = i0; i < i1; i++) buf[i] += s[i - i0] * v;
    }
  }
  let peak = 0;
  for (const x of buf) peak = Math.max(peak, Math.abs(x));
  const g = 0.9 / (peak || 1);
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}

/** 16-bit mono PCM WAV bytes. */
export function encodeWav(samples, sr = 44100) {
  const out = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(out);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.trunc(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return out;
}

export const renderWav = (sc, opts = {}) => encodeWav(renderMix(sc, opts), opts.sr || 44100);

// ---------------------------------------------------------------- live playback

/**
 * WebAudio player. Every note of one playback goes through its own master
 * gain, so stop() silences notes already handed to the audio engine instead
 * of letting them ring on (and pile up under the next play()).
 */
export class Player {
  constructor() { this.ctx = null; this.master = null; this.voices = []; this.timer = null; this.raf = null; this.onStop = null; }

  ensure() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  pluck(midi, when, gain, out) {
    const ctx = this.ensure();
    const f = G.midiFreq(midi);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0002), when + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 1.6);
    g.connect(out);
    for (const [ratio, amp, dec] of [[1, 1, 1.5], [6.27, 0.12, 6], [17.55, 0.03, 12]]) {
      const o = ctx.createOscillator();
      o.frequency.value = f * ratio;
      const og = ctx.createGain();
      og.gain.setValueAtTime(amp, when);
      og.gain.exponentialRampToValueAtTime(0.0001, when + (2.2 / dec) * 1.5);
      o.connect(og); og.connect(g);
      o.start(when); o.stop(when + 2.0);
      if (out !== ctx.destination) this.voices.push({ o, end: when + 2.0 });
    }
  }

  /** A single note right now, e.g. when a cell is clicked. */
  preview(midi, gain = 0.2) { const ctx = this.ensure(); this.pluck(midi, ctx.currentTime, gain, ctx.destination); }

  get playing() { return this.timer !== null; }

  /** Audio-clock time of the sound leaving the speakers right now (seconds). */
  heardTime() {
    const ctx = this.ctx;
    if (ctx.state === 'running' && typeof ctx.getOutputTimestamp === 'function') {
      const ts = ctx.getOutputTimestamp();
      if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
        return Math.min(ctx.currentTime, ts.contextTime + Math.max(0, (performance.now() - ts.performanceTime) / 1000));
      }
    }
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }

  /**
   * Play `notes` ({beat, midi, velocity}) over a loop of `loopBeats`.
   * onTick(beatInLoop, beatsSinceStart) runs on every animation frame with the
   * beat being heard. It follows the audio output clock, latency included, so
   * anything drawn from it moves smoothly and stays in step with the sound.
   * keepLooping() is asked as each pass ends.
   */
  play({ notes, loopBeats, secPerBeat, keepLooping = () => true, onTick = () => {}, onStop = () => {} }) {
    this.stop();
    const ctx = this.ensure();
    this.onStop = onStop;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    const sorted = notes.slice().sort((a, b) => a.beat - b.beat);
    const passSec = loopBeats * secPerBeat;
    const t0 = ctx.currentTime + 0.1;
    let queued = 0, heardPass = 0;
    const queuePass = () => {
      this.voices = this.voices.filter((v) => v.end > ctx.currentTime);
      const start = t0 + queued * passSec;
      for (const n of sorted) this.pluck(n.midi, start + n.beat * secPerBeat, 0.22 * Math.min(1, n.velocity ?? 1), this.master);
      queued++;
    };
    // Queue each pass a couple of seconds early and stop when the sound runs
    // out. This runs on a timer, so it keeps going in a background tab.
    const check = () => {
      if (ctx.currentTime + 2 >= t0 + queued * passSec && keepLooping()) queuePass();
      const pass = Math.floor(Math.max(0, this.heardTime() - t0) / passSec);
      if (pass >= queued || (pass > heardPass && !keepLooping())) { this.stop(); return false; }
      heardPass = pass;
      return true;
    };
    // Drawing happens on animation frames, so playheads glide.
    const frame = () => {
      this.raf = null;
      if (this.timer === null || !check()) return;
      const beats = Math.max(0, this.heardTime() - t0) / secPerBeat;
      onTick(beats % loopBeats, beats);
      this.raf = requestAnimationFrame(frame);
    };
    queuePass();
    this.timer = setInterval(check, 100);
    onTick(0, 0);
    this.raf = requestAnimationFrame(frame);
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    if (this.master) { this.master.gain.setValueAtTime(0, this.ctx.currentTime); this.master.disconnect(); this.master = null; }
    for (const v of this.voices) { try { v.o.stop(); } catch (e) { /* never started; disconnected anyway */ } }
    this.voices = [];
    const cb = this.onStop; this.onStop = null;
    if (cb) cb();
  }
}
