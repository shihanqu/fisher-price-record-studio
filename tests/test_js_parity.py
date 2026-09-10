#!/usr/bin/env python3
"""The web app in docs/js is a JavaScript port of the Python library in fpmb/.
This checks that the two agree, running the JavaScript under Node:

    .venv/bin/python tests/test_js_parity.py

It compares the geometry constants, the scipy stand-ins (Gaussian, median and
percentile filters, find_peaks), text parsing, track assignment, quantising,
MIDI bytes, the record mesh, and the photo scanner on the reference photos and
on synthetic photos rendered by tests/test_roundtrip.py.
"""
import base64, json, math, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))
import cv2, numpy as np, scipy.ndimage as ndi, scipy.signal as ss   # noqa: E402
from fpmb import extract as X, geometry as G, mesh, score as S, synth  # noqa: E402
import test_roundtrip as RT                                           # noqa: E402

TMP = tempfile.mkdtemp(prefix="fpmb-parity-")
failures = []


def check(name, ok, detail=""):
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"  ({detail})" if detail else ""))
    if not ok:
        failures.append(name)


def run_js(jobs):
    jp, rp = os.path.join(TMP, "jobs.json"), os.path.join(TMP, "results.json")
    with open(jp, "w") as f:
        json.dump(jobs, f)
    subprocess.run(["node", os.path.join(ROOT, "tests", "js_runner.mjs"), jp, rp], check=True)
    with open(rp) as f:
        return json.load(f)


def close_dicts(a, b, tol=1e-9):
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(close_dicts(a[k], b[k], tol) for k in a)
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(close_dicts(x, y, tol) for x, y in zip(a, b))
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return math.isclose(a, b, rel_tol=tol, abs_tol=tol)
    return a == b


def match_pins(a, b, tol=0.5):
    """Most pins of `a` matched to `b` (same track, angles within tol) over all rotations."""
    def count(rot):
        used, m = set(), 0
        for t, x, _ in a:
            for k, (t2, y, _) in enumerate(b):
                if k not in used and t == t2 and abs(((x + rot - y + 180) % 360) - 180) < tol:
                    used.add(k); m += 1
                    break
        return m
    coarse = max(np.arange(0, 360, 0.5), key=count)
    return max(count(r) for r in np.arange(coarse - 0.5, coarse + 0.5, 0.05))


# ------------------------------------------------------------------ geometry
g = run_js([{"op": "geometry"}])[0]
py = {k: getattr(G, k) for k in g if k.isupper()}
check("geometry constants", close_dicts({k: g[k] for k in py}, {k: (list(v) if isinstance(v, (list, tuple)) else v) for k, v in py.items()}))
check("head offsets and note names", close_dicts(g["head_offsets"], [G.head_offset_deg(r) for r in G.TRACK_RADII]) and g["names"] == [G.midi_name(m) for m in G.PITCH_SET])

# ------------------------------------------------------------------ signal helpers vs scipy
rng = np.random.default_rng(3)
jobs, want = [], []
for _ in range(4):
    x = np.round(rng.standard_normal(3600).cumsum() * 0.1 + rng.standard_normal(3600), 6)
    jobs += [{"op": "gaussian", "x": x.tolist(), "sigma": 3.0, "mode": "wrap"}, {"op": "gaussian", "x": x.tolist(), "sigma": 40.0, "mode": "reflect"},
             {"op": "rank", "x": x.tolist(), "size": 120, "rank": 60}, {"op": "rank", "x": x.tolist(), "size": 120, "rank": 30}]
    want += [ndi.gaussian_filter1d(x, 3.0, mode="wrap"), ndi.gaussian_filter1d(x, 40.0, mode="reflect"),
             ndi.median_filter(x, size=120, mode="wrap"), ndi.percentile_filter(x, 25, size=120, mode="wrap")]
    z = np.tile(np.round(ndi.gaussian_filter1d(rng.standard_normal(3600), 2.0, mode="wrap") * 3, 6), 3)
    kw = {"height": 0.5, "prominence": 0.3, "distance": 17, "width": [3.8, 28.5]}
    jobs.append({"op": "peaks", "x": z.tolist(), "kw": kw})
    want.append(ss.find_peaks(z, height=0.5, prominence=0.3, distance=17, width=(3.8, 28.5))[0])
