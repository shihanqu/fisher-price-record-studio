// Record Designer page: a loop in, a printable record out. Everything runs in
// the browser; the 3D preview is built by the same code that writes the STL.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as G from './geometry.js';
import { assignTracks, bestTransposition, crowdedMoments, describeReport, fromDict, parseText, quantise, repeatToFill, toDict } from './score.js';
import { buildRecord, toSTL } from './mesh.js';
import { scoreFromMidi } from './midi.js';
import { Player, renderWav } from './synth.js';
import { scanFile } from './scan.js';
import { DEFAULT_LOOP } from './default-loop.js';
import { baseName, fileSafe, initStarBadge, saveBlob } from './common.js';

const $ = (id) => document.getElementById(id);
const PITCHES = G.PITCH_SET.slice().reverse();          // top row = highest
const MAX_TOGETHER = 3;                                  // tines the spring motor can pluck at once
const player = new Player();

let score = { title: 'MY TUNE', length_beats: 16, seconds_per_rev: 45, notes: [], meta: {} };
let assigned = null;       // the score as it will be printed (repeats, transpose, tracks)
let crowded = [];          // [beat, count] wherever the printed score asks too much of the motor
let playBeat = -1;         // beat being heard within the loop, or -1 when stopped
let playAbs = 0;           // beats heard since Play was pressed (the disc map needs the whole turn)

const beatsEl = $('beats'), subEl = $('sub');
const steps = () => Math.round(+beatsEl.value * +subEl.value);
const stepBeats = () => 1 / +subEl.value;
const repeats = () => Math.max(1, Math.round(+$('repeats').value || 1));

// ------------------------------------------------------------------ piano roll
// Grid and notes go into an offscreen layer whenever something changes; every
// animation frame copies that layer and paints the moving playhead on top.
const roll = $('roll'), rctx = roll.getContext('2d'), rollWrap = $('roll-wrap');
const rollBase = document.createElement('canvas'), bctx = rollBase.getContext('2d');
const CW = 22, RH = 20, LEFT = 64, TOP = 18;

function drawRoll() {
  const n = steps(), sub = +subEl.value, c = bctx;
  rollBase.width = LEFT + n * CW + 8;
  rollBase.height = TOP + PITCHES.length * RH + 6;
  c.fillStyle = '#fff'; c.fillRect(0, 0, rollBase.width, rollBase.height);
  PITCHES.forEach((m, r) => {
    const y = TOP + r * RH;
    c.fillStyle = m % 12 === 8 ? '#f3efe4' : '#fff';       // Ab rows tinted
    c.fillRect(LEFT, y, n * CW, RH);
    c.fillStyle = '#444'; c.font = '12px system-ui'; c.textAlign = 'right';
    c.fillText(G.midiName(m) + (G.tracksFor(m).length > 1 ? ' ×2' : ''), LEFT - 6, y + 14);
  });
  for (let s = 0; s <= n; s++) {
    const x = LEFT + s * CW;
    c.strokeStyle = s % sub === 0 ? '#b9b1a3' : '#e6e0d4';
    c.lineWidth = s % (sub * 4) === 0 ? 1.5 : 1;
    c.beginPath(); c.moveTo(x, TOP); c.lineTo(x, TOP + PITCHES.length * RH); c.stroke();
    if (s % sub === 0 && s < n) { c.fillStyle = '#888'; c.textAlign = 'left'; c.font = '11px system-ui'; c.fillText(String(s / sub + 1), x + 3, 12); }
  }
  c.lineWidth = 1;
  c.strokeStyle = '#e6e0d4';
  for (let r = 0; r <= PITCHES.length; r++) { const y = TOP + r * RH; c.beginPath(); c.moveTo(LEFT, y); c.lineTo(LEFT + n * CW, y); c.stroke(); }
  c.fillStyle = '#c0392b';                                 // red mark: more notes at once than the motor can pluck
  for (const s of crowdedSteps()) c.fillRect(LEFT + s * CW + 2, TOP - 4, CW - 4, 3);
  const conflicts = spacingConflicts();
  for (const nt of score.notes) {
    const r = PITCHES.indexOf(nt.midi);
    if (r < 0) continue;
    c.fillStyle = conflicts.has(nt) ? '#b8b8b8' : '#3aa06a';
    c.beginPath(); c.roundRect(LEFT + Math.round(nt.beat / stepBeats()) * CW + 2, TOP + r * RH + 2, CW - 4, RH - 4, 4); c.fill();
  }
  paintRoll();
}

