"""Note-event data model shared by the extractor, synthesiser, mesher and designer.

A *Score* is just a list of `Note`s with a duration (the length of the loop /
one revolution).  Times are in *beats* where a beat is a free unit; the
conversion to angle on the disc is `angle = 360 * beat / length_beats`.

JSON form:
    {
      "title": "Edelweiss",
      "length_beats": 90,            # one revolution == this many beats
      "seconds_per_rev": 45.0,       # only used for audio rendering
      "notes": [ {"beat": 0.0, "midi": 72, "track": 3}, ... ]
    }
`track` is optional; when absent (a freshly composed score) the mesher
assigns physical tracks itself.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field, asdict
from typing import Iterable

from . import geometry as G


@dataclass
class Note:
    beat: float            # position within the loop, in beats
    midi: int              # pitch (MIDI note number)
    track: int | None = None   # physical track 0..21, if already decided
    velocity: float = 1.0      # only used for audio rendering


@dataclass
class Score:
    length_beats: float
    notes: list[Note] = field(default_factory=list)
    title: str = ""
    seconds_per_rev: float = G.SECONDS_PER_REV
    meta: dict = field(default_factory=dict)

    # ---- conversions ----
    def beat_to_angle(self, beat: float) -> float:
        return 360.0 * (beat / self.length_beats)

    def angle_to_beat(self, angle: float) -> float:
        return self.length_beats * ((angle % 360.0) / 360.0)

    def beat_to_seconds(self, beat: float) -> float:
        return self.seconds_per_rev * beat / self.length_beats

    def sorted_notes(self) -> list[Note]:
        return sorted(self.notes, key=lambda n: (n.beat, n.midi))

    # ---- (de)serialisation ----
    def to_dict(self) -> dict:
        return {
            "title": self.title,
            "length_beats": self.length_beats,
            "seconds_per_rev": self.seconds_per_rev,
            "meta": self.meta,
            "notes": [
                {k: v for k, v in asdict(n).items() if not (k == "track" and v is None)}
                for n in self.sorted_notes()
            ],
        }

    def to_json(self, **kw) -> str:
        return json.dumps(self.to_dict(), indent=1, **kw)

    @classmethod
    def from_dict(cls, d: dict) -> "Score":
        notes = [Note(float(n["beat"]), int(n["midi"]), n.get("track"), float(n.get("velocity", 1.0)))
                 for n in d.get("notes", [])]
        return cls(float(d["length_beats"]), notes, d.get("title", ""),
                   float(d.get("seconds_per_rev", G.SECONDS_PER_REV)), d.get("meta", {}))

    @classmethod
    def load(cls, path) -> "Score":
        with open(path) as f:
            return cls.from_dict(json.load(f))

    def save(self, path) -> None:
        with open(path, "w") as f:
            f.write(self.to_json())

    # ---- text rendering ----
    def describe(self) -> str:
        lines = [f"{self.title or 'untitled'}: {len(self.notes)} notes over "
                 f"{self.length_beats:g} beats (~{self.seconds_per_rev:g} s/rev)"]
        for n in self.sorted_notes():
            trk = f" track {n.track:2d}" if n.track is not None else ""
            lines.append(f"  beat {n.beat:7.2f}  {G.midi_name(n.midi):>4}{trk}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Importers
# ---------------------------------------------------------------------------

_NOTE_RE = re.compile(r"^([A-Ga-g])([#b]?)(-?\d)$")


def parse_note_name(name: str) -> int:
    """'C5' -> 72, 'Eb4' -> 63, 'D#4' -> 63."""
    m = _NOTE_RE.match(name.strip())
    if not m:
        raise ValueError(f"bad note name {name!r}")
    base = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[m.group(1).upper()]
    acc = {"": 0, "#": 1, "b": -1}[m.group(2)]
    return 12 * (int(m.group(3)) + 1) + base + acc


def parse_text(text: str, beats_per_step: float = 1.0, title: str = "") -> Score:
    """Very small text notation, one step per whitespace-separated token.

        C5 E5 G5 C6 . G5 E5+C5 . |
    '.', '-' or '_' is a rest, '+' joins simultaneous notes, '|' is ignored
    (bar line), and a token starting with '#' comments out the rest of the
    line (so sharps like 'D#5' still work).  The loop length is the number
    of steps.
    """
    notes: list[Note] = []
    step = 0
    for line in text.splitlines():
        for tok in line.split():
            if tok.startswith("#"):
                break
            if tok == "|":
                continue
            if tok not in (".", "-", "_"):
                for part in tok.split("+"):
                    notes.append(Note(step * beats_per_step, parse_note_name(part)))
            step += 1
    return Score(step * beats_per_step, notes, title)


def load_midi(path, title: str = "") -> Score:
    """Read a MIDI file; beats are MIDI quarter notes (tempo ignored, we get
    the speed from seconds_per_rev instead).  Loop length is rounded up to
    a whole quarter note."""
    import mido
    mid = mido.MidiFile(path)
    tpb = mid.ticks_per_beat
    notes: list[Note] = []
    length = 0.0
    for track in mid.tracks:
        t = 0
        for msg in track:
            t += msg.time
            if msg.type == "note_on" and msg.velocity > 0:
                notes.append(Note(t / tpb, msg.note, velocity=msg.velocity / 127))
            if msg.type in ("note_on", "note_off"):
                length = max(length, t / tpb)
    length = max(1.0, math.ceil(length))
    return Score(length, notes, title or (path if isinstance(path, str) else ""))


# ---------------------------------------------------------------------------
# Fitting a loop onto the comb / disc
# ---------------------------------------------------------------------------

def best_transposition(midis: Iterable[int], search=range(-24, 25)) -> tuple[int, int]:
    """Return (semitones, n_unplayable) for the transposition that keeps the
    most notes on the comb, preferring small shifts."""
    midis = list(midis)
    best = None
    for s in sorted(search, key=abs):
        bad = sum(1 for m in midis if m + s not in G.TRACKS_FOR_MIDI)
        if best is None or bad < best[1]:
            best = (s, bad)
        if bad == 0:
            break
    return best


def snap_to_comb(midi: int, prefer_up: bool = True) -> int:
    """Nearest playable pitch (ties resolved by `prefer_up`)."""
    if midi in G.TRACKS_FOR_MIDI:
        return midi
    up = min((m for m in G.PITCH_SET if m > midi), default=None)
    dn = max((m for m in G.PITCH_SET if m < midi), default=None)
    if up is None:
        return dn
    if dn is None:
        return up
    du, dd = up - midi, midi - dn
    if du == dd:
        return up if prefer_up else dn
    return up if du < dd else dn


@dataclass
class AssignReport:
    assigned: int = 0
    dropped: list = field(default_factory=list)   # notes that could not be placed
    snapped: list = field(default_factory=list)   # (orig_midi, new_midi, beat)


def assign_tracks(score: Score, transpose: int = 0, snap: bool = True,
                  min_arc_mm: float = G.MIN_PIN_ARC_MM) -> AssignReport:
    """Give every note a physical track, respecting the minimum pin spacing.

    Where a pitch has two tracks, notes alternate between them so quick
    repeats are possible.  Notes that cannot be placed without violating
    the spacing are dropped (and reported).  Modifies `score` in place;
    the 'notes' list is left sorted by beat.
    """
    rep = AssignReport()
    last_angle: dict[int, float] = {}     # track -> angle of last pin placed
    kept: list[Note] = []
    for n in sorted(score.notes, key=lambda n: (n.beat, n.midi)):
        m = n.midi + transpose
        if m not in G.TRACKS_FOR_MIDI:
            if not snap:
                rep.dropped.append((n.beat, n.midi, "not on comb"))
                continue
            m2 = snap_to_comb(m)
            rep.snapped.append((n.midi, m2 - transpose, n.beat))
            m = m2
        ang = score.beat_to_angle(n.beat)
        placed = False
        # Prefer the track whose last pin is furthest away (wrapping around
        # the disc as well, since the loop repeats).
        candidates = G.TRACKS_FOR_MIDI[m]
        def gap(t):
            if t not in last_angle:
                return 1e9
            r = G.track_radius(t)
            d = (ang - last_angle[t]) % 360.0
            return math.radians(d) * r
        for t in sorted(candidates, key=gap, reverse=True):
            if gap(t) >= min_arc_mm:
                # also check wrap-around against the *first* pin on this track
                n.track = t
                n.midi = m
                last_angle[t] = ang
                kept.append(n)
                placed = True
                break
        if not placed:
            rep.dropped.append((n.beat, n.midi, "too close to previous pin on every track"))
    # wrap-around check: last pin vs first pin on each track
    first: dict[int, Note] = {}
    for n in kept:
        first.setdefault(n.track, n)
    final: list[Note] = []
    for n in kept:
        f = first[n.track]
        if n is not f:
            d = (score.beat_to_angle(f.beat) - score.beat_to_angle(n.beat)) % 360.0
            if math.radians(d) * G.track_radius(n.track) < min_arc_mm:
                rep.dropped.append((n.beat, n.midi, "wraps onto the loop's first pin"))
                continue
        final.append(n)
    score.notes = final
    rep.assigned = len(final)
    return rep


def repeat_to_fill(score: Score, repeats: int) -> Score:
    """Tile the loop `repeats` times around the disc."""
    out = Score(score.length_beats * repeats, [], score.title, score.seconds_per_rev, dict(score.meta))
    for k in range(repeats):
        for n in score.notes:
            out.notes.append(Note(n.beat + k * score.length_beats, n.midi, n.track, n.velocity))
    return out
