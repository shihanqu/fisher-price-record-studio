#!/usr/bin/env python3
"""Synthetic round trip: score -> fake photograph -> extract -> compare.

Renders a shaded top view of a record from a score (walls bright, floors
dark, pins at wall height), applies a random 3-D tilt, rotation and blur,
then checks that the extractor recovers every pin on the right track within
a small angular tolerance.  Run:  .venv/bin/python tests/test_roundtrip.py
"""
import math, os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np, cv2
from fpmb import geometry as G, score as S, extract as X, mesh

PX = 20.0   # px per mm in the synthetic top view


def render_top_view(sc: S.Score, seed=0) -> np.ndarray:
    size = int(2 * (G.DISC_RADIUS + 15) * PX)
    c = size / 2
    yy, xx = np.mgrid[:size, :size]
    r = np.hypot(xx - c, yy - c) / PX
    ang = np.degrees(np.arctan2(-(yy - c), xx - c)) % 360
    height = np.full((size, size), -1.0)               # -1 = background
    top, floor, label = 3.2, 2.0, 2.2
    height[r < G.DISC_RADIUS] = top
    height[r < G.LABEL_RADIUS] = label
    for r0 in G.GROOVE_INNER_RADII:
        height[(r > r0) & (r < r0 + G.GROOVE_WIDTH)] = floor
    for n in sc.notes:
        a = mesh.pin_angle(sc, n.beat, n.track)
        g, side = divmod(n.track, 2)
        r0 = G.GROOVE_INNER_RADII[g]
        rin, rout = (r0 - 0.2, r0 + G.PIN_RADIAL) if side == 0 else (r0 + G.GROOVE_WIDTH - G.PIN_RADIAL, r0 + G.GROOVE_WIDTH + 0.2)
        da = np.abs(((ang - a + 180) % 360) - 180)
        half = math.degrees(G.PIN_TANGENTIAL / 2 / G.track_radius(n.track))
        height[(r > rin) & (r < rout) & (da < half)] = top
    # shade: a directional light from the upper-left plus height-dependent brightness
    rng = np.random.default_rng(seed)
    gx = cv2.Sobel(height, cv2.CV_64F, 1, 0, ksize=3); gy = cv2.Sobel(height, cv2.CV_64F, 0, 1, ksize=3)
    shade = 0.55 + 0.25 * (height - floor) / (top - floor) + 0.15 * np.clip(-gx * 0.6 + gy * 0.4, -1, 1)
    img = np.zeros((size, size, 3), np.float32)
    green = np.array([70, 160, 90]) / 255
    for k in range(3):
        img[..., k] = np.where(height >= 0, shade * green[k] + 0.05 * rng.standard_normal((size, size)), 0.85)
    for hole_r, hx, hy in [(G.CENTER_HOLE_RADIUS, 0, 0)] + [(G.DRIVE_HOLE_RADIUS, G.DRIVE_HOLE_OFFSET * math.cos(k * math.pi / 2), G.DRIVE_HOLE_OFFSET * math.sin(k * math.pi / 2)) for k in range(4)]:
        img[np.hypot(xx - c - hx * PX, yy - c + hy * PX) < hole_r * PX] = (0.9, 0.85, 0.8)
    return np.clip(img * 255, 0, 255).astype(np.uint8)


def fake_photo(img, seed=0):
    rng = np.random.default_rng(seed)
    h, w = img.shape[:2]
    tilt = math.radians(rng.uniform(10, 28)); rot = rng.uniform(0, 360); roll = rng.uniform(0, 360)
    # simple pinhole: rotate disc about z by `rot`, tilt about x by `tilt`, project with focal length f
    f = 3.0 * w
    pts = np.array([[0, 0], [w, 0], [w, h], [0, h]], np.float64) - [w / 2, h / 2]
    ca, sa = math.cos(math.radians(rot)), math.sin(math.radians(rot))
    P = pts @ np.array([[ca, -sa], [sa, ca]])
    X3 = P[:, 0]; Y3 = P[:, 1] * math.cos(tilt); Z3 = f + P[:, 1] * math.sin(tilt)
    proj = np.stack([f * X3 / Z3, f * Y3 / Z3], 1) * 0.85
    cr, sr = math.cos(math.radians(roll)), math.sin(math.radians(roll))
    proj = proj @ np.array([[cr, -sr], [sr, cr]]) + [w / 2, h / 2]
    H = cv2.getPerspectiveTransform((pts + [w / 2, h / 2]).astype(np.float32), proj.astype(np.float32))
    out = cv2.warpPerspective(img, H, (w, h), borderValue=(200, 190, 170))
    out = cv2.GaussianBlur(out, (0, 0), 1.2)
    return out, rot


def run(seed=0, n_notes=60, verbose=True):
    rng = np.random.default_rng(seed)
    sc = S.Score(96.0, [], "roundtrip")
    for _ in range(n_notes):
        sc.notes.append(S.Note(float(rng.integers(0, 96)), int(rng.choice(G.PITCH_SET))))
    S.assign_tracks(sc)
    img = render_top_view(sc, seed)
    photo, rot = fake_photo(img, seed)
    fd, p = tempfile.mkstemp(suffix=".png"); os.close(fd)
    cv2.imwrite(p, photo)
    ex = X.extract(p)
    os.unlink(p)
    truth = [(n.track, mesh.pin_angle(sc, n.beat, n.track)) for n in sc.notes]
    # find the rotation aligning extraction to truth
    best = None
    for r in np.arange(0, 360, 0.25):
        m = sum(1 for t, a in truth if any(t == t2 and abs(((a2 + r - a + 180) % 360) - 180) < 1.0 for t2, a2, _ in ex.pins))
        if best is None or m > best[0]:
            best = (m, r)
    m, r = best
    extra = len(ex.pins) - m
    if verbose:
        print(f"seed {seed}: {m}/{len(truth)} pins recovered, {extra} spurious; groove fit offset {ex.groove_fit['global_offset_mm']:+.2f} mm scale {ex.groove_fit['scale']:.3f}")
    return m, len(truth), extra


if __name__ == "__main__":
    ok = True
    for seed in range(4):
        m, n, extra = run(seed)
        ok &= (m == n and extra == 0)
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)
