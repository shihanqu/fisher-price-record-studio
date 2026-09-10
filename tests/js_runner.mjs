// Runs the browser modules (docs/js) under Node for tests/test_js_parity.py.
//   node tests/js_runner.mjs jobs.json results.json
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) => import(pathToFileURL(path.join(root, 'docs', 'js', name)).href);
const [G, S, SG, X, MIDI, MESH, SY] = await Promise.all(['geometry.js', 'score.js', 'signal.js', 'extract.js', 'midi.js', 'mesh.js', 'synth.js'].map(load));

const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = [];
for (const job of jobs) {
  switch (job.op) {
    case 'geometry':
      out.push({
        DISC_RADIUS: G.DISC_RADIUS, DISC_THICKNESS: G.DISC_THICKNESS, CENTER_HOLE_RADIUS: G.CENTER_HOLE_RADIUS,
        DRIVE_HOLE_RADIUS: G.DRIVE_HOLE_RADIUS, DRIVE_HOLE_OFFSET: G.DRIVE_HOLE_OFFSET, LABEL_RADIUS: G.LABEL_RADIUS,
        LABEL_INSET: G.LABEL_INSET, GROOVE_DEPTH: G.GROOVE_DEPTH, GROOVE_WIDTH: G.GROOVE_WIDTH, GROOVE_PITCH: G.GROOVE_PITCH,
        GROOVE_INNER_RADII: G.GROOVE_INNER_RADII, PIN_RADIAL: G.PIN_RADIAL, PIN_TANGENTIAL: G.PIN_TANGENTIAL,
        TRACK_RADII: G.TRACK_RADII, TRACK_MIDI: G.TRACK_MIDI, PITCH_SET: G.PITCH_SET, SECONDS_PER_REV: G.SECONDS_PER_REV,
        HEAD_OFFSET_MM: G.HEAD_OFFSET_MM, MIN_PIN_ARC_MM: G.MIN_PIN_ARC_MM,
        head_offsets: G.TRACK_RADII.map(G.headOffsetDeg), names: G.PITCH_SET.map((m) => G.midiName(m)),
      });
      break;
    case 'gaussian': out.push(Array.from(SG.gaussian1d(job.x, job.sigma, job.mode))); break;
    case 'rank': out.push(Array.from(SG.rankFilterWrap(job.x, job.size, job.rank))); break;
    case 'peaks': out.push(SG.findPeaks(job.x, job.kw).peaks); break;
    case 'parse_text': {
      try { out.push(S.toDict(S.parseText(job.text, job.beats_per_step, job.title))); } catch (e) { out.push({ error: e.message }); }
      break;
    }
    case 'assign': {
      let sc = S.fromDict(job.score);
      if (job.repeats > 1) sc = S.repeatToFill(sc, job.repeats);
      for (const n of sc.notes) n.track = null;
      const rep = S.assignTracks(sc, job.transpose, job.snap);
      out.push({ score: S.toDict(sc), rep });
      break;
    }
    case 'quantise': out.push(S.toDict(S.quantise(S.fromDict(job.score), job.bpr))); break;
    case 'transpose': out.push(S.bestTransposition(job.midis)); break;
    case 'midi_write': out.push(Buffer.from(MIDI.writeMidi(S.fromDict(job.score), { secondsPerRev: job.spr })).toString('base64')); break;
    case 'midi_read': out.push(S.toDict(MIDI.scoreFromMidi(Buffer.from(job.b64, 'base64'), job.title))); break;
    case 'mesh': {
      const sc = S.fromDict(job.score);
      for (const n of sc.notes) n.track = null;
      S.assignTracks(sc);
      const m = await MESH.buildRecord(sc, job.opt);
      out.push({ triangles: m.triangles, volume: m.volume, genus: m.genus, stl_bytes: MESH.toSTL(m).byteLength });
      break;
    }
    case 'extract': {
      const data = new Uint8ClampedArray(fs.readFileSync(job.rgba));
      const t0 = performance.now();
      const r = X.extractFromRGBA({ data, width: job.w, height: job.h });
      out.push({ pins: r.pins, warnings: r.warnings, fit: r.grooveFit, coverage: r.coverage, ms: performance.now() - t0 });
      break;
    }
    case 'sweep': {
      // For every note, where the arm line crosses the note's track at the moment
      // the note sounds, compared with the nearest detected pin on that track.
      const data = new Uint8ClampedArray(fs.readFileSync(job.rgba));
      const r = X.extractFromRGBA({ data, width: job.w, height: job.h });
      const worst = (sc) => {
        let w = 0;
        for (const n of sc.notes) {
          const theta = (sc.meta.start_angle_deg || 0) + (sc.meta.quantise_phase_deg || 0) + (360 * n.beat) / sc.length_beats;
          const rad = G.trackRadius(n.track);
          const [[x, y]] = G.armLine(theta, 0, 0, 1, rad, rad);
          const hit = Math.atan2(-y, x) * G.DEG;
          let best = 1e9;
          for (const [t, a] of r.pins) if (t === n.track) best = Math.min(best, Math.abs(((hit - a + 540) % 360) - 180));
          w = Math.max(w, best);
        }
        return w;
      };
      out.push({ raw: worst(r.score), quantised: worst(S.quantise(r.score, 100)), halfStep: 1.8 });
      break;
    }
    case 'crowded': out.push(S.crowdedMoments(S.fromDict(job.score), job.limit)); break;
    case 'default_loop': {
      const { DEFAULT_LOOP } = await load('default-loop.js');
      const base = S.parseText(DEFAULT_LOOP.text, 1 / DEFAULT_LOOP.stepsPerBeat, 'default');
      const sc = S.repeatToFill(base, DEFAULT_LOOP.repeats);
      const rep = S.assignTracks(sc);
      out.push({
        text: DEFAULT_LOOP.text, beats_per_step: 1 / DEFAULT_LOOP.stepsPerBeat, repeats: DEFAULT_LOOP.repeats,
        notes: base.notes.length, steps: base.length_beats * DEFAULT_LOOP.stepsPerBeat, pins: rep.assigned,
        dropped: rep.dropped.length, snapped: rep.snapped.length, most_together: Math.max(...S.crowdedMoments(sc, 0).map((g) => g[1])),
      });
      break;
    }
    case 'wav': out.push({ bytes: SY.renderWav(S.fromDict(job.score), { secondsPerRev: job.spr }).byteLength }); break;
    default: throw new Error('unknown op ' + job.op);
  }
}
fs.writeFileSync(process.argv[3], JSON.stringify(out));
