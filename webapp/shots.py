#!/usr/bin/env python3
"""Refresh the home-page screenshots (webapp/static/*.png) using headless Chrome.

    python webapp/shots.py [--url http://localhost:8765] [--width 1440 --height 900]

Each app is opened with ?demo, which makes it scan the sample photo / build
the 3D preview and then set window.__demoDone; the shot is taken after that.
"""
import argparse, base64, json, os, subprocess, sys, tempfile, time, urllib.request
import websocket   # websocket-client

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
HERE = os.path.dirname(os.path.abspath(__file__))


def cdp(ws, _id, method, params=None):
    ws.send(json.dumps({"id": _id, "method": method, "params": params or {}}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == _id:
            return m.get("result", {})


def shoot(base, app, out, w, h, port=9333):
    prof = tempfile.mkdtemp(prefix="fpmb-chrome-")
    proc = subprocess.Popen([CHROME, "--headless=new", "--hide-scrollbars", f"--window-size={w},{h}",
                             "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
                             f"--remote-debugging-port={port}", f"--user-data-dir={prof}", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json"))
                break
            except Exception:
                time.sleep(0.2)
        else:
            raise RuntimeError("chrome did not start")
        page = next(t for t in tabs if t.get("type") == "page")
        ws = websocket.create_connection(page["webSocketDebuggerUrl"], suppress_origin=True, timeout=120)
        i = 1
        cdp(ws, i, "Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": False}); i += 1
        cdp(ws, i, "Page.enable"); i += 1
        cdp(ws, i, "Page.navigate", {"url": f"{base}/{app}?demo"}); i += 1
        for _ in range(120):
            r = cdp(ws, i, "Runtime.evaluate", {"expression": "!!window.__demoDone", "returnByValue": True}); i += 1
            if r.get("result", {}).get("value"):
                break
            time.sleep(0.5)
        else:
            print(f"warning: {app} never signalled __demoDone; capturing anyway", file=sys.stderr)
        time.sleep(0.5)
        r = cdp(ws, i, "Page.captureScreenshot", {"format": "png"}); i += 1
        with open(out, "wb") as f:
            f.write(base64.b64decode(r["data"]))
        ws.close()
    finally:
        proc.kill()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8765")
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument("--only", choices=["scanner", "designer"])
    a = ap.parse_args()
    os.makedirs(os.path.join(HERE, "static"), exist_ok=True)
    for app in ("scanner", "designer"):
        if a.only and app != a.only:
            continue
        out = os.path.join(HERE, "static", f"{app}.png")
        shoot(a.url, app, out, a.width, a.height)
        print("wrote", out, os.path.getsize(out) // 1024, "KB", flush=True)


if __name__ == "__main__":
    main()
