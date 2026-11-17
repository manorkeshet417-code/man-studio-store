"""Man Studio Store — desktop app.

Opens the live store in its own window (Windows' built-in Edge WebView2),
so the app always shows the newest version of the store. Sign-ins are
remembered between launches.
"""
import os
import sys
import urllib.request

import webview

STORE_URL = "https://manorkeshet417-code.github.io/man-studio-store/"
TITLE = "Man Studio Store"

OFFLINE_HTML = """<!doctype html><html><head><meta charset="utf-8">
<style>
body{margin:0;height:100vh;display:grid;place-items:center;background:#1b2838;color:#e6edf3;
font-family:Segoe UI,system-ui,sans-serif;text-align:center}
b{display:block;font-size:26px;margin-bottom:8px}
button{margin-top:18px;padding:10px 26px;border:0;border-radius:4px;font-size:15px;color:#fff;
background:linear-gradient(90deg,#47bfff,#1a44c2);cursor:pointer}
</style></head><body><div><b>&#9654; Man Studio Store</b>
No internet connection — the store needs to be online.<br>
&#1488;&#1497;&#1503; &#1495;&#1497;&#1489;&#1493;&#1512; &#1500;&#1488;&#1497;&#1504;&#1496;&#1512;&#1504;&#1496;
<br><button onclick="pywebview.api.retry()">Try again / &#1504;&#1505;&#1492; &#1513;&#1493;&#1489;</button></div></body></html>"""


def data_dir() -> str:
    """Where the app keeps the sign-in session (survives updates of the EXE)."""
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    path = os.path.join(base, "ManStudioStore")
    os.makedirs(path, exist_ok=True)
    return path


def online() -> bool:
    try:
        urllib.request.urlopen(STORE_URL, timeout=6)
        return True
    except Exception:
        return False


class Api:
    def __init__(self):
        self.window = None

    def retry(self):
        if online():
            self.window.load_url(STORE_URL)


def resource(name: str) -> str:
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, name)


def main():
    api = Api()
    webview.settings["ALLOW_DOWNLOADS"] = True               # EXE/ZIP games can be downloaded
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True  # share links, itch.io etc.
    if online():
        window = webview.create_window(TITLE, STORE_URL, js_api=api, width=1280, height=800,
                                       min_size=(420, 600), background_color="#1b2838")
    else:
        window = webview.create_window(TITLE, html=OFFLINE_HTML, js_api=api, width=1280, height=800,
                                       min_size=(420, 600), background_color="#1b2838")
    api.window = window
    icon = resource("store.ico")
    webview.start(private_mode=False, storage_path=data_dir(),
                  icon=icon if os.path.exists(icon) else None)


if __name__ == "__main__":
    main()