function paintRoll() {
  if (roll.width !== rollBase.width || roll.height !== rollBase.height) { roll.width = rollBase.width; roll.height = rollBase.height; }
  rctx.drawImage(rollBase, 0, 0);
  if (playBeat < 0) return;
  const sb = stepBeats(), s = Math.floor(playBeat / sb + 1e-9);
  rctx.fillStyle = '#f28c28';                              // the notes being plucked light up
  for (const nt of score.notes) {
    if (Math.round(nt.beat / sb) !== s) continue;
    const r = PITCHES.indexOf(nt.midi);
    if (r >= 0) { rctx.beginPath(); rctx.roundRect(LEFT + s * CW + 2, TOP + r * RH + 2, CW - 4, RH - 4, 4); rctx.fill(); }
  }
  const x = LEFT + (playBeat / sb) * CW;                   // the playhead glides between steps
  rctx.fillStyle = 'rgba(242,140,40,.9)';
  rctx.fillRect(x - 1, TOP, 2, PITCHES.length * RH);
  followPlayhead(x);
}

/** On loops wider than the box, scroll so the playhead stays in view. */
function followPlayhead(x) {
  const w = rollWrap.clientWidth, left = rollWrap.scrollLeft;
  if (roll.width <= w) return;
  if (x < left + 30 || x > left + w - 60) rollWrap.scrollLeft = Math.max(0, x - w * 0.25);
}

/** Notes that the track assignment will have to drop (drawn grey). */
function spacingConflicts() {
  const bad = new Set(), last = {};
  const L = score.length_beats * repeats();
  for (const n of score.notes.slice().sort((a, b) => a.beat - b.beat || a.midi - b.midi)) {
    const cands = G.tracksFor(n.midi);
    if (!cands.length) { bad.add(n); continue; }
    const gap = (t) => (last[t] === undefined ? 1e9 : ((n.beat - last[t]) / L) * 2 * Math.PI * G.TRACK_RADII[t]);
    const t = cands.slice().sort((a, b) => gap(b) - gap(a)).find((tt) => gap(tt) >= G.MIN_PIN_ARC_MM);
    if (t === undefined) bad.add(n); else last[t] = n.beat;
  }
  return bad;
}

/** Steps of the loop where the printed record plucks more than MAX_TOGETHER notes at once. */
function crowdedSteps() {
  const L = score.length_beats, out = new Set();
  for (const [beat] of crowded) out.add(Math.round((((beat % L) + L) % L) / stepBeats()) % steps());
  return out;
}

roll.addEventListener('click', (e) => {
  const rect = roll.getBoundingClientRect();
  const s = Math.floor((e.clientX - rect.left - LEFT) / CW), r = Math.floor((e.clientY - rect.top - TOP) / RH);
  if (s < 0 || s >= steps() || r < 0 || r >= PITCHES.length) return;
  const midi = PITCHES[r], beat = s * stepBeats();
  const i = score.notes.findIndex((n) => n.midi === midi && Math.abs(n.beat - beat) < 1e-6);
  if (i >= 0) score.notes.splice(i, 1);
  else { score.notes.push({ beat, midi, velocity: 1 }); player.preview(midi); }
  changed();
});

// ------------------------------------------------------------------ disc map
const disc = $('disc'), dctx = disc.getContext('2d');
const discBase = document.createElement('canvas'), dbx = discBase.getContext('2d');
const strokePath = (ctx, pts) => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); };

