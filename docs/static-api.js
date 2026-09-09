// Static stand-in for the Python API, used by the GitHub Pages demo.
// The pages call api(path, opts); when this file is loaded, window.STATIC_API
// answers the calls that can be done in the browser and refuses the rest
// with a clear message.  Geometry, the sample scan and the starter STL are
// pre-computed files under ./static/.
(function () {
  const here = new URL('.', location.href).href;
  const load = (name, as = 'json') => fetch(here + 'static/' + name).then(r => as === 'json' ? r.json() : r.arrayBuffer());
  let geo = null, sample = null;

  const ok = (obj, headers) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json', ...(headers || {}) } });
  const refuse = msg => new Response(JSON.stringify({ error: msg }), { status: 501, headers: { 'Content-Type': 'application/json' } });
  const LOCAL = 'needs the studio running locally (python webapp/server.py, see README)';

  const NOTE_RE = /^([A-Ga-g])([#b]?)(-?\d)$/;
  function parseNote(name) {
    const m = NOTE_RE.exec(name.trim()); if (!m) throw new Error('bad note name ' + name);
    const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
    const acc = { '': 0, '#': 1, 'b': -1 }[m[2]];
    return 12 * (parseInt(m[3]) + 1) + base + acc;
  }
  function parseText(text, beatsPerStep, title) {
    const notes = []; let step = 0;
    for (const line of text.split('\n')) {
      for (const tok of line.split('#')[0].split(/\s+/).filter(Boolean)) {
        if (tok === '|') continue;
        if (!['.', '-', '_'].includes(tok)) for (const part of tok.split('+')) notes.push({ beat: step * beatsPerStep, midi: parseNote(part) });
        step++;
      }
    }
    return { title, length_beats: step * beatsPerStep, seconds_per_rev: geo.seconds_per_rev, notes, meta: {} };
  }
  const tracksFor = m => geo.track_midi.map((x, t) => x === m ? t : -1).filter(t => t >= 0);
  const name = m => { const N = 'C Db D Eb E F Gb G Ab A Bb B'.split(' '); return N[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); };
  function snap(m) {
    if (tracksFor(m).length) return m;
    const up = geo.pitch_set.filter(x => x > m)[0], dn = geo.pitch_set.filter(x => x < m).slice(-1)[0];
    if (up === undefined) return dn; if (dn === undefined) return up;
    return (up - m) <= (m - dn) ? up : dn;
  }
  function bestTransposition(midis) {
    let best = null;
    for (const s of [...Array(49).keys()].map(i => i - 24).sort((a, b) => Math.abs(a) - Math.abs(b))) {
      const bad = midis.filter(m => !tracksFor(m + s).length).length;
      if (!best || bad < best[1]) best = [s, bad];
      if (bad === 0) break;
    }
    return best;
  }
  function assign(d) {
    let sc = JSON.parse(JSON.stringify(d.score));
    const repeats = +(d.repeats || 1);
    if (repeats > 1) {
      const L = sc.length_beats, notes = [];
      for (let k = 0; k < repeats; k++) for (const n of sc.notes) notes.push({ ...n, beat: n.beat + k * L });
      sc = { ...sc, length_beats: L * repeats, notes };
    }
    let tr = +(d.transpose || 0);
    if (d.auto_transpose) tr = bestTransposition(sc.notes.map(n => n.midi))[0];
    const rep = { assigned: 0, dropped: [], snapped: [], transpose: tr };
    const last = {}, kept = [];
    const L = sc.length_beats, radius = t => geo.track_radii[t];
    for (const n of sc.notes.sort((a, b) => a.beat - b.beat || a.midi - b.midi)) {
      let m = n.midi + tr;
      if (!tracksFor(m).length) {
        if (d.snap === false) { rep.dropped.push({ beat: n.beat, midi: n.midi, name: name(n.midi), why: 'not on comb' }); continue; }
        const m2 = snap(m); rep.snapped.push({ from: name(n.midi), to: name(m2 - tr), beat: n.beat }); m = m2;
      }
      const ang = 360 * n.beat / L;
      const gap = t => last[t] === undefined ? 1e9 : (((ang - last[t]) % 360 + 360) % 360) * Math.PI / 180 * radius(t);
      const cands = tracksFor(m).sort((a, b) => gap(b) - gap(a));
      let placed = false;
      for (const t of cands) if (gap(t) >= geo.min_pin_arc_mm) { n.track = t; n.midi = m; last[t] = ang; kept.push(n); placed = true; break; }
      if (!placed) rep.dropped.push({ beat: n.beat, midi: n.midi, name: name(m), why: 'too close to previous pin on every track' });
    }
    const first = {}; for (const n of kept) if (first[n.track] === undefined) first[n.track] = n;
    const final = [];
    for (const n of kept) {
      const f = first[n.track];
      if (n !== f) {
        const dd = (((360 * f.beat / L - 360 * n.beat / L) % 360) + 360) % 360;
        if (dd * Math.PI / 180 * radius(n.track) < geo.min_pin_arc_mm) { rep.dropped.push({ beat: n.beat, midi: n.midi, name: name(n.midi), why: "wraps onto the loop's first pin" }); continue; }
      }
      final.push(n);
    }
    sc.notes = final; rep.assigned = final.length;
    return { score: sc, report: rep };
  }
  const sameLoop = (a, b) => a.length === b.length && a.every((n, i) => Math.abs(n.beat - b[i].beat) < 1e-6 && n.midi === b[i].midi);
  const sortNotes = ns => ns.slice().sort((a, b) => a.beat - b.beat || a.midi - b.midi);

  window.STATIC_API = async function (path, opts) {
    geo = geo || await load('geometry.json');
    const body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    switch (path.split('?')[0]) {
      case '/api/geometry': return ok(geo);
      case '/api/import-text': try { return ok({ score: parseText(body.text, +(body.beats_per_step || 1), body.title || 'loop') }); } catch (e) { return refuse(e.message); }
      case '/api/assign': return ok(assign(body));
      case '/api/extract':
        sample = sample || await load('sample_extract.json');
        return ok({ ...sample, warnings: [...sample.warnings, 'Hosted demo: this is the pre-computed scan of the sample photo. Run the studio locally to scan your own.'] });
      case '/sample/edelweiss_record.jpg': return new Response(new Blob([]), { status: 200 });
      case '/api/stl': {
        const starter = await load('starter_score.json');
        if (body && body.score && (body.repeats || 1) === 1 && sameLoop(sortNotes(body.score.notes), sortNotes(starter.notes))) {
          const buf = await load('starter.stl', 'buf');
          return new Response(buf, { status: 200, headers: { 'Content-Type': 'model/stl', 'X-Report': JSON.stringify(assign({ score: starter }).report) } });
        }
        return refuse('Building a record from your own loop ' + LOCAL + '. The hosted demo can only preview the starter loop.');
      }
      case '/api/wav': return refuse('WAV rendering ' + LOCAL + '. Use the Play button to hear it here.');
      case '/api/midi': return refuse('MIDI export ' + LOCAL);
      case '/api/import-midi': return refuse('MIDI import ' + LOCAL);
      default: return refuse('not available in the hosted demo');
    }
  };
})();
