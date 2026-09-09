"""Diagnostics for the extractor: zoomed polar tiles with the sampled bands drawn."""
from __future__ import annotations
import math
import cv2
import numpy as np
from . import geometry as G
from . import extract as X


def polar_tile(ex, track: int, angle: float, half_deg: float = 4.0, r_pad: float = 1.5, zoom: int = 4):
    """Polar crop around (track, angle).  Rows = radius (outward is down), cols = angle.
    Draws: wall faces (red), near band (green), far band (yellow) as actually sampled."""
    P = ex.polar
    pol, angs, rads, off, scale = P["pol"], P["angs"], P["rads"], P["offset"], P["scale"]
    g, side = divmod(track, 2)
    ri = G.GROOVE_INNER_RADII[g] * scale + off
    ro = ri + G.GROOVE_WIDTH * scale
    a0 = int(round((angle - half_deg) / X.POLAR_DEG_STEP)) % len(angs)
    n = int(round(2 * half_deg / X.POLAR_DEG_STEP))
    cols = (a0 + np.arange(n)) % len(angs)
    rlo = ri[cols].mean() - r_pad; rhi = ro[cols].mean() + r_pad
    i0 = max(0, int((rlo - rads[0]) / X.POLAR_MM_STEP)); i1 = min(len(rads) - 1, int((rhi - rads[0]) / X.POLAR_MM_STEP))
    crop = pol[cols][:, i0:i1].T                       # rows radius, cols angle
    crop = crop - crop.min(); crop = (255 * crop / (crop.max() + 1e-6)).astype(np.uint8)
    img = cv2.cvtColor(crop, cv2.COLOR_GRAY2BGR)
    img = cv2.resize(img, None, fx=zoom, fy=zoom * (X.POLAR_DEG_STEP / X.POLAR_MM_STEP) / 2, interpolation=cv2.INTER_NEAREST)
    def y_of(rmm):   # rmm array per column -> pixel rows
        return ((rmm - rads[i0]) / X.POLAR_MM_STEP * img.shape[0] / crop.shape[0]).astype(np.int32)
    xs = np.arange(n) * zoom
    def line(rmm, col):
        pts = np.stack([xs, y_of(rmm)], 1).astype(np.int32)
        cv2.polylines(img, [pts], False, col, 1)
    line(ri[cols], (0, 0, 255)); line(ro[cols], (0, 0, 255))
    if side == 0:
        line(ri[cols] + 0.10, (0, 255, 0)); line(ri[cols] + 0.55, (0, 255, 0)); line(ri[cols] + 0.95, (0, 255, 255))
    else:
        line(ro[cols] - 0.10, (0, 255, 0)); line(ro[cols] - 0.55, (0, 255, 0)); line(ro[cols] - 0.95, (0, 255, 255))
    xc = int(n / 2) * zoom
    cv2.line(img, (xc, 0), (xc, img.shape[0] - 1), (255, 0, 255), 1)
    cv2.putText(img, f"t{track} {angle:.1f}", (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1)
    return img


def groove_profile(ex, groove: int, angle: float, width_deg: float = 0.6):
    """Mean radial profile (floor-subtracted, wall-normalised) across a groove at `angle`."""
    P = ex.polar
    pol, angs, rads, off, scale, sign = P["pol"], P["angs"], P["rads"], P["offset"], P["scale"], P["sign"]
    i = int(round(angle / X.POLAR_DEG_STEP)) % len(angs)
    w = int(width_deg / X.POLAR_DEG_STEP / 2)
    cols = (i + np.arange(-w, w + 1)) % len(angs)
    ri = G.GROOVE_INNER_RADII[groove] * scale + off[i]; ro = ri + G.GROOVE_WIDTH * scale
    rs = np.arange(ri - 0.8, ro + 0.8, 0.05)
    prof = np.array([np.interp(rs, rads, pol[c]).astype(float) for c in cols]).mean(axis=0) * sign
    return rs - ri, prof
