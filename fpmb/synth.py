"""Turn a Score into sound: a WAV file (plucked-comb synthesis) or a MIDI file."""
from __future__ import annotations

import math
import numpy as np

from . import geometry as G
from .score import Score


def _pluck(freq: float, sr: int, dur: float, amp: float = 0.3) -> np.ndarray:
    """A music-box-like tine: a few decaying inharmonic partials plus a click."""
    n = int(sr * dur)
    t = np.arange(n) / sr
    # Cantilever-beam partials are stretched: f, 6.27f, 17.55f ...; keep two.
    out = np.zeros(n)
    for k, (ratio, gain, decay) in enumerate([(1.0, 1.0, 1.6), (6.27, 0.12, 8.0), (17.55, 0.03, 20.0)]):
        f = freq * ratio
        if f > sr / 2 * 0.9:
            continue
        out += gain * np.sin(2 * math.pi * f * t) * np.exp(-decay * t)
    # attack click
    click = np.exp(-t * 400) * np.random.default_rng(int(freq)).standard_normal(n) * 0.05
    env = 1 - np.exp(-t * 3000)
    return amp * (out + click) * env


def render_wav(score: Score, path, sr: int = 44100, loops: int = 1, tail: float = 2.0,
               seconds_per_rev: float | None = None) -> np.ndarray:
    """Render `loops` revolutions of the score to a 16-bit mono WAV."""
    spr = seconds_per_rev or score.seconds_per_rev
    total = spr * loops + tail
    buf = np.zeros(int(sr * total) + 1)
    cache: dict[int, np.ndarray] = {}
    for k in range(loops):
        for n in score.notes:
            t0 = k * spr + score.beat_to_seconds(n.beat)
            i0 = int(t0 * sr)
            if n.midi not in cache:
                cache[n.midi] = _pluck(G.midi_freq(n.midi), sr, 2.5)
            s = cache[n.midi] * n.velocity
            i1 = min(len(buf), i0 + len(s))
            buf[i0:i1] += s[: i1 - i0]
    peak = np.abs(buf).max() or 1.0
    buf = buf / peak * 0.9
    import scipy.io.wavfile as wf
    wf.write(path, sr, (buf * 32767).astype(np.int16))
    return buf


def write_midi(score: Score, path, seconds_per_rev: float | None = None, program: int = 10) -> None:
    """Write a type-0 MIDI file (program 10 = music box)."""
    import mido
    spr = seconds_per_rev or score.seconds_per_rev
    tpb = 480
    mid = mido.MidiFile(type=0, ticks_per_beat=tpb)
    tr = mido.MidiTrack(); mid.tracks.append(tr)
    # one MIDI quarter note == one score beat
    sec_per_beat = spr / score.length_beats
    tr.append(mido.MetaMessage("set_tempo", tempo=int(sec_per_beat * 1_000_000), time=0))
    tr.append(mido.Message("program_change", program=program, time=0))
    events = []
    for n in score.notes:
        on = int(round(n.beat * tpb))
        events.append((on, "note_on", n.midi, int(max(1, min(127, n.velocity * 110)))))
        events.append((on + int(0.6 * tpb), "note_off", n.midi, 0))
    events.sort(key=lambda e: (e[0], e[1] == "note_on"))
    t = 0
    for tick, kind, note, vel in events:
        tr.append(mido.Message(kind, note=note, velocity=vel, time=tick - t))
        t = tick
    mid.save(path)


def play_file(path) -> None:
    """Play a WAV using the OS player (afplay on macOS, aplay/ffplay elsewhere)."""
    import shutil, subprocess
    for cmd in (["afplay", str(path)], ["aplay", str(path)], ["ffplay", "-nodisp", "-autoexit", str(path)]):
        if shutil.which(cmd[0]):
            subprocess.run(cmd, check=False)
            return
    raise RuntimeError("no audio player found (afplay/aplay/ffplay)")