function drawDisc() {
  const W = disc.width, c = W / 2, k = (W / 2 - 6) / G.DISC_RADIUS, x = dbx;
  discBase.width = W; discBase.height = disc.height;
  x.fillStyle = '#4db37a'; x.beginPath(); x.arc(c, c, G.DISC_RADIUS * k, 0, 7); x.fill();
  x.fillStyle = '#3f9d68'; x.beginPath(); x.arc(c, c, G.LABEL_RADIUS * k, 0, 7); x.fill();
  x.fillStyle = '#f4f1ea'; x.beginPath(); x.arc(c, c, G.CENTER_HOLE_RADIUS * k, 0, 7); x.fill();
  for (let i = 0; i < 4; i++) { x.beginPath(); x.arc(c + G.DRIVE_HOLE_OFFSET * k * Math.cos((i * Math.PI) / 2), c - G.DRIVE_HOLE_OFFSET * k * Math.sin((i * Math.PI) / 2), G.DRIVE_HOLE_RADIUS * k, 0, 7); x.fill(); }
  x.strokeStyle = '#2b7a50'; x.lineWidth = G.GROOVE_WIDTH * k;
  for (const r0 of G.GROOVE_INNER_RADII) { x.beginPath(); x.arc(c, c, (r0 + G.GROOVE_WIDTH / 2) * k, 0, 7); x.stroke(); }
  const src = assigned || score, L = src.length_beats;
  for (const n of src.notes) {
    const t = n.track ?? G.tracksFor(n.midi)[0];
    if (t === undefined) continue;
    const r = G.TRACK_RADII[t] * k, a = (2 * Math.PI * n.beat) / L - G.HEAD_OFFSET_MM / G.TRACK_RADII[t];
    x.fillStyle = t % 2 === 0 ? '#ffe680' : '#ffb347';
    x.beginPath(); x.arc(c + r * Math.cos(a), c - r * Math.sin(a), Math.max(1.6, 0.6 * k), 0, 7); x.fill();
  }
  x.strokeStyle = '#f28c28'; x.lineWidth = 3;                // the comb touches the pins of beat 0 (geometry.armLine)
  strokePath(x, G.armLine(0, c, c, k));
  paintDisc();
}

function paintDisc() {
  const W = disc.width, c = W / 2, k = (W / 2 - 6) / G.DISC_RADIUS;
  dctx.clearRect(0, 0, W, disc.height);
  dctx.drawImage(discBase, 0, 0);
  if (playBeat < 0) return;
  const total = score.length_beats * repeats();           // the loop goes round the disc `repeats` times
  dctx.strokeStyle = 'rgba(255,255,255,.85)'; dctx.lineWidth = 1.5;
  strokePath(dctx, G.armLine((360 * (playAbs % total)) / total, c, c, k));
}

// ------------------------------------------------------------------ playback
$('play').onclick = () => {
  const L = score.length_beats;
  player.play({
    notes: score.notes, loopBeats: L, secPerBeat: +$('spr').value / (L * repeats()),
    keepLooping: () => $('loopplay').checked,
    onTick: (beat, abs) => { playBeat = beat; playAbs = abs; paintRoll(); paintDisc(); },
    onStop: () => { playBeat = -1; paintRoll(); paintDisc(); },
  });
};
$('stop').onclick = () => player.stop();

// ------------------------------------------------------------------ the printable score
/** The score as it goes on the record: repeated, transposed and given tracks. */
function assignedScore() {
  let sc = fromDict({ ...score, title: $('title').value, seconds_per_rev: +$('spr').value });
  if (repeats() > 1) sc = repeatToFill(sc, repeats());
  for (const n of sc.notes) n.track = null;
  let tr = Math.round(+$('transpose').value || 0);
  if ($('autotr').checked) tr = bestTransposition(sc.notes.map((n) => n.midi))[0];
  const rep = assignTracks(sc, tr, $('snap').checked);
  return { sc, rep, tr };
}

let notice = '';           // one-off message shown above the report (import results)
function showReport(text, bad = false) { const el = $('report'); el.textContent = text; el.className = bad ? 'bad' : ''; }

function reassign() {
  const { sc, rep, tr } = assignedScore();
  assigned = sc;
  crowded = crowdedMoments(sc, MAX_TOGETHER);
  const lines = describeReport(rep, tr);
  const L = score.length_beats, seen = new Set();
  for (const [beat, count] of crowded) {
    const b = +(((beat % L) + L) % L).toFixed(3);
    if (seen.has(b)) continue;
    seen.add(b);
    lines.push(`CROWDED beat ${b}: ${count} notes at once, but the motor can only pluck ${MAX_TOGETHER} together`);
  }
  showReport((notice ? notice + '\n' : '') + lines.join('\n'));
}

