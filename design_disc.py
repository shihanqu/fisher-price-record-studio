#!/usr/bin/env python3
"""Design a printable Fisher-Price record from a short loop of music.

Input can be a MIDI file, a score .json (as written by extract_record.py or
the designer), a .txt in the tiny text notation, or --text "...":

    python design_disc.py song.mid --repeats 2 --label "MY SONG" --out output/my_song.stl
    python design_disc.py --text "C5 Eb5 G5 C6 . G5 Eb5 C5" --repeats 6 --out output/arp.stl

Text notation: one token per step, '.' is a rest, 'C5+Eb5' plays a chord,
'|' is ignored.  Notes off the comb are snapped to the nearest playable
pitch unless --no-snap; --auto-transpose picks the shift that keeps the
most notes playable.

Outputs: <out>.stl, <out>.json (the score with physical tracks assigned),
and <out>.wav (a preview of one revolution).
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fpmb import score as S, mesh, synth, geometry as G


def load_input(a) -> S.Score:
    if a.text:
        return S.parse_text(a.text, title=a.title or "loop")
    p = a.input
    if p is None:
        sys.exit("give an input file or --text")
    ext = os.path.splitext(p)[1].lower()
    if ext == ".json":
        return S.Score.load(p)
    if ext in (".mid", ".midi"):
        return S.load_midi(p, title=a.title or os.path.splitext(os.path.basename(p))[0])
    with open(p) as f:
        return S.parse_text(f.read(), title=a.title or os.path.splitext(os.path.basename(p))[0])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", nargs="?", help=".mid / .json / .txt")
    ap.add_argument("--text", help="inline text notation")
    ap.add_argument("--title", default="")
    ap.add_argument("--out", help="output basename (default: output/<title>)")
    ap.add_argument("--repeats", type=int, default=1, help="tile the loop this many times around the disc")
    ap.add_argument("--transpose", type=int, default=0, help="semitones")
    ap.add_argument("--auto-transpose", action="store_true", help="choose the transposition with the fewest unplayable notes")
    ap.add_argument("--no-snap", action="store_true", help="drop notes that are not on the comb instead of snapping")
    ap.add_argument("--label", default=None, help="text embossed on the centre label (default: title)")
    ap.add_argument("--thickness", type=float, default=G.DISC_THICKNESS)
    ap.add_argument("--bottom-inset", action="store_true", help="also recess the label area on the underside (needs support)")
    ap.add_argument("--seconds-per-rev", type=float, default=G.SECONDS_PER_REV, help="for the WAV preview only")
    ap.add_argument("--play", action="store_true")
    a = ap.parse_args()

    sc = load_input(a)
    sc.seconds_per_rev = a.seconds_per_rev
    if a.repeats > 1:
        sc = S.repeat_to_fill(sc, a.repeats)
    for n in sc.notes:
        n.track = None                         # always re-assign for the new geometry
    tr = a.transpose
    if a.auto_transpose:
        tr, bad = S.best_transposition(n.midi for n in sc.notes)
        print(f"auto-transpose: {tr:+d} semitones ({bad} notes still off the comb)")
    rep = S.assign_tracks(sc, transpose=tr, snap=not a.no_snap)
    print(f"{rep.assigned} pins placed")
    for om, nm, b in rep.snapped:
        print(f"  snapped {G.midi_name(om)} -> {G.midi_name(nm)} at beat {b:g}")
    for b, m, why in rep.dropped:
        print(f"  DROPPED {G.midi_name(m)} at beat {b:g}: {why}")
    for b, count in S.crowded_moments(sc):
        print(f"  WARNING {count} notes at once at beat {b:g}: the motor can only pluck 3 together")

    out = a.out or os.path.join("output", (sc.title or "record").replace(" ", "_"))
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    opt = mesh.MeshOptions(thickness=a.thickness, bottom_inset=a.bottom_inset,
                           label=(a.label if a.label is not None else sc.title)[:14])
    m = mesh.build(sc, opt)
    stats = mesh.to_stl(m, out + ".stl")
    sc.save(out + ".json")
    synth.render_wav(sc, out + ".wav")
    print(f"wrote {out}.stl ({stats['triangles']} triangles, {stats['volume_mm3'] / 1000:.1f} cm^3), {out}.json, {out}.wav")
    print(sc.describe() if len(sc.notes) <= 40 else f"{len(sc.notes)} notes over {sc.length_beats:g} beats")
    if a.play:
        synth.play_file(out + ".wav")


if __name__ == "__main__":
    main()