res = run_js(jobs)
errs = [float(np.max(np.abs(np.asarray(r) - np.asarray(w)))) if len(r) == len(w) else 1e9 for r, w in zip(res, want)]
check("gaussian / median / percentile filters and find_peaks match scipy", max(errs) < 1e-9, f"max error {max(errs):.1e}")

# ------------------------------------------------------------------ scores
texts = ["C5 Eb5 G5 C6 . G5 Eb5 C5 | Ab4 C5 Eb5 Ab5 . Eb5 C5 Ab4", "C5 D#5 . Eb5 # comment\n# whole line\nG5+C6 | _ -", "C5 X9"]
jobs = [{"op": "parse_text", "text": t, "beats_per_step": 0.5, "title": "t"} for t in texts]
res = run_js(jobs)
ok = True
for t, r in zip(texts, res):
    try:
        ok &= close_dicts(S.parse_text(t, 0.5, "t").to_dict(), r)
    except ValueError:
        ok &= "error" in r
check("text notation parses the same", ok)

jobs, want = [], []
for seed in range(12):
    r2 = np.random.default_rng(seed)
    length = float(r2.choice([8, 16, 24, 32, 96]))
    notes = [{"beat": float(r2.integers(0, int(length * 2)) / 2), "midi": int(r2.integers(55, 100)), "velocity": 1.0} for _ in range(int(r2.integers(5, 90)))]
    d = {"title": "r", "length_beats": length, "seconds_per_rev": 45.0, "meta": {}, "notes": notes}
    repeats, transpose, snap = int(r2.choice([1, 1, 2, 3])), int(r2.integers(-3, 4)), bool(r2.integers(0, 2))
    jobs.append({"op": "assign", "score": d, "repeats": repeats, "transpose": transpose, "snap": snap})
    sc = S.Score.from_dict(d)
    if repeats > 1:
        sc = S.repeat_to_fill(sc, repeats)
    for n in sc.notes:
        n.track = None
    rep = S.assign_tracks(sc, transpose, snap)
    want.append({"score": sc.to_dict(), "rep": {"assigned": rep.assigned, "dropped": [list(x) for x in rep.dropped], "snapped": [list(x) for x in rep.snapped]}})
    jobs.append({"op": "quantise", "score": d, "bpr": int(r2.choice([48, 96, 100]))})
    want.append(X.quantise(S.Score.from_dict(d), jobs[-1]["bpr"]).to_dict())
    jobs.append({"op": "transpose", "midis": [n["midi"] for n in notes]})
    want.append(list(S.best_transposition([n["midi"] for n in notes])))
res = run_js(jobs)
check("track assignment, quantising and transposition agree", all(close_dicts(r, w) for r, w in zip(res, want)),
      f"{sum(close_dicts(r, w) for r, w in zip(res, want))}/{len(want)}")

# ------------------------------------------------------------------ MIDI
ed = S.Score.load(os.path.join(ROOT, "output", "edelweiss.json"))
starter = S.parse_text(texts[0], 0.5, "MY TUNE")
ok_w = ok_r = True
for sc in (ed, starter):
    p = os.path.join(TMP, "m.mid")
    synth.write_midi(sc, p)
    with open(p, "rb") as f:
        py_bytes = f.read()
    js_bytes = base64.b64decode(run_js([{"op": "midi_write", "score": sc.to_dict(), "spr": sc.seconds_per_rev}])[0])
    ok_w &= js_bytes == py_bytes
    back = run_js([{"op": "midi_read", "b64": base64.b64encode(py_bytes).decode(), "title": "x"}])[0]
    ref = S.load_midi(p, title="x").to_dict()
    ok_r &= close_dicts(back, ref, 1e-6)
check("MIDI written by the browser is byte-identical to mido's", ok_w)
check("MIDI files read back to the same notes", ok_r)

