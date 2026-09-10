// Note Scanner page: photo in, notes out. Everything runs in the browser.

import * as G from './geometry.js';
import { scanFile } from './scan.js';
import { fromDict, quantise, toDict } from './score.js';
import { Player, renderWav } from './synth.js';
import { writeMidi } from './midi.js';
import { baseName, fileSafe, initStarBadge, saveBlob } from './common.js';

const $ = (id) => document.getElementById(id);
const player = new Player();
let result = null;      // the last scan
let score = null;       // what is shown: the scan's score, quantised if asked
let lastFile = null;
let playhead = -1;      // beat being played, or -1

// ---------------------------------------------------------------- input
const drop = $('drop'), fileInput = $('file');
drop.onclick = () => fileInput.click();
drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } };
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) scan(e.dataTransfer.files[0]); };
fileInput.onchange = () => { const f = fileInput.files[0]; fileInput.value = ''; if (f) scan(f); };
$('rescan').onclick = () => lastFile && scan(lastFile);
$('sample').onclick = async () => {
  const r = await fetch('samples/edelweiss.jpg');
  if (!r.ok) { status('Could not load the sample photo.', true); return; }
  await scan(new File([await r.blob()], 'edelweiss.jpg', { type: 'image/jpeg' }));
};
$('title').oninput = () => { $('title').dataset.auto = '0'; };

function status(text, bad = false) { const el = $('status'); el.textContent = text; el.className = bad ? 'bad' : ''; }
function setBusy(busy) {
  $('sample').disabled = busy;
  $('rescan').disabled = busy || !lastFile;
  drop.classList.toggle('busy', busy);
}

async function scan(file) {
  lastFile = file;
  player.stop();
  setBusy(true);
  const t0 = performance.now();
  try {
    const res = await scanFile(file, { title: baseName(file.name), minStrength: +$('ms').value, secondsPerRev: +$('spr').value }, (msg) => status(msg + '…'));
    result = res;
    if (!$('title').value || $('title').dataset.auto !== '0') { $('title').value = baseName(file.name); $('title').dataset.auto = '1'; }
    applyQuantise();
    drawOverlay();
    $('s-pins').textContent = res.pins.length;
    $('s-notes').textContent = new Set(res.score.notes.map((n) => n.midi)).size;
    $('s-cov').textContent = Math.round(100 * res.coverage) + '%';
    const off = res.grooveFit.global_offset_mm;
    $('s-fit').textContent = `${off >= 0 ? '+' : ''}${off.toFixed(2)} mm`;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    status(`${res.pins.length} pins found in ${secs} s` + (res.warnings.length ? '\n' + res.warnings.join('\n') : ''), res.warnings.length > 0);
    for (const id of ['play', 'dljson', 'dlmidi', 'dlwav', 'todesigner']) $(id).disabled = false;
  } catch (e) {
    console.error(e);
    status('Error: ' + e.message, true);
  }
  setBusy(false);
}

function applyQuantise() {
  if (!result) return;
  const q = Math.round(+$('pq').value || 0);
  score = q > 0 ? quantise(result.score, q) : result.score;
  drawRoll();
  fillTable();
}
$('pq').onchange = applyQuantise;
$('spr').onchange = () => { drawRoll(); fillTable(); };

// ---------------------------------------------------------------- straightened photo with pins
const overlay = $('overlay'), octx = overlay.getContext('2d');
const sweep = $('sweep'), sctx = sweep.getContext('2d');

function drawOverlay() {
  const o = result.overlay;
  overlay.width = sweep.width = o.width;
  overlay.height = sweep.height = o.height;
  octx.putImageData(new ImageData(o.data, o.width, o.height), 0, 0);
  const c = o.width / 2, k = o.pxPerMm;
  octx.lineWidth = Math.max(1.5, o.width / 600);
  octx.strokeStyle = 'rgba(220, 40, 40, 0.8)';
  octx.beginPath(); octx.arc(c, c, G.DISC_RADIUS * k, 0, 2 * Math.PI); octx.stroke();
  octx.strokeStyle = '#2cff4a';
  octx.lineWidth = Math.max(2, o.width / 500);
  for (const [t, a] of result.pins) {
    const r = G.trackRadius(t) * k, rad = (a * Math.PI) / 180;
    octx.beginPath(); octx.arc(c + r * Math.cos(rad), c - r * Math.sin(rad), 0.9 * k, 0, 2 * Math.PI); octx.stroke();
  }
  overlay.hidden = false;
  $('overlay-empty').hidden = true;
  drawSweep();
}

function drawSweep() {
  sctx.clearRect(0, 0, sweep.width, sweep.height);
  if (!result || !score || playhead < 0) return;
  const o = result.overlay, c = o.width / 2;
  // The arm is reading the notes at `playhead`. Their pins lie where the comb
  // touches the record, 2 mm to one side of the arm's radius (geometry.armLine),
  // and a quantised score also carries the phase of its grid.
  const theta = (score.meta.start_angle_deg || 0) + (score.meta.quantise_phase_deg || 0) + (360 * playhead) / score.length_beats;
  sctx.strokeStyle = 'rgba(255,255,255,.95)';
  sctx.lineWidth = Math.max(2, o.width / 400);
  sctx.beginPath();
  G.armLine(theta, c, c, o.pxPerMm).forEach(([x, y], i) => (i ? sctx.lineTo(x, y) : sctx.moveTo(x, y)));
  sctx.stroke();
}