// ------------------------------------------------------------------ 3D preview (built in the browser)
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe9e4d9);
const cam = new THREE.PerspectiveCamera(35, 1, 1, 1000);
cam.position.set(0, -130, 110); cam.up.set(0, 0, 1);
const ctl = new OrbitControls(cam, renderer.domElement);
ctl.target.set(0, 0, 0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x888877, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 1.2); key.position.set(60, -80, 120); scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.4); fill.position.set(-80, 40, 60); scene.add(fill);
const material = new THREE.MeshStandardMaterial({ color: 0x4db37a, roughness: 0.55, metalness: 0.05 });
let meshObj = null, fitted = false;
const render = () => renderer.render(scene, cam);
ctl.addEventListener('change', render);

function showMesh({ vertProperties: v, triVerts: f, numProp }) {
  const pos = new Float32Array(f.length * 3);          // unshared vertices -> flat shading
  for (let i = 0; i < f.length; i++) { const b = f[i] * numProp; pos[3 * i] = v[b]; pos[3 * i + 1] = v[b + 1]; pos[3 * i + 2] = v[b + 2]; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  if (meshObj) { scene.remove(meshObj); meshObj.geometry.dispose(); }
  meshObj = new THREE.Mesh(g, material);
  scene.add(meshObj);
  if (!fitted) { fitCamera(); fitted = true; }
  render();
}
function fitCamera() {                                   // keep the whole disc in view whatever the box's shape
  const R = 62, vfov = (cam.fov * Math.PI) / 180, hfov = 2 * Math.atan(Math.tan(vfov / 2) * cam.aspect);
  const dist = (R / Math.sin(Math.min(vfov, hfov) / 2)) * 1.05;
  const dir = cam.position.clone().sub(ctl.target).normalize();
  cam.position.copy(ctl.target).add(dir.multiplyScalar(dist));
  ctl.update();
}
function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix(); fitCamera(); render();
}
new ResizeObserver(resize).observe(view);
resize();

const meshOptions = () => ({ thickness: +$('thick').value || G.DISC_THICKNESS, bottomInset: $('binset').checked, label: $('label').value.slice(0, 14) });
let buildTimer = null, buildSeq = 0;
function scheduleBuild() { clearTimeout(buildTimer); $('meshinfo').textContent = 'Updating the 3D preview…'; buildTimer = setTimeout(build, 300); }

/** Build the record from the current loop; returns the mesh (or null if a newer build took over). */
async function build() {
  clearTimeout(buildTimer);
  const seq = ++buildSeq;
  const { sc } = assignedScore();
  try {
    const mesh = await buildRecord(sc, meshOptions());
    if (seq !== buildSeq) return null;
    showMesh(mesh);
    $('meshinfo').textContent = `${sc.notes.length} pins · ${mesh.triangles.toLocaleString()} triangles · STL ${((84 + 50 * mesh.triangles) / 1e6).toFixed(1)} MB`;
    return mesh;
  } catch (e) {
    console.error(e);
    $('meshinfo').textContent = 'Could not build the record: ' + e.message;
    return null;
  }
}

$('dl').onclick = async () => {
  $('dl').disabled = true;
  const mesh = await build();
  $('dl').disabled = false;
  if (mesh) saveBlob(new Blob([toSTL(mesh)], { type: 'model/stl' }), fileSafe($('title').value) + '.stl');
};
$('dljson').onclick = () => saveBlob(new Blob([JSON.stringify(toDict(assignedScore().sc), null, 1)], { type: 'application/json' }), fileSafe($('title').value) + '.json');
$('dlwav').onclick = () => saveBlob(new Blob([renderWav(assignedScore().sc, { secondsPerRev: +$('spr').value })], { type: 'audio/wav' }), fileSafe($('title').value) + '.wav');
for (const id of ['label', 'thick', 'binset']) $(id).addEventListener(id === 'label' ? 'input' : 'change', scheduleBuild);

