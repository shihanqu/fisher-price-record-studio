#!/usr/bin/env python3
"""Compare two extractions of the same record (e.g. two photos) after
finding the rotation that best aligns them.  Prints matched / unmatched pins."""
import sys, json, math, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from fpmb import extract as X, geometry as G

def pins_of(path, thr):
    ex = X.extract(path, min_strength=thr)
    return ex

def main(a, b, thr=0.5, tol_deg=1.5):
    ea, eb = pins_of(a, thr), pins_of(b, thr)
    A = [(t, ang) for t, ang, s in ea.pins]; B = [(t, ang) for t, ang, s in eb.pins]
    best = None
    for rot in np.arange(0, 360, 0.25):
        n = 0
        for t, ang in A:
            for t2, ang2 in B:
                if t == t2 and abs(((ang + rot - ang2 + 180) % 360) - 180) < tol_deg:
                    n += 1; break
        if best is None or n > best[0]:
            best = (n, rot)
    n, rot = best
    print(f"best rotation {rot:.2f} deg: {n} matched of {len(A)} (A) and {len(B)} (B)")
    def visible(ex, ang):
        i = int(round((ang % 360) / X.POLAR_DEG_STEP)) % len(ex.visible_by_angle)
        return ex.visible_by_angle[i] > 0.99
    onlyA, onlyB, hiddenA, hiddenB = [], [], 0, 0
    for t, ang, s in ea.pins:
        if not any(t == t2 and abs(((ang + rot - ang2 + 180) % 360) - 180) < tol_deg for t2, ang2, _ in eb.pins):
            if visible(eb, ang + rot):
                onlyA.append((t, round(ang, 1), round(s, 2)))
            else:
                hiddenA += 1
    for t, ang, s in eb.pins:
        if not any(t == t2 and abs(((ang - rot - ang2 + 180) % 360) - 180) < tol_deg for t2, ang2, _ in ea.pins):
            if visible(ea, ang - rot):
                onlyB.append((t, round(ang, 1), round(s, 2)))
            else:
                hiddenB += 1
    print(f"only in A, visible in B ({len(onlyA)}; {hiddenA} more fall in B's hidden sector):", onlyA)
    print(f"only in B, visible in A ({len(onlyB)}; {hiddenB} more fall in A's hidden sector):", onlyB)
    return ea, eb, rot

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], float(sys.argv[3]) if len(sys.argv) > 3 else 0.5)