// ---------------------------------------------------------------- notes over one revolution
const roll = $('roll'), rctx = roll.getContext('2d');
function drawRoll() {
  if (!score) return;
  const P = G.PITCH_SET.slice().reverse();
  const W = Math.max(900, roll.parentElement.clientWidth - 2), LEFT = 46, TOP = 8, RH = 18, H = TOP + P.length * RH + 24;
  roll.width = W; roll.height = H;
  rctx.fillStyle = '#fff'; rctx.fillRect(0, 0, W, H);
  const span = W - LEFT - 8, L = score.length_beats;
  P.forEach((m, r) => {
    const y = TOP + r * RH;
    rctx.fillStyle = m % 12 === 8 ? '#f3efe4' : '#fff';
    rctx.fillRect(LEFT, y, span, RH);
    rctx.fillStyle = '#444'; rctx.font = '11px system-ui'; rctx.textAlign = 'right';
    rctx.fillText(G.midiName(m), LEFT - 5, y + 13);
  });
  rctx.strokeStyle = '#e6e0d4';
  for (let r = 0; r <= P.length; r++) { const y = TOP + r * RH; rctx.beginPath(); rctx.moveTo(LEFT, y); rctx.lineTo(LEFT + span, y); rctx.stroke(); }
  const spr = +$('spr').value;
  rctx.fillStyle = '#888'; rctx.textAlign = 'left';
  for (let s = 0; s < spr; s += 5) {
    const x = LEFT + (span * s) / spr;
    rctx.strokeStyle = '#d9d2c5'; rctx.beginPath(); rctx.moveTo(x, TOP); rctx.lineTo(x, TOP + P.length * RH); rctx.stroke();
    rctx.fillText(s + ' s', x + 2, TOP + P.length * RH + 14);
  }
  rctx.fillStyle = '#3aa06a';
  for (const n of score.notes) {
    const r = P.indexOf(n.midi);
    if (r < 0) continue;
    const x = LEFT + (span * n.beat) / L, y = TOP + r * RH;
    rctx.beginPath(); rctx.roundRect(x - 3, y + 3, 7, RH - 6, 2); rctx.fill();
  }
  if (playhead >= 0) {
    const x = LEFT + (span * playhead) / L;
    rctx.strokeStyle = '#f28c28'; rctx.lineWidth = 2;
    rctx.beginPath(); rctx.moveTo(x, TOP); rctx.lineTo(x, TOP + P.length * RH); rctx.stroke();
    rctx.lineWidth = 1;
  }
}

function fillTable() {
  const tb = $('notes').querySelector('tbody');
  const spb = +$('spr').value / score.length_beats;
  const rows = score.notes.map((n, i) => `<tr><td>${i + 1}</td><td>${n.beat.toFixed(2)}</td><td>${(n.beat * spb).toFixed(2)}</td><td>${G.midiName(n.midi)}</td><td>${n.track ?? ''}</td><td>${(n.velocity ?? 1).toFixed(2)}</td></tr>`);
  tb.innerHTML = rows.join('');
}

// ---------------------------------------------------------------- playback
$('play').onclick = () => {
  if (!score) return;
  const spr = +$('spr').value;
  player.play({
    notes: score.notes, loopBeats: score.length_beats, secPerBeat: spr / score.length_beats,
    keepLooping: () => $('loopplay').checked,
    onTick: (beat) => { playhead = beat; drawRoll(); drawSweep(); },
    onStop: () => { playhead = -1; drawRoll(); drawSweep(); },
  });
};
$('stop').onclick = () => player.stop();

// ---------------------------------------------------------------- export
const outScore = () => ({ ...toDict(score), title: $('title').value || score.title, seconds_per_rev: +$('spr').value });
const outName = (ext) => fileSafe($('title').value) + ext;
$('dljson').onclick = () => saveBlob(new Blob([JSON.stringify(outScore(), null, 1)], { type: 'application/json' }), outName('.json'));
$('dlmidi').onclick = () => { const sc = fromDict(outScore()); saveBlob(new Blob([writeMidi(sc, { secondsPerRev: sc.seconds_per_rev })], { type: 'audio/midi' }), outName('.mid')); };
$('dlwav').onclick = () => { const sc = fromDict(outScore()); saveBlob(new Blob([renderWav(sc, { secondsPerRev: sc.seconds_per_rev })], { type: 'audio/wav' }), outName('.wav')); };
$('todesigner').onclick = () => {
  try { localStorage.setItem('fpmb.handoff', JSON.stringify(outScore())); } catch (e) { /* storage blocked: the designer opens with its starter loop */ }
  window.open('designer.html', '_blank');
};

initStarBadge();
new ResizeObserver(() => drawRoll()).observe(document.body);
// demo mode (used for the home-page screenshots): scan the sample before reporting done
if (new URLSearchParams(location.search).has('demo')) { await $('sample').onclick(); await new Promise((r) => setTimeout(r, 300)); }
window.__demoDone = true;
