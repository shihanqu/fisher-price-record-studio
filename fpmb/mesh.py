"""Build a printable record (STL) from a Score using manifold3d for robust CSG.

The model follows the original record: a flat disc with a recessed centre
label, centre + four drive holes, eleven 2 mm grooves cut 1.2 mm deep, and a
1 x 1 mm pin growing out of the inner or outer groove wall for every note.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from manifold3d import Manifold, CrossSection

from . import geometry as G
from .score import Score, assign_tracks


@dataclass
class MeshOptions:
    thickness: float = G.DISC_THICKNESS
    bottom_inset: bool = False        # recess the label area on the underside too
    pin_tangential: float = G.PIN_TANGENTIAL
    pin_radial: float = G.PIN_RADIAL
    pin_overlap: float = 0.25         # how far the pin is buried into its wall
    segments: int = 720               # circle resolution (720 -> 0.5 deg)
    label: str = ""                   # embossed text on the centre label
    label_size: float = 5.0
    label_depth: float = 0.6


def _cyl(r: float, h: float, z0: float = 0.0, seg: int = 720) -> Manifold:
    return Manifold.cylinder(h, r, r, seg).translate([0, 0, z0])


def blank(opt: MeshOptions) -> Manifold:
    T = opt.thickness
    seg = opt.segments
    m = _cyl(G.DISC_RADIUS, T, 0, seg)
    # recessed label
    m -= _cyl(G.LABEL_RADIUS, G.LABEL_INSET + 0.01, T - G.LABEL_INSET, seg // 2)
    if opt.bottom_inset:
        m -= _cyl(G.LABEL_RADIUS, G.LABEL_INSET + 0.01, -0.01, seg // 2)
    # holes
    m -= _cyl(G.CENTER_HOLE_RADIUS, T + 2, -1, 96)
    for k in range(4):
        a = k * math.pi / 2
        m -= _cyl(G.DRIVE_HOLE_RADIUS, T + 2, -1, 64).translate(
            [G.DRIVE_HOLE_OFFSET * math.cos(a), G.DRIVE_HOLE_OFFSET * math.sin(a), 0])
    # grooves: one ring cut per groove
    for r0 in G.GROOVE_INNER_RADII:
        ring = _cyl(r0 + G.GROOVE_WIDTH, G.GROOVE_DEPTH + 0.01, T - G.GROOVE_DEPTH, seg) - \
               _cyl(r0, G.GROOVE_DEPTH + 0.02, T - G.GROOVE_DEPTH - 0.005, seg)
        m -= ring
    return m


def pin(track: int, angle_deg: float, opt: MeshOptions) -> Manifold:
    """A pin on `track` at maths-convention `angle_deg`, already offset for the tone arm."""
    T = opt.thickness
    g, side = divmod(track, 2)
    r0 = G.GROOVE_INNER_RADII[g]
    if side == 0:                     # grows outward from the inner wall
        r_in = r0 - opt.pin_overlap
        r_out = r0 + opt.pin_radial
    else:                             # grows inward from the outer wall
        r_out = r0 + G.GROOVE_WIDTH + opt.pin_overlap
        r_in = r0 + G.GROOVE_WIDTH - opt.pin_radial
    z0 = T - G.GROOVE_DEPTH - 0.05
    h = G.GROOVE_DEPTH + 0.05
    box = Manifold.cube([r_out - r_in, opt.pin_tangential, h]).translate([r_in, -opt.pin_tangential / 2, z0])
    return box.rotate([0, 0, angle_deg])


def pin_angle(score: Score, beat: float, track: int) -> float:
    """Where on the disc a note at `beat` on `track` must sit (tone-arm offset applied)."""
    return (score.beat_to_angle(beat) - G.head_offset_deg(G.track_radius(track))) % 360.0


def build(score: Score, opt: MeshOptions | None = None, ensure_tracks: bool = True) -> Manifold:
    opt = opt or MeshOptions()
    if ensure_tracks and any(n.track is None for n in score.notes):
        assign_tracks(score)
    m = blank(opt)
    pins = [pin(n.track, pin_angle(score, n.beat, n.track), opt) for n in score.notes if n.track is not None]
    if pins:
        m += Manifold.batch_boolean(pins, 0) if hasattr(Manifold, "batch_boolean") else _union_all(pins)
    if opt.label:
        m = _add_label(m, opt)
    return m


def _union_all(parts):
    while len(parts) > 1:
        parts = [parts[i] + parts[i + 1] if i + 1 < len(parts) else parts[i] for i in range(0, len(parts), 2)]
    return parts[0]


def _add_label(m: Manifold, opt: MeshOptions) -> Manifold:
    """Emboss text on the label using a simple stroke font (no font files needed)."""
    try:
        from .strokefont import text_polygons
    except ImportError:
        return m
    polys = text_polygons(opt.label, opt.label_size, stroke=opt.label_size * 0.16)
    if not polys:
        return m
    from manifold3d import FillRule
    cs = CrossSection(polys, FillRule.Positive)
    if cs.area() <= 0:
        return m
    T = opt.thickness
    txt = Manifold.extrude(cs, opt.label_depth).translate([0, -G.LABEL_RADIUS * 0.55, T - G.LABEL_INSET])
    return m + txt


def to_stl(m: Manifold, path) -> dict:
    """Write binary STL and return a few stats."""
    mesh = m.to_mesh()
    v = np.asarray(mesh.vert_properties)[:, :3].astype(np.float32)
    f = np.asarray(mesh.tri_verts).astype(np.int64)
    tri = v[f]                                   # (n,3,3)
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    n /= (np.linalg.norm(n, axis=1, keepdims=True) + 1e-12)
    rec = np.zeros(len(f), dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("attr", "<u2")])
    rec["n"] = n; rec["v"] = tri
    with open(path, "wb") as fh:
        fh.write(b"fpmb record".ljust(80, b"\0"))
        fh.write(np.uint32(len(f)).tobytes())
        fh.write(rec.tobytes())
    return {"triangles": int(len(f)), "vertices": int(len(v)),
            "volume_mm3": float(m.volume()), "genus": int(m.genus()) if hasattr(m, "genus") else None,
            "bbox": [float(x) for x in np.r_[v.min(0), v.max(0)]]}


def to_stl_bytes(m: Manifold) -> bytes:
    import io, tempfile, os
    fd, p = tempfile.mkstemp(suffix=".stl"); os.close(fd)
    try:
        to_stl(m, p)
        with open(p, "rb") as fh:
            return fh.read()
    finally:
        os.unlink(p)
