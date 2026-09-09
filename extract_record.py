#!/usr/bin/env python3
"""Read the tune off a photo of a Fisher-Price record.

    python extract_record.py data/edelweiss_record.jpg --title Edelweiss --play

Outputs (next to the image unless --out is given): <name>.json (the score),
<name>.wav, <name>.mid, and, with --debug, a folder of diagnostic images.
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fpmb import extract as X, synth, geometry as G


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image")
    ap.add_argument("--title", default="")
    ap.add_argument("--out", help="output basename (default: image path without extension)")
    ap.add_argument("--debug", action="store_true", help="write diagnostic images to <out>_debug/")
    ap.add_argument("--play", action="store_true", help="play the extracted tune (afplay)")
    ap.add_argument("--loops", type=int, default=1, help="revolutions to render in the WAV")
    ap.add_argument("--seconds-per-rev", type=float, default=G.SECONDS_PER_REV)
    ap.add_argument("--quantise", type=int, default=0, help="snap to N beats per revolution (0 = keep raw angles)")
    ap.add_argument("--min-strength", type=float, default=0.5, help="pin detection threshold (0..1)")
    a = ap.parse_args()

    out = a.out or os.path.splitext(a.image)[0]
    title = a.title or os.path.basename(out)
    ex = X.extract(a.image, title=title, debug_dir=(out + "_debug") if a.debug else None,
                   min_strength=a.min_strength, seconds_per_rev=a.seconds_per_rev)
    sc = ex.score
    if a.quantise:
        sc = X.quantise(sc, a.quantise)
    for w in ex.warnings:
        print("warning:", w)
    print(f"groove fit: offset {ex.groove_fit['global_offset_mm']:+.2f} mm, scale {ex.groove_fit['scale']:.3f}, "
          f"walls {'brighter' if ex.groove_fit['walls_brighter'] else 'darker'} than floors")
    print(f"{len(ex.pins)} pins found")
    print(sc.describe())
    sc.save(out + ".json")
    synth.render_wav(sc, out + ".wav", loops=a.loops)
    synth.write_midi(sc, out + ".mid")
    print(f"wrote {out}.json, {out}.wav, {out}.mid")
    if a.play:
        synth.play_file(out + ".wav")


if __name__ == "__main__":
    main()
