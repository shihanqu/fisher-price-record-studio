"""Physical geometry of a Fisher-Price #995 record and the player's comb.

All lengths are millimetres, all angles are degrees.  Angles follow the
usual maths convention (counter-clockwise positive, 0 deg = +X) when the
record is viewed from above, i.e. looking at the grooved side.

Sources
-------
Disc, groove and pin dimensions come from the OpenSCAD template that
Fred Murphy published for this player (as re-used by odrevet's
music-box-tune-tracker) and were cross-checked against the photographs in
data/.  The pitch set was measured directly from data/edelweiss_playing.wav
(every partial within +-10 cents of equal temperament, A = 440 Hz).
"""
from __future__ import annotations

from dataclasses import dataclass

# --- disc --------------------------------------------------------------
DISC_RADIUS = 60.58          # outer radius of the record
DISC_THICKNESS = 3.2         # total thickness including groove walls
CENTER_HOLE_RADIUS = 3.22
DRIVE_HOLE_RADIUS = 1.55     # the four small holes that engage the turntable pegs
DRIVE_HOLE_OFFSET = 21.8     # distance of each drive hole from the centre
LABEL_RADIUS = 25.6          # the recessed centre label area
LABEL_INSET = 1.0            # how far the label area is recessed below the wall tops

# --- grooves -----------------------------------------------------------
GROOVE_DEPTH = 1.2           # wall top down to groove floor
GROOVE_WIDTH = 2.0           # radial width of a groove (floor between two walls)
GROOVE_PITCH = 2.775         # radial spacing between successive grooves
# Inner radius (the inner wall face) of each of the 11 grooves, innermost first.
GROOVE_INNER_RADII = [
    28.15, 30.89, 33.71, 36.425, 39.225, 42.0,
    44.825, 47.555, 50.315, 53.11, 55.9,
]
N_GROOVES = len(GROOVE_INNER_RADII)

# --- pins --------------------------------------------------------------
PIN_RADIAL = 1.0             # a pin reaches this far into the groove from its wall
PIN_TANGENTIAL = 1.0         # pin width along the direction of travel
PIN_HEIGHT = GROOVE_DEPTH    # pins are flush with the wall tops

# Two tines ride in every groove: one hugging the inner wall, one the outer
# wall.  A pin attached to the inner wall plucks the inner tine, and so on.
N_TRACKS = 2 * N_GROOVES     # 22 physical pin tracks == 22 tines


def track_radius(track: int) -> float:
    """Radial centre line of a pin on physical track 0..21 (innermost first)."""
    g, side = divmod(track, 2)
    r0 = GROOVE_INNER_RADII[g]
    return r0 + PIN_RADIAL / 2 if side == 0 else r0 + GROOVE_WIDTH - PIN_RADIAL / 2


def track_wall_radius(track: int) -> float:
    """Radius of the wall face this track's pins grow out of."""
    g, side = divmod(track, 2)
    r0 = GROOVE_INNER_RADII[g]
    return r0 if side == 0 else r0 + GROOVE_WIDTH


TRACK_RADII = [track_radius(t) for t in range(N_TRACKS)]

# --- pitches -----------------------------------------------------------
# MIDI note number sounded by each physical track (innermost first).  Six
# pitches appear twice (adjacent tracks) so the player can repeat a note
# quickly without the tine having to recover.  Measured from the Edelweiss
# recording: the comb is an Ab-major scale from Eb4 to Bb6.
TRACK_MIDI = [
    63,      # 0  D#4 / Eb4
    68,      # 1  G#4 / Ab4
    70,      # 2  A#4 / Bb4
    72,      # 3  C5
    75,      # 4  D#5 / Eb5
    77,      # 5  F5
    79,      # 6  G5
    80, 80,  # 7,8    G#5 / Ab5 (x2)
    82, 82,  # 9,10   A#5 / Bb5 (x2)
    84, 84,  # 11,12  C6 (x2)
    85, 85,  # 13,14  C#6 / Db6 (x2)
    87, 87,  # 15,16  D#6 / Eb6 (x2)
    89, 89,  # 17,18  F6 (x2)
    91,      # 19  G6
    92,      # 20  G#6 / Ab6
    94,      # 21  A#6 / Bb6
]
assert len(TRACK_MIDI) == N_TRACKS

PITCH_SET = sorted(set(TRACK_MIDI))          # the 16 distinct playable pitches

# Tracks available for each pitch, in preferred order.
TRACKS_FOR_MIDI: dict[int, list[int]] = {}
for _t, _m in enumerate(TRACK_MIDI):
    TRACKS_FOR_MIDI.setdefault(_m, []).append(_t)

# --- motion ------------------------------------------------------------
# Measured by tracking the pin pattern across data/edelweiss_playing.mp4:
# about 45 s per revolution just after winding, slowing to ~65 s as the
# spring runs down.  Other owners report 25-40 s.  Treat this as a default,
# not a constant; the record itself only encodes angles.
SECONDS_PER_REV = 45.0
# Viewed from above (looking at the grooved side) the record turns
# clockwise.  Material therefore approaches the tone arm from *larger*
# maths-convention angles, so playback time increases with pin angle:
#     t = ((angle - arm_angle) mod 360) / 360 * SECONDS_PER_REV
ROTATION_CW = True
# The tines are not on a radial line: the comb is offset tangentially by
# about 2 mm, so a pin on an inner track meets its tine at a slightly
# different rotation than a pin on an outer track at the same angle.  Fred
# Murphy's template places a pin for musical time T at
#     angle = T_angle - degrees(HEAD_OFFSET_MM / radius)
# and that convention is reproduced here (and inverted when extracting).
# Fitting simultaneous pins (chords) on the Edelweiss record suggests ~1 mm
# for this player; the difference is under 0.15 s at 45 s/rev.
HEAD_OFFSET_MM = 2.0

# Minimum arc length between two pins on the same track.  Closer than this and
# the tine is still deflected by the first pin when the second arrives.
MIN_PIN_ARC_MM = 2.2


def head_offset_deg(radius: float) -> float:
    """Angular correction for a pin at `radius` due to the comb's tangential offset."""
    import math
    return math.degrees(HEAD_OFFSET_MM / radius)


def midi_name(m: int, flats: bool = True) -> str:
    names = ("C Db D Eb E F Gb G Ab A Bb B" if flats else "C C# D D# E F F# G G# A A# B").split()
    return f"{names[m % 12]}{m // 12 - 1}"


def midi_freq(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


@dataclass(frozen=True)
class Layout:
    """Everything a renderer or extractor needs, bundled for convenience."""
    disc_radius: float = DISC_RADIUS
    groove_inner_radii: tuple = tuple(GROOVE_INNER_RADII)
    groove_width: float = GROOVE_WIDTH
    groove_depth: float = GROOVE_DEPTH
    pin_radial: float = PIN_RADIAL
    pin_tangential: float = PIN_TANGENTIAL
    track_radii: tuple = tuple(TRACK_RADII)
    track_midi: tuple = tuple(TRACK_MIDI)


LAYOUT = Layout()
