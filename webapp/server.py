#!/usr/bin/env python3
"""Fisher-Price Record Studio: local web server for the two browser apps.

    python webapp/server.py scanner     # note scanner  (photo -> notes), opens /scanner
    python webapp/server.py designer    # record designer (loop -> STL), opens /designer
    python webapp/server.py             # both, opens the index page

Everything is computed by the same Python code as the command-line tools,
so what the pages show is exactly what extract_record.py / design_disc.py
produce.
"""
import argparse, base64, json, os, sys, tempfile, threading, traceback, webbrowser
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from fpmb import score as S, mesh, synth, geometry as G          # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PAGES = {"/designer": "designer.html", "/scanner": "scanner.html"}

STATIC = os.path.join(HERE, "static")


def score_from_request(d: dict):
    sc = S.Score.from_dict(d["score"])
    repeats = int(d.get("repeats", 1))
    if repeats > 1:
        sc = S.repeat_to_fill(sc, repeats)
    for n in sc.notes:
        n.track = None
    tr = int(d.get("transpose", 0))
    if d.get("auto_transpose"):
        tr, _ = S.best_transposition(n.midi for n in sc.notes)
    rep = S.assign_tracks(sc, transpose=tr, snap=bool(d.get("snap", True)))
    return sc, rep, tr


def report_dict(rep: S.AssignReport, tr: int) -> dict:
    return {"assigned": rep.assigned, "transpose": tr,
            "dropped": [{"beat": b, "midi": m, "name": G.midi_name(m), "why": w} for b, m, w in rep.dropped],
            "snapped": [{"from": G.midi_name(a), "to": G.midi_name(b), "beat": c} for a, b, c in rep.snapped]}


def geometry_dict() -> dict:
    return {
        "track_midi": G.TRACK_MIDI, "track_radii": G.TRACK_RADII,
        "pitch_set": G.PITCH_SET, "names": {m: G.midi_name(m) for m in G.PITCH_SET},
        "groove_inner_radii": G.GROOVE_INNER_RADII, "groove_width": G.GROOVE_WIDTH,
        "disc_radius": G.DISC_RADIUS, "label_radius": G.LABEL_RADIUS,
        "seconds_per_rev": G.SECONDS_PER_REV, "min_pin_arc_mm": G.MIN_PIN_ARC_MM,
        "head_offset_mm": G.HEAD_OFFSET_MM,
    }


def with_tempfile(data: bytes, suffix: str, fn):
    fd, p = tempfile.mkstemp(suffix=suffix); os.close(fd)
    try:
        with open(p, "wb") as f:
            f.write(data)
        return fn(p)
    finally:
        os.unlink(p)


