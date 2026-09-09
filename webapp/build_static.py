#!/usr/bin/env python3
"""Build the static GitHub Pages demo into docs/.

    python webapp/build_static.py

The demo is the same two pages with static-api.js answering the API calls
from pre-computed files: geometry, the sample photo's scan, and the STL of
the designer's starter loop.  Photo scanning, STL export for other loops and
MIDI/WAV downloads are refused with a message pointing at the local server.
"""
import base64, json, os, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from fpmb import extract as X, geometry as G, mesh, score as S     # noqa: E402
from webapp.server import geometry_dict                            # noqa: E402

HERE = os.path.join(ROOT, "webapp")
DOCS = os.path.join(ROOT, "docs")
STARTER_TEXT = "C5 Eb5 G5 C6 . G5 Eb5 C5 | Ab4 C5 Eb5 Ab5 . Eb5 C5 Ab4"

REWRITES = [
    ('href="/"', 'href="./index.html"'),
    ('href="/scanner"', 'href="./scanner.html"'),
    ('href="/designer"', 'href="./designer.html"'),
    ("window.open('/designer', '_blank')", "window.open('./designer.html', '_blank')"),
    ('src="/static/', 'src="./static/'),
]


def page(name):
    s = open(os.path.join(HERE, name)).read()
    for a, b in REWRITES:
        s = s.replace(a, b)
    s = s.replace('<script type="module">', '<script src="./static-api.js"></script>\n<script type="module">', 1)
    return s


def main():
    os.makedirs(os.path.join(DOCS, "static"), exist_ok=True)
    # pages
    for name in ("scanner.html", "designer.html"):
        open(os.path.join(DOCS, name), "w").write(page(name))
    idx = open(os.path.join(HERE, "index.html")).read()
    for a, b in REWRITES:
        idx = idx.replace(a, b)
    idx = idx.replace('<title>Fisher-Price Record Studio</title>', '<title>Fisher-Price Record Studio (static demo)</title>')
    idx = idx.replace('<div class="wrap">', '''<div class="topbar"><b>Static demo.</b> This site has no server behind it: it shows the sample scan and lets you try the designer, but scanning your own photo and exporting STL need the studio running locally. Clone <a href="https://github.com/shihanqu/fisher-price-record-studio">the repo</a> and run <code>python webapp/server.py</code>.</div>
<div class="wrap">''', 1)
    idx = idx.replace('<h1>Fisher-Price Record Studio</h1>', '<h1>Fisher-Price Record Studio <span class="badge">Static demo</span></h1>', 1)
    idx = idx.replace('</style>', '''  .topbar { background:#fff3d6; color:#6b4b00; border-bottom:1px solid #f0d9a0; padding:10px 24px; font-size:14px; text-align:center; }
  .topbar a { color:#1d6fb8; } .topbar code { background:#fbe7b8; padding:1px 5px; border-radius:4px; }
  .badge { display:inline-block; vertical-align:middle; background:#f28c28; color:#fff; font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; padding:4px 10px; border-radius:999px; margin-left:10px; }
</style>''', 1)
    open(os.path.join(DOCS, "index.html"), "w").write(idx)
    shutil.copy(os.path.join(HERE, "static-api.js"), os.path.join(DOCS, "static-api.js"))
    for shot in ("scanner.png", "designer.png"):
        shutil.copy(os.path.join(HERE, "static", shot), os.path.join(DOCS, "static", shot))
    open(os.path.join(DOCS, ".nojekyll"), "w").close()

    # data: geometry
    json.dump(geometry_dict(), open(os.path.join(DOCS, "static", "geometry.json"), "w"))

    # data: sample scan (same shape as /api/extract)
    import cv2
    ex = X.extract(os.path.join(ROOT, "data", "edelweiss_record.jpg"), title="edelweiss_record")
    ov = ex.overlay(); h = ov.shape[0]
    if h > 1400:
        ov = cv2.resize(ov, None, fx=1400 / h, fy=1400 / h, interpolation=cv2.INTER_AREA)
    ok, jpg = cv2.imencode(".jpg", ov, [cv2.IMWRITE_JPEG_QUALITY, 82])
    json.dump({"score": ex.score.to_dict(), "raw_score": ex.score.to_dict(), "warnings": ex.warnings,
               "n_pins": len(ex.pins), "groove_fit": {k: v for k, v in ex.groove_fit.items() if k != "sector_offsets_mm"},
               "pins": [{"track": t, "angle": a, "strength": s} for t, a, s in ex.pins],
               "pin_details": ex.pin_details,
               "overlay_jpeg_b64": base64.b64encode(jpg.tobytes()).decode(),
               "overlay_px_per_mm": ex.px_per_mm * (ov.shape[0] / ex.rectified.shape[0])},
              open(os.path.join(DOCS, "static", "sample_extract.json"), "w"))

    # data: starter loop STL
    sc = S.parse_text(STARTER_TEXT, 0.5, "MY TUNE")     # designer default: 2 steps per beat
    json.dump(sc.to_dict(), open(os.path.join(DOCS, "static", "starter_score.json"), "w"))
    S.assign_tracks(sc)
    mesh.to_stl(mesh.build(sc, mesh.MeshOptions(label="MY TUNE"), ensure_tracks=False), os.path.join(DOCS, "static", "starter.stl"))
    for f in sorted(os.listdir(os.path.join(DOCS, "static"))):
        print(f"{os.path.getsize(os.path.join(DOCS, 'static', f)) // 1024:6d} KB  static/{f}")
    print("docs/ built")


if __name__ == "__main__":
    main()