# ------------------------------------------------------------------ mesh
cases = [(starter, {"label": "MY TUNE"}, mesh.MeshOptions(label="MY TUNE")),
         (ed, {"label": "EDELWEISS"}, mesh.MeshOptions(label="EDELWEISS")),
         (S.parse_text("C5 . Eb5 . G5", 1, "X"), {"label": "", "bottomInset": True, "thickness": 3.0}, mesh.MeshOptions(bottom_inset=True, thickness=3.0))]
res = run_js([{"op": "mesh", "score": sc.to_dict(), "opt": jo} for sc, jo, _ in cases])
ok = True
for (sc, _, po), r in zip(cases, res):
    s2 = S.Score.from_dict(sc.to_dict())
    for n in s2.notes:
        n.track = None
    S.assign_tracks(s2)
    m = mesh.build(s2, po, ensure_tracks=False)
    ok &= r["triangles"] == len(m.to_mesh().tri_verts) and math.isclose(r["volume"], m.volume(), rel_tol=1e-9) and r["genus"] == m.genus()
check("record mesh: same triangles, volume and genus as manifold3d", ok)

wav = run_js([{"op": "wav", "score": ed.to_dict(), "spr": 45.0}])[0]
check("WAV length matches the Python renderer", wav["bytes"] == 44 + 2 * (int(44100 * 47.0) + 1))

# ------------------------------------------------------------------ the photo scanner
def rgba_job(img_bgr, name):
    s = min(1.0, 3000 / max(img_bgr.shape[:2]))     # the browser caps the long side at 3000 px
    if s < 1:
        img_bgr = cv2.resize(img_bgr, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    p = os.path.join(TMP, name)
    cv2.imwrite(p + ".png", img_bgr)
    cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGBA).tofile(p + ".rgba")
    return {"op": "extract", "rgba": p + ".rgba", "w": img_bgr.shape[1], "h": img_bgr.shape[0]}, p + ".png"


photos = [("edelweiss", "data/edelweiss_record.jpg", 1.0), ("frame", "data/edelweiss_on_player_t30.jpg", 0.97)]
jobs, pys = [], []
for name, path, _ in photos:
    job, png = rgba_job(cv2.imread(os.path.join(ROOT, path)), name)
    jobs.append(job)
    pys.append(X.extract(png).pins)
res = run_js(jobs)
for (name, _, need), r, pp in zip(photos, res, pys):
    m = match_pins(r["pins"], pp)
    check(f"scanner on {name}: same pins as Python", m >= need * max(len(pp), len(r["pins"])),
          f"python {len(pp)}, browser {len(r['pins'])}, matched {m}, {r['ms'] / 1000:.1f} s")

sw = run_js([{**jobs[0], "op": "sweep"}])[0]
check("play-along line crosses each pin exactly when its note sounds", sw["raw"] < 1e-6 and sw["quantised"] <= sw["halfStep"] + 1e-6,
      f"worst miss {sw['raw']:.1e} deg raw, {sw['quantised']:.2f} deg quantised to 100 beats")

jobs, truths = [], []
for seed in range(4):
    r2 = np.random.default_rng(seed)
    sc = S.Score(96.0, [], "roundtrip")
    for _ in range(60):
        sc.notes.append(S.Note(float(r2.integers(0, 96)), int(r2.choice(G.PITCH_SET))))
    S.assign_tracks(sc)
    photo, _ = RT.fake_photo(RT.render_top_view(sc, seed), seed)
    job, _ = rgba_job(photo, f"synthetic{seed}")
    jobs.append(job)
    truths.append([(n.track, mesh.pin_angle(sc, n.beat, n.track), 1.0) for n in sc.notes])
res = run_js(jobs)
for seed, (r, truth) in enumerate(zip(res, truths)):
    m = match_pins(truth, r["pins"], tol=1.0)
    check(f"scanner on synthetic photo {seed}: every pin, nothing extra", m == len(truth) and len(r["pins"]) == m, f"{m}/{len(truth)} found, {len(r['pins']) - m} extra")

print("\nPASS" if not failures else f"\nFAIL: {', '.join(failures)}")
sys.exit(1 if failures else 0)