class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, body: bytes, ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj).encode())

    def _body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", 0)))

    # ------------------------------------------------------------ GET
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                self._send(200, f.read(), "text/html; charset=utf-8")
        elif path.startswith("/static/"):
            name = os.path.basename(path)
            fp = os.path.join(STATIC, name)
            ctype = {"png": "image/png", "jpg": "image/jpeg", "svg": "image/svg+xml", "css": "text/css"}.get(name.rsplit(".", 1)[-1], "application/octet-stream")
            if os.path.isfile(fp):
                with open(fp, "rb") as f:
                    self._send(200, f.read(), ctype)
            else:
                self._send(404, b"not found", "text/plain")
        elif path in PAGES:
            with open(os.path.join(HERE, PAGES[path]), "rb") as f:
                self._send(200, f.read(), "text/html; charset=utf-8")
        elif path == "/api/geometry":
            self._json(geometry_dict())
        elif path.startswith("/sample/"):
            name = os.path.basename(path)
            fp = os.path.join(ROOT, "data", name)
            if os.path.isfile(fp) and name.lower().endswith((".jpg", ".jpeg", ".png")):
                with open(fp, "rb") as f:
                    self._send(200, f.read(), "image/jpeg")
            else:
                self._send(404, b"not found", "text/plain")
        else:
            self._send(404, b"not found", "text/plain")

    # ------------------------------------------------------------ POST
    def do_POST(self):
        try:
            path = self.path.split("?", 1)[0]
            handler = getattr(self, "api_" + path.replace("/api/", "").replace("-", "_"), None)
            if path.startswith("/api/") and handler:
                handler()
            else:
                self._send(404, b"not found", "text/plain")
        except Exception as e:
            traceback.print_exc()
            self._json({"error": str(e)}, 500)

    # --- designer -------------------------------------------------
    def api_assign(self):
        d = json.loads(self._body())
        sc, rep, tr = score_from_request(d)
        self._json({"score": sc.to_dict(), "report": report_dict(rep, tr)})

    def api_stl(self):
        d = json.loads(self._body())
        sc, rep, tr = score_from_request(d)
        opt = mesh.MeshOptions(thickness=float(d.get("thickness", G.DISC_THICKNESS)),
                               bottom_inset=bool(d.get("bottom_inset", False)),
                               label=str(d.get("label", ""))[:14])
        m = mesh.build(sc, opt, ensure_tracks=False)
        data = mesh.to_stl_bytes(m)
        name = (sc.title or "record").replace(" ", "_") + ".stl"
        self._send(200, data, "model/stl", {"Content-Disposition": f'attachment; filename="{name}"',
                                            "X-Report": json.dumps(report_dict(rep, tr))})

    def api_import_midi(self):
        data = self._body()
        sc = with_tempfile(data, ".mid", lambda p: S.load_midi(p, title=self.headers.get("X-Filename", "midi")))
        tr, bad = S.best_transposition(n.midi for n in sc.notes)
        self._json({"score": sc.to_dict(), "suggested_transpose": tr, "unplayable_after": bad})

    def api_import_text(self):
        d = json.loads(self._body())
        sc = S.parse_text(d["text"], float(d.get("beats_per_step", 1.0)), d.get("title", "loop"))
        self._json({"score": sc.to_dict()})

    # --- shared -----------------------------------------------------
    def api_wav(self):
        """Render a score (as sent, tracks optional) to WAV."""
        d = json.loads(self._body())
        if d.get("assign", True):
            sc, rep, tr = score_from_request(d)
        else:
            sc = S.Score.from_dict(d["score"])
        if "seconds_per_rev" in d:
            sc.seconds_per_rev = float(d["seconds_per_rev"])
        fd, p = tempfile.mkstemp(suffix=".wav"); os.close(fd)
        try:
            synth.render_wav(sc, p, loops=int(d.get("loops", 1)))
            with open(p, "rb") as f:
                data = f.read()
        finally:
            os.unlink(p)
        self._send(200, data, "audio/wav")

    def api_midi(self):
        d = json.loads(self._body())
        sc = S.Score.from_dict(d["score"])
        if "seconds_per_rev" in d:
            sc.seconds_per_rev = float(d["seconds_per_rev"])
        fd, p = tempfile.mkstemp(suffix=".mid"); os.close(fd)
        try:
            synth.write_midi(sc, p)
            with open(p, "rb") as f:
                data = f.read()
        finally:
            os.unlink(p)
        self._send(200, data, "audio/midi")

    # --- scanner ----------------------------------------------------
    def api_extract(self):
        """Photo -> score.  Headers: X-Filename, X-Quantise (beats/rev or 0),
        X-Min-Strength, X-Seconds-Per-Rev."""
        from fpmb import extract as X
        import cv2
        data = self._body()
        title = os.path.splitext(self.headers.get("X-Filename", "photo"))[0]
        ms = float(self.headers.get("X-Min-Strength", "0.5"))
        spr = float(self.headers.get("X-Seconds-Per-Rev", G.SECONDS_PER_REV))
        ext = os.path.splitext(self.headers.get("X-Filename", "photo.jpg"))[1] or ".jpg"
        ex = with_tempfile(data, ext, lambda p: X.extract(p, title=title, min_strength=ms, seconds_per_rev=spr))
        q = int(self.headers.get("X-Quantise", "0") or 0)
        sc = X.quantise(ex.score, q) if q else ex.score
        ov = ex.overlay()
        h = ov.shape[0]
        if h > 1400:
            ov = cv2.resize(ov, None, fx=1400 / h, fy=1400 / h, interpolation=cv2.INTER_AREA)
        ok, jpg = cv2.imencode(".jpg", ov, [cv2.IMWRITE_JPEG_QUALITY, 85])
        self._json({"score": sc.to_dict(), "raw_score": ex.score.to_dict(), "warnings": ex.warnings,
                    "n_pins": len(ex.pins), "groove_fit": {k: v for k, v in ex.groove_fit.items() if k != "sector_offsets_mm"},
                    "pins": [{"track": t, "angle": a, "strength": s} for t, a, s in ex.pins],
                    "pin_details": ex.pin_details,
                    "overlay_jpeg_b64": base64.b64encode(jpg.tobytes()).decode(),
                    "overlay_px_per_mm": ex.px_per_mm * (ov.shape[0] / ex.rectified.shape[0])})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("app", nargs="?", choices=["scanner", "designer", "both"], default="both")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8765)))
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), H)
    url = f"http://localhost:{a.port}/" + ("" if a.app == "both" else a.app)
    print("serving", url)
    if not a.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
