#!/usr/bin/env python3
"""Refresh the home-page screenshots (docs/img/*.png) with headless Chrome.

    .venv/bin/python tools/shots.py [--width 1440 --height 900] [--only scanner|designer]

Serves docs/ on a free local port and opens each app with ?demo: the scanner
reads the bundled sample photo and the designer builds its 3D preview. When
the page sets window.__demoDone the screenshot is taken. Needs Google Chrome
and `pip install websocket-client`.
"""
import argparse, base64, contextlib, json, os, socket, subprocess, sys, tempfile, time, urllib.request
import websocket

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")


def free_port():
    with contextlib.closing(socket.socket()) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for(url, seconds=10):
    for _ in range(int(seconds / 0.2)):
        try:
            return urllib.request.urlopen(url, timeout=1).read()
        except Exception:
            time.sleep(0.2)
    raise RuntimeError(f"{url} did not come up")


def cdp(ws, _id, method, params=None):
    ws.send(json.dumps({"id": _id, "method": method, "params": params or {}}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == _id:
            return m.get("result", {})


def shoot(url, out, w, h):
    port = free_port()
    proc = subprocess.Popen([CHROME, "--headless=new", "--hide-scrollbars", f"--window-size={w},{h}",
                             "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
                             f"--remote-debugging-port={port}", f"--user-data-dir={tempfile.mkdtemp(prefix='fpmb-chrome-')}", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        tabs = json.loads(wait_for(f"http://127.0.0.1:{port}/json"))
        page = next(t for t in tabs if t.get("type") == "page")
        ws = websocket.create_connection(page["webSocketDebuggerUrl"], suppress_origin=True, timeout=120)
        i = iter(range(1, 10 ** 6))
        cdp(ws, next(i), "Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": False})
        cdp(ws, next(i), "Page.enable")
        cdp(ws, next(i), "Page.navigate", {"url": url})
        for _ in range(240):
            r = cdp(ws, next(i), "Runtime.evaluate", {"expression": "!!window.__demoDone", "returnByValue": True})
            if r.get("result", {}).get("value"):
                break
            time.sleep(0.25)
        else:
            print(f"warning: {url} never signalled __demoDone; capturing anyway", file=sys.stderr)
        time.sleep(0.5)
        r = cdp(ws, next(i), "Page.captureScreenshot", {"format": "png"})
        with open(out, "wb") as f:
            f.write(base64.b64decode(r["data"]))
        ws.close()
    finally:
        proc.kill()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument("--only", choices=["scanner", "designer"])
    a = ap.parse_args()
    port = free_port()
    server = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1", "-d", DOCS],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_for(f"http://127.0.0.1:{port}/index.html")
        os.makedirs(os.path.join(DOCS, "img"), exist_ok=True)
        for app in ("scanner", "designer"):
            if a.only and app != a.only:
                continue
            out = os.path.join(DOCS, "img", f"{app}.png")
            shoot(f"http://127.0.0.1:{port}/{app}.html?demo", out, a.width, a.height)
            print("wrote", os.path.relpath(out, ROOT), os.path.getsize(out) // 1024, "KB", flush=True)
    finally:
        server.kill()


if __name__ == "__main__":
    main()