// ------------------------------------------------------------------ imports
/** Show a score in the editor. Imported files are whole records, so they start at one repeat. */
function loadScore(s, { repeats: reps = null } = {}) {
  score = { title: s.title || 'TUNE', length_beats: s.length_beats, seconds_per_rev: s.seconds_per_rev || 45, notes: s.notes.map((n) => ({ beat: n.beat, midi: n.midi, velocity: n.velocity ?? 1 })), meta: s.meta || {} };
  // the smallest subdivision (1..4) that puts every note on a cell
  let sub = 4;
  for (const cand of [1, 2, 3, 4]) if (score.notes.every((n) => Math.abs(n.beat * cand - Math.round(n.beat * cand)) < 1e-6)) { sub = cand; break; }
  subEl.value = String(sub);
  beatsEl.value = Math.ceil(score.length_beats);
  if (reps !== null) $('repeats').value = reps;
  $('title').value = score.title;
  $('label').value = score.title.slice(0, 14).toUpperCase();
  $('spr').value = score.seconds_per_rev;
}

$('midi').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const sc = scoreFromMidi(await f.arrayBuffer(), baseName(f.name));
    loadScore(toDict(sc), { repeats: 1 });
    const [shift, bad] = bestTransposition(sc.notes.map((n) => n.midi));
    if (shift) { $('transpose').value = shift; notice = `suggested transpose ${shift > 0 ? '+' : ''}${shift} semitones (${bad} notes still off the comb)`; }
    changed();
    notice = '';
  } catch (err) { showReport('Error: ' + err.message, true); }
};
$('json').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try { loadScore(JSON.parse(await f.text()), { repeats: 1 }); changed(); } catch (err) { showReport('Error: ' + err.message, true); }
};
$('photo').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const res = await scanFile(f, { title: baseName(f.name) }, (msg) => showReport(msg + '…'));
    const q = Math.round(+$('pq').value || 0);
    loadScore(toDict(q > 0 ? quantise(res.score, q) : res.score), { repeats: 1 });
    notice = `${res.pins.length} pins read from the photo` + (res.warnings.length ? '\n' + res.warnings.join('\n') : '');
    changed();
    notice = '';
  } catch (err) { showReport('Error: ' + err.message, true); }
};
$('fromtext').onclick = () => {
  try { loadScore(toDict(parseText($('text').value, stepBeats(), $('title').value))); changed(); } catch (err) { showReport('Error: ' + err.message, true); }
};

// ------------------------------------------------------------------ edits
$('clear').onclick = () => { score.notes = []; changed(); };
$('shiftl').onclick = () => { const s = stepBeats(), L = score.length_beats; score.notes.forEach((n) => { n.beat = (((n.beat - s) % L) + L) % L; }); changed(); };
$('shiftr').onclick = () => { const s = stepBeats(); score.notes.forEach((n) => { n.beat = (n.beat + s) % score.length_beats; }); changed(); };
function transposeStep(dir) {
  const ps = G.PITCH_SET;
  score.notes.forEach((n) => { const i = ps.indexOf(n.midi); if (i >= 0 && ps[i + dir] !== undefined) n.midi = ps[i + dir]; });
  changed();
}
$('transdown').onclick = () => transposeStep(-1);
$('transup').onclick = () => transposeStep(1);
for (const id of ['beats', 'sub', 'repeats', 'transpose', 'autotr', 'snap', 'spr']) $(id).addEventListener('change', changed);
$('title').addEventListener('input', () => { $('label').value = $('title').value.slice(0, 14).toUpperCase(); scheduleBuild(); });

function changed() {
  score.length_beats = +beatsEl.value;
  score.notes = score.notes.filter((n) => n.beat < score.length_beats - 1e-9);
  reassign();
  drawRoll(); drawDisc();
  scheduleBuild();
}

// ------------------------------------------------------------------ start
initStarBadge();
let handoff = null;
try { handoff = JSON.parse(localStorage.getItem('fpmb.handoff') || 'null'); localStorage.removeItem('fpmb.handoff'); } catch (e) { /* storage blocked */ }
if (handoff && handoff.notes) { loadScore(handoff, { repeats: 1 }); changed(); }
else {
  subEl.value = String(DEFAULT_LOOP.stepsPerBeat);
  $('repeats').value = DEFAULT_LOOP.repeats;
  $('text').value = DEFAULT_LOOP.text;
  $('fromtext').click();
}
// demo mode (used for the home-page screenshots): finish the 3D preview before reporting done
if (new URLSearchParams(location.search).has('demo')) { await build(); await new Promise((r) => setTimeout(r, 300)); }
window.__demoDone = true;
