"""Extract the note pattern from a photograph of a Fisher-Price record.

Pipeline
--------
1.  Segment the green disc, fit an ellipse to its outline and warp the image
    so the disc becomes a circle at a known scale (px per mm).
2.  Find the centre hole and the four drive holes and refine the warp to a
    full homography (this removes the residual perspective that an ellipse
    fit alone cannot).
3.  Unwrap to polar coordinates (angle x radius, in mm).
4.  Locate the groove walls in every angular sector and build a small
    radial correction map, so that later sampling lands exactly on the pin
    tracks even if the disc is slightly off the nominal geometry.
5.  For each of the 22 pin tracks, build a 1-D signal along the angle that
    is ~1 where the surface is at wall height (a pin) and ~0 on the groove
    floor, and pick peaks.
6.  Convert pin angles to musical time (accounting for the tone-arm's
    tangential offset) and pitches.

Everything is deterministic; set `debug_dir` to get diagnostic images.
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass, field

import cv2
import numpy as np
import scipy.ndimage as ndi
import scipy.signal as ss

from . import geometry as G
from .score import Note, Score

PX_PER_MM = 16.0                      # working resolution of the rectified image
RECT_MARGIN_MM = 4.0
POLAR_DEG_STEP = 0.1                  # angular resolution of the unwrapped image
POLAR_MM_STEP = 0.05                  # radial resolution
POLAR_R_MIN = 24.0
POLAR_R_MAX = G.DISC_RADIUS + 1.0


@dataclass
class Extraction:
    score: Score
    pins: list = field(default_factory=list)     # (track, angle_deg, strength)
    px_per_mm: float = PX_PER_MM
    homography: np.ndarray | None = None
    groove_fit: dict = field(default_factory=dict)
    warnings: list = field(default_factory=list)
    visible_by_angle: np.ndarray | None = None    # fraction of groove band visible, per 0.1 deg
    rectified: np.ndarray | None = None           # the straightened BGR image (disc centred, px_per_mm)
    polar: dict = field(default_factory=dict)     # pol, angs, rads, offset_per_angle, scale, sign, debug signals
    pin_details: list = field(default_factory=list)  # dicts: track, angle, z, snr, path ...

    def overlay(self, radius_mm: float = 0.9, thickness: int = 2) -> np.ndarray:
        """The rectified image with every detected pin circled (BGR)."""
        rv = self.rectified.copy()
        c = (rv.shape[1] // 2, rv.shape[0] // 2)
        k = self.px_per_mm
        cv2.circle(rv, c, int(G.DISC_RADIUS * k), (0, 0, 255), 1)
        for track, ang, s in self.pins:
            r = G.track_radius(track) * k
            a = math.radians(ang)
            p = (int(c[0] + r * math.cos(a)), int(c[1] - r * math.sin(a)))
            cv2.circle(rv, p, int(radius_mm * k), (0, 255, 0), thickness)
        return rv


# ---------------------------------------------------------------------------
# 1. find the disc
# ---------------------------------------------------------------------------

def disc_mask(img_bgr: np.ndarray, keep_holes: bool = False) -> np.ndarray:
    """Mask of the (green) record.  Works for any strongly saturated hue by
    picking the dominant hue of the big central blob."""
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    sat = (s > 60) & (v > 40)
    # dominant hue among saturated pixels near the image centre
    cy, cx = np.array(img_bgr.shape[:2]) // 2
    r = min(cx, cy) // 2
    win = sat[cy - r: cy + r, cx - r: cx + r]
    hist = np.bincount(h[cy - r: cy + r, cx - r: cx + r][win].ravel(), minlength=180)
    hist = ndi.gaussian_filter1d(hist.astype(float), 3, mode="wrap")
    hue0 = int(np.argmax(hist))
    dh = np.minimum(np.abs(h.astype(int) - hue0), 180 - np.abs(h.astype(int) - hue0))
    m = ((dh < 14) & sat).astype(np.uint8) * 255
    k = np.ones((7, 7), np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k)
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = max(cs, key=cv2.contourArea)
    filled = np.zeros_like(m)
    cv2.drawContours(filled, [c], -1, 255, -1)
    if keep_holes:
        return filled & m          # disc silhouette, but holes stay black
    return filled


def fit_disc_ellipse(mask: np.ndarray):
    cs, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = max(cs, key=cv2.contourArea)
    hull = cv2.convexHull(c)                     # fingers can bite into the edge
    return cv2.fitEllipse(hull)                  # ((cx,cy),(w,h),angle)


def affine_from_ellipse(ellipse, px_per_mm: float, out_size: int) -> np.ndarray:
    """2x3 affine mapping the ellipse to a circle of radius DISC_RADIUS*px_per_mm
    centred in a square image of side out_size."""
    (cx, cy), (w, h), ang = ellipse
    a, b = w / 2, h / 2
    R = G.DISC_RADIUS * px_per_mm
    c = out_size / 2
    th = math.radians(ang)
    # image -> ellipse frame (rotate by -ang about centre), scale axes, translate
    Rm = np.array([[math.cos(th), math.sin(th)], [-math.sin(th), math.cos(th)]])
    S = np.diag([R / a, R / b])
    A = S @ Rm
    t = np.array([c, c]) - A @ np.array([cx, cy])
    return np.hstack([A, t[:, None]])


# ---------------------------------------------------------------------------
# 2. holes -> homography refinement
# ---------------------------------------------------------------------------

def find_holes(rect_bgr: np.ndarray, rect_mask: np.ndarray, px_per_mm: float):
    """Return (centre_xy, [4 drive hole xy]) in rectified-image pixels, or None."""
    h, w = rect_mask.shape
    c = np.array([w / 2, h / 2])
    yy, xx = np.mgrid[:h, :w]
    rr = np.hypot(xx - c[0], yy - c[1]) / px_per_mm
    region = (rr < G.LABEL_RADIUS - 1.0)
    holes = (rect_mask == 0) & region
    holes = cv2.morphologyEx(holes.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, stats, cents = cv2.connectedComponentsWithStats(holes)
    cands = []
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA] / px_per_mm ** 2
        bw = stats[i, cv2.CC_STAT_WIDTH]; bh = stats[i, cv2.CC_STAT_HEIGHT]
        fill = stats[i, cv2.CC_STAT_AREA] / (math.pi / 4 * bw * bh + 1e-6)
        if 1.5 < area < 80 and 0.6 < bw / bh < 1.6 and fill > 0.6:
            cands.append((cents[i], area))
    if not cands:
        return None
    # centre hole: nearest to c with area ~ pi*3.22^2 = 32
    centre = min(cands, key=lambda k: np.hypot(*(k[0] - c)))
    if np.hypot(*(centre[0] - c)) > 6 * px_per_mm:
        centre = None
    drive = []
    for p, area in cands:
        d = np.hypot(*(p - c)) / px_per_mm
        if abs(d - G.DRIVE_HOLE_OFFSET) < 3.0 and area < 30:
            drive.append(p)
    if len(drive) != 4:
        return (centre[0] if centre else None, drive)
    return (centre[0] if centre else None, drive)


def refine_homography(rect_mask: np.ndarray, holes, px_per_mm: float):
    """Homography (rectified -> better rectified) from the drive holes plus rim points.

    Under perspective the centre of the fitted ellipse is *not* the disc
    centre, so the ellipse-only warp leaves the holes off-centre and the
    grooves wobbling.  The holes pin the centre down; the rim then fixes the
    remaining scale/skew.  Solved iteratively because a rim point's true
    angle is only known once the centre is right.
    """
    h, w = rect_mask.shape
    c = np.array([w / 2, h / 2])
    R = G.DISC_RADIUS * px_per_mm
    centre, drive = holes
    hole_src, hole_dst = [], []
    if len(drive) == 4:
        ang = np.array([math.atan2(p[1] - c[1], p[0] - c[0]) for p in drive])
        phase = math.atan2(np.sin(4 * ang).mean(), np.cos(4 * ang).mean()) / 4
        for p, a in zip(drive, ang):
            k = round((a - phase) / (math.pi / 2))
            a2 = phase + k * math.pi / 2
            hole_src.append(p)
            hole_dst.append(c + G.DRIVE_HOLE_OFFSET * px_per_mm * np.array([math.cos(a2), math.sin(a2)]))
    if centre is not None:
        hole_src.append(centre); hole_dst.append(c)
    cs, _ = cv2.findContours(rect_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cont = max(cs, key=cv2.contourArea)[:, 0, :].astype(np.float32)
    hull = cv2.convexHull(cont)[:, 0, :]
    # rim points that lie on the actual boundary (not a hull edge bridging a bite)
    d0 = np.hypot(hull[:, 0] - c[0], hull[:, 1] - c[1])
    rim = hull[np.abs(d0 - R) < 0.06 * R]
    if len(rim) < 8:
        return np.eye(3)
    H = np.eye(3)
    if len(hole_src) >= 4:
        H, _ = cv2.findHomography(np.array(hole_src, np.float32), np.array(hole_dst, np.float32), 0)
        if H is None:
            H = np.eye(3)
    for _ in range(4):
        rim_w = cv2.perspectiveTransform(rim[None].astype(np.float32), H.astype(np.float64))[0]
        a = np.arctan2(rim_w[:, 1] - c[1], rim_w[:, 0] - c[0])
        rim_dst = c + R * np.stack([np.cos(a), np.sin(a)], 1)
        # holes weigh as much as the whole rim
        rep = max(1, len(rim) // max(1, len(hole_src))) if hole_src else 0
        src = np.concatenate([rim] + [np.array(hole_src, np.float32)] * rep) if hole_src else rim
        dst = np.concatenate([rim_dst] + [np.array(hole_dst, np.float32)] * rep) if hole_src else rim_dst
        H2, _ = cv2.findHomography(src.astype(np.float32), dst.astype(np.float32), 0)
        if H2 is None:
            break
        H = H2
    return H


# ---------------------------------------------------------------------------
# 3. polar unwrap
# ---------------------------------------------------------------------------

def unwrap_polar(rect_gray: np.ndarray, px_per_mm: float):
    h, w = rect_gray.shape
    c = (w / 2, h / 2)
    angs = np.arange(0, 360, POLAR_DEG_STEP)
    rads = np.arange(POLAR_R_MIN, POLAR_R_MAX, POLAR_MM_STEP)
    A, Rr = np.meshgrid(np.radians(angs), rads, indexing="ij")
    # maths convention: angle CCW from +x when viewed from above, image y is down
    mx = (c[0] + Rr * px_per_mm * np.cos(A)).astype(np.float32)
    my = (c[1] - Rr * px_per_mm * np.sin(A)).astype(np.float32)
    pol = cv2.remap(rect_gray, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    return pol.astype(np.float32), angs, rads


# ---------------------------------------------------------------------------
# 4. groove wall localisation
# ---------------------------------------------------------------------------

def wall_template(rads: np.ndarray, scale: float = 1.0, offset: float = 0.0) -> np.ndarray:
    """+1 on wall tops, -1 on groove floors for the nominal layout."""
    t = np.zeros_like(rads)
    for r0 in G.GROOVE_INNER_RADII:
        ri = r0 * scale + offset
        ro = ri + G.GROOVE_WIDTH * scale
        t[(rads > ri + 0.2) & (rads < ro - 0.2)] = -1
        wall_lo = ri - (G.GROOVE_PITCH - G.GROOVE_WIDTH) * scale
        t[(rads > wall_lo + 0.1) & (rads < ri - 0.1)] = 1
    t[(rads > G.GROOVE_INNER_RADII[-1] * scale + offset + G.GROOVE_WIDTH * scale + 0.1)
      & (rads < (G.GROOVE_INNER_RADII[-1] + G.GROOVE_PITCH) * scale + offset)] = 1
    return t


def fit_grooves(pol: np.ndarray, angs: np.ndarray, rads: np.ndarray, n_sectors: int = 36, valid=None):
    """Per-sector radial offset (mm) of the wall pattern relative to nominal.

    Returns (offset_per_angle, scale, quality) where offset_per_angle is
    interpolated to every column of `pol`."""
    # a 'wallness' signal: high-pass along radius so lighting gradients vanish
    hp = pol - ndi.gaussian_filter1d(pol, 2.0 / POLAR_MM_STEP, axis=1)
    if valid is not None:
        hp = np.where(valid, hp, 0.0)
    # walls are the bright *or* dark phase depending on lighting; decide globally
    prof = hp.mean(axis=0)
    best = None
    for scale in np.linspace(0.99, 1.01, 5):
        for off in np.arange(-1.0, 1.0, 0.025):
            t = wall_template(rads, scale, off)
            c = float(np.dot(prof, t))
            if best is None or abs(c) > abs(best[0]):
                best = (c, scale, off)
    corr, scale, off0 = best
    sign = 1.0 if corr > 0 else -1.0     # +1: walls brighter than floors
    # now per sector, small offsets around the global fit
    sec = np.array_split(np.arange(len(angs)), n_sectors)
    offs = []
    centres = []
    for idx in sec:
        p = hp[idx].mean(axis=0) * sign
        bo, bc = off0, -1e9
        for off in np.arange(off0 - 0.6, off0 + 0.6, 0.025):
            c = float(np.dot(p, wall_template(rads, scale, off)))
            if c > bc:
                bo, bc = off, c
        offs.append(bo); centres.append(angs[idx].mean())
    offs = np.array(offs); centres = np.array(centres)
    # smooth cyclically and interpolate to every angle
    offs_s = ndi.gaussian_filter1d(offs, 1.0, mode="wrap")
    ext_c = np.concatenate([centres - 360, centres, centres + 360])
    ext_o = np.concatenate([offs_s, offs_s, offs_s])
    per_angle = np.interp(angs, ext_c, ext_o)
    return per_angle, scale, sign, {"global_offset_mm": off0, "scale": scale,
                                    "sector_offsets_mm": offs.tolist(), "walls_brighter": sign > 0}


# ---------------------------------------------------------------------------
# 5. pin detection
# ---------------------------------------------------------------------------

def _band(pol, rads, r_lo, r_hi):
    """Mean over a radial band that may vary per angle (r_lo/r_hi arrays)."""
    # sample with per-angle offsets using interpolation on the radial axis
    out = np.empty(pol.shape[0], np.float32)
    n = max(2, int((np.mean(r_hi - r_lo)) / POLAR_MM_STEP))
    for i in range(pol.shape[0]):
        rs = np.linspace(r_lo[i], r_hi[i], n)
        out[i] = np.interp(rs, rads, pol[i]).mean()
    return out


def rolling_percentile(x: np.ndarray, win: int, q: float) -> np.ndarray:
    return ndi.percentile_filter(x, q, size=win, mode="wrap")


def detect_pins(pol, angs, rads, offset_per_angle, scale, sign, min_strength=0.5,
                valid=None, snr_min=8.0, min_strength_snr=0.3):
    """Return list of (track, angle_deg, strength) and per-track debug signals.

    `valid` is an optional boolean (angle x radius) mask of where the disc
    surface is actually visible; pins are only reported where it is True.
    """
    pins = []
    details = []
    debug = {}
    debug["details"] = details
    win_deg = 12.0
    win = int(win_deg / POLAR_DEG_STEP)
    # Floor map: a low percentile along the angle at every radius removes
    # anything that is constant around the disc (groove floor shading, the
    # wall faces made visible by perspective) but keeps the sparse pins.
    floor_map = ndi.percentile_filter(pol * sign, 25, size=(win, 1), mode="wrap") * sign
    hp = (pol - floor_map) * sign          # 0 on anything constant around the disc
    hp_raw = (pol * sign)                  # for wall-vs-floor reference levels
    for g, r0n in enumerate(G.GROOVE_INNER_RADII):
        ri = r0n * scale + offset_per_angle                 # inner wall face, per angle
        ro = ri + G.GROOVE_WIDTH * scale                     # outer wall face
        wall_w = (G.GROOVE_PITCH - G.GROOVE_WIDTH) * scale   # ~0.775
        # reference: the neighbouring wall tops relative to the local floor
        # wall-top level minus groove-floor level, both smoothed along the angle
        fl = _band(floor_map * sign, rads, ri + 0.6, ro - 0.6)
        w_in = _band(hp_raw, rads, ri - wall_w + 0.15, ri - 0.15) - fl
        w_out = _band(hp_raw, rads, ro + 0.15, ro + wall_w - 0.15) - fl
        for side in (0, 1):
            track = 2 * g + side
            # three radial bands from the wall face to the pin tip: root, near, far
            if side == 0:
                root = _band(hp, rads, ri + 0.10, ri + 0.35)
                near = _band(hp, rads, ri + 0.10, ri + 0.55)
                far = _band(hp, rads, ri + 0.55, ri + 0.95)
                wref = w_in
                lo, hi = ri + 0.1, ri + 0.95
            else:
                root = _band(hp, rads, ro - 0.35, ro - 0.10)
                near = _band(hp, rads, ro - 0.55, ro - 0.10)
                far = _band(hp, rads, ro - 0.95, ro - 0.55)
                wref = w_out
                lo, hi = ro - 0.95, ro - 0.1
            wall = ndi.median_filter(wref, size=win, mode="wrap")
            # The reference is the neighbouring wall top above the floor.  Where
            # that wall is in shadow (the label rim, the outer rim under a
            # finger) the local value collapses and would inflate everything,
            # so never let it drop below half of its typical value.
            wall = np.maximum(wall, 0.5 * np.median(wall))
            wall = np.maximum(wall, 1e-3)
            sm = 0.3 / POLAR_DEG_STEP
            zr = ndi.gaussian_filter1d(root / wall, sm, mode="wrap")
            zn = ndi.gaussian_filter1d(near / wall, sm, mode="wrap")
            zf = ndi.gaussian_filter1d(far / wall, sm, mode="wrap")
            # a real pin is at wall height from the wall face to its tip;
            # bleed from the other track's pin only reaches the tip
            z = np.minimum(np.minimum(zr, zn), zf)
            # Second, lighting-independent view of the same signal: how far the
            # band rises above the groove floor's own noise.  Where perspective
            # shows a lit wall *face*, `wall` is huge and z is tiny even for a
            # perfectly good pin, but the pin still stands well clear of the
            # floor texture.
            raw = np.minimum(ndi.gaussian_filter1d(near, 0.3 / POLAR_DEG_STEP, mode="wrap"),
                             ndi.gaussian_filter1d(far, 0.3 / POLAR_DEG_STEP, mode="wrap"))
            noise = 1.4826 * ndi.median_filter(np.abs(raw - ndi.median_filter(raw, size=win, mode="wrap")),
                                               size=win, mode="wrap")
            snr = raw / np.maximum(noise, 1e-6)
            r_mid = 0.5 * (lo + hi).mean()
            pin_deg = math.degrees(G.PIN_TANGENTIAL / r_mid)
            dist = int(max(1, 1.8 * pin_deg / POLAR_DEG_STEP))
            wlim = (0.4 * pin_deg / POLAR_DEG_STEP, 3.0 * pin_deg / POLAR_DEG_STEP)
            n = len(z)
            if valid is not None:
                vb = _band(valid.astype(np.float32), rads, lo - 0.5, hi + 0.5) > 0.99
            found = {}
            # path 1: strong relative to the wall top
            zz = np.concatenate([z, z, z])
            pk, props = ss.find_peaks(zz, height=min_strength, prominence=0.3, distance=dist, width=wlim)
            for p, hgt in zip(pk, props["peak_heights"]):
                if n <= p < 2 * n:
                    found[p - n] = float(hgt)
            # path 2: clearly above the floor noise, and at least a little of wall height
            ss_ = np.concatenate([snr, snr, snr])
            pk2, props2 = ss.find_peaks(ss_, height=snr_min, prominence=snr_min * 0.6, distance=dist, width=wlim)
            for p in pk2:
                if n <= p < 2 * n:
                    i = p - n
                    if z[i] < min_strength_snr:
                        continue
                    if any(abs(i - j) < dist for j in found):
                        continue
                    found[i] = float(max(z[i], min_strength))     # report as a confident pin
            for i, hgt in sorted(found.items()):
                if valid is not None and not vb[i]:
                    continue
                pins.append((track, float(angs[i]), hgt))
                details.append({"track": track, "angle": float(angs[i]), "z": float(z[i]), "snr": float(snr[i]),
                                "zn": float(zn[i]), "zf": float(zf[i]), "wall": float(wall[i]),
                                "path": "wall" if z[i] >= min_strength else "snr"})
            debug[track] = z
            debug[("snr", track)] = snr
            debug[("internals", track)] = {"near": near, "far": far, "wall": wall, "zn": zn, "zf": zf, "snr": snr, "raw": raw, "noise": noise}
    return pins, debug


def visible_fraction(valid, rads):
    """Fraction of the groove area that is visible (for reporting)."""
    band = (rads > G.GROOVE_INNER_RADII[0]) & (rads < G.GROOVE_INNER_RADII[-1] + G.GROOVE_WIDTH)
    return float(valid[:, band].mean())


# ---------------------------------------------------------------------------
# 6. pins -> score
# ---------------------------------------------------------------------------

def pins_to_score(pins, title: str, beats_per_rev: float | None = None,
                  start_angle: float | None = None, seconds_per_rev: float = G.SECONDS_PER_REV) -> Score:
    """Convert pins to a Score.  Time runs with increasing angle (clockwise
    rotation seen from above) and the tone-arm offset is undone.  With no
    `start_angle`, beat 0 is placed at the start of the longest silence."""
    ev = []
    for track, ang, strength in pins:
        r = G.track_radius(track)
        t_ang = (ang + G.head_offset_deg(r)) % 360.0
        ev.append((t_ang, track, strength))
    ev.sort()
    if not ev:
        return Score(beats_per_rev or 360.0, [], title, seconds_per_rev)
    if start_angle is None:
        a = np.array([e[0] for e in ev])
        gaps = np.diff(np.concatenate([a, [a[0] + 360]]))
        i = int(np.argmax(gaps))
        start_angle = (a[i] + gaps[i] * 0.5) % 360.0      # middle of the longest gap
    if beats_per_rev is None:
        beats_per_rev = 360.0
    sc = Score(beats_per_rev, [], title, seconds_per_rev)
    sc.meta["start_angle_deg"] = start_angle
    for t_ang, track, strength in ev:
        rel = (t_ang - start_angle) % 360.0
        sc.notes.append(Note(rel / 360.0 * beats_per_rev, G.TRACK_MIDI[track], track,
                             velocity=float(min(1.0, strength))))
    sc.notes.sort(key=lambda n: n.beat)
    return sc


def quantise(score: Score, beats_per_rev: int) -> Score:
    """Snap note times to a grid of `beats_per_rev` steps per revolution,
    choosing the grid phase that minimises the error."""
    a = np.array([360.0 * n.beat / score.length_beats for n in score.notes])
    step = 360.0 / beats_per_rev
    best = None
    for ph in np.linspace(0, step, 40, endpoint=False):
        err = np.abs(((a - ph + step / 2) % step) - step / 2)
        if best is None or err.sum() < best[0]:
            best = (err.sum(), ph)
    ph = best[1]
    out = Score(float(beats_per_rev), [], score.title, score.seconds_per_rev, dict(score.meta))
    out.meta["quantise_rms_deg"] = float(math.sqrt(np.mean(((a - ph + step / 2) % step - step / 2) ** 2)))
    for n, ang in zip(score.notes, a):
        b = int(round((ang - ph) / step)) % beats_per_rev
        out.notes.append(Note(float(b), n.midi, n.track, n.velocity))
    out.notes.sort(key=lambda n: (n.beat, n.midi))
    return out


# ---------------------------------------------------------------------------
# driver
# ---------------------------------------------------------------------------

def extract(image_path, title: str = "", debug_dir: str | None = None,
            px_per_mm: float = PX_PER_MM, min_strength: float = 0.5,
            seconds_per_rev: float = G.SECONDS_PER_REV) -> Extraction:
    img = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if img is None:
        raise FileNotFoundError(image_path)
    warnings = []
    mask = disc_mask(img, keep_holes=True)
    ell = fit_disc_ellipse(mask)
    out_size = int(2 * (G.DISC_RADIUS + RECT_MARGIN_MM) * px_per_mm)
    A = affine_from_ellipse(ell, px_per_mm, out_size)
    rect = cv2.warpAffine(img, A, (out_size, out_size), flags=cv2.INTER_LINEAR)
    rmask = cv2.warpAffine(mask, A, (out_size, out_size), flags=cv2.INTER_NEAREST)
    holes = find_holes(rect, rmask, px_per_mm)
    H = np.eye(3)
    if holes is not None:
        H = refine_homography(rmask, holes, px_per_mm)
        if len(holes[1]) != 4:
            warnings.append(f"found {len(holes[1])} drive holes (expected 4); perspective refinement is rim-only")
    else:
        warnings.append("no holes found; perspective refinement is rim-only")
    rect2 = cv2.warpPerspective(rect, H, (out_size, out_size), flags=cv2.INTER_LINEAR)
    rmask2 = cv2.warpPerspective(rmask, H, (out_size, out_size), flags=cv2.INTER_NEAREST)
    gray = cv2.cvtColor(rect2, cv2.COLOR_BGR2GRAY)
    # local contrast normalisation so lighting falloff across the disc does not matter
    g = gray.astype(np.float32)
    blur = cv2.GaussianBlur(g, (0, 0), 3.0 * px_per_mm)
    g = g - blur
    pol, angs, rads = unwrap_polar(g, px_per_mm)
    filled = np.zeros_like(rmask2)
    cs_, _ = cv2.findContours(rmask2, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cv2.drawContours(filled, [max(cs_, key=cv2.contourArea)], -1, 255, -1)
    occluder = cv2.morphologyEx(filled & ~rmask2, cv2.MORPH_OPEN, np.ones((int(2.5 * px_per_mm) | 1,) * 2, np.uint8))
    occluder = cv2.dilate(occluder, np.ones((int(1.5 * px_per_mm) | 1,) * 2, np.uint8))
    vmask = filled & ~occluder
    vpol, _, _ = unwrap_polar(vmask.astype(np.float32), px_per_mm)
    valid = vpol > 127
    coverage = visible_fraction(valid, rads)
    if coverage < 0.98:
        warnings.append(f"only {100 * coverage:.0f}% of the groove area is visible; notes in hidden sectors are missing")
    off, scale, sign, gfit = fit_grooves(pol, angs, rads, valid=valid)
    if abs(gfit["global_offset_mm"]) > 0.9 or not (0.975 < scale < 1.025):
        warnings.append(f"groove fit is far from nominal (offset {gfit['global_offset_mm']:.2f} mm, scale {scale:.3f})")
    pins, dbg = detect_pins(pol, angs, rads, off, scale, sign, min_strength, valid)
    score = pins_to_score(pins, title, seconds_per_rev=seconds_per_rev)
    score.meta.update({"source_image": os.path.basename(str(image_path)), "n_pins": len(pins),
                       "visible_fraction": coverage,
                       "groove_fit": {k: v for k, v in gfit.items() if k != "sector_offsets_mm"}})
    band = (rads > G.GROOVE_INNER_RADII[0]) & (rads < G.GROOVE_INNER_RADII[-1] + G.GROOVE_WIDTH)
    ex = Extraction(score, pins, px_per_mm, H, gfit, warnings, valid[:, band].mean(axis=1), rect2,
                    {"pol": pol, "angs": angs, "rads": rads, "offset": off, "scale": scale, "sign": sign,
                     "valid": valid, "debug": dbg})
    ex.pin_details = dbg.get("details", [])
    if debug_dir:
        os.makedirs(debug_dir, exist_ok=True)
        _write_debug(debug_dir, img, mask, ell, rect2, rmask2, holes, pol, angs, rads, off, scale, pins, dbg, px_per_mm)
    return ex


def _write_debug(d, img, mask, ell, rect, rmask, holes, pol, angs, rads, off, scale, pins, dbg, px_per_mm):
    vis = img.copy()
    cv2.ellipse(vis, ell, (0, 0, 255), 6)
    cv2.imwrite(os.path.join(d, "01_disc_ellipse.jpg"), cv2.resize(vis, None, fx=0.25, fy=0.25))
    rv = rect.copy()
    c = (rect.shape[1] // 2, rect.shape[0] // 2)
    cv2.circle(rv, c, int(G.DISC_RADIUS * px_per_mm), (0, 0, 255), 2)
    cv2.circle(rv, c, int(G.LABEL_RADIUS * px_per_mm), (0, 0, 255), 1)
    for t in range(G.N_TRACKS):
        cv2.circle(rv, c, int(G.track_radius(t) * px_per_mm), (255, 0, 255) if t % 2 == 0 else (255, 255, 0), 1)
    for track, ang, s in pins:
        r = G.track_radius(track) * px_per_mm
        a = math.radians(ang)
        p = (int(c[0] + r * math.cos(a)), int(c[1] - r * math.sin(a)))
        cv2.circle(rv, p, int(0.9 * px_per_mm), (0, 255, 0), 2)
    cv2.imwrite(os.path.join(d, "02_rectified_pins.jpg"), rv)
    # polar image with track lines and detections
    pn = pol - pol.min(); pn = (255 * pn / (pn.max() + 1e-6)).astype(np.uint8)
    pv = cv2.cvtColor(pn.T.copy(), cv2.COLOR_GRAY2BGR)    # rows = radius, cols = angle
    xs = np.arange(0, len(angs), 20)
    for t in range(G.N_TRACKS):
        ys = ((G.track_radius(t) * scale + off[xs] - rads[0]) / POLAR_MM_STEP).astype(np.int32)
        pts = np.stack([xs, ys], 1).astype(np.int32)
        cv2.polylines(pv, [pts], False, (255, 0, 255) if t % 2 == 0 else (255, 255, 0), 1)
    for track, ang, s in pins:
        x = int(ang / POLAR_DEG_STEP)
        y = int((G.track_radius(track) * scale + off[min(x, len(off) - 1)] - rads[0]) / POLAR_MM_STEP)
        cv2.circle(pv, (x, y), 9, (0, 255, 0), 1)
    cv2.imwrite(os.path.join(d, "03_polar_pins.png"), pv)
    # per-track signals
    hgt = 40
    canvas = np.full((G.N_TRACKS * hgt, len(angs), 3), 255, np.uint8)
    for t, z in dbg.items():
        if not isinstance(t, int):
            continue
        y0 = (G.N_TRACKS - 1 - t) * hgt
        pts = np.stack([np.arange(len(z)), y0 + hgt - 2 - np.clip(z, -0.2, 1.4) * (hgt - 4) / 1.6 - 5], 1).astype(np.int32)
        cv2.polylines(canvas, [pts], False, (60, 60, 60), 1)
        cv2.putText(canvas, f"{t} {G.midi_name(G.TRACK_MIDI[t])}", (2, y0 + 14), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 200), 1)
    for track, ang, s in pins:
        x = int(ang / POLAR_DEG_STEP); y0 = (G.N_TRACKS - 1 - track) * hgt
        cv2.line(canvas, (x, y0), (x, y0 + hgt), (0, 200, 0), 1)
    cv2.imwrite(os.path.join(d, "04_track_signals.png"), canvas)
