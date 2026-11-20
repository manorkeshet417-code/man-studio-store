"""Man Studio Store — desktop app.

Opens the live store in its own window (Windows' built-in Edge WebView2),
so the app always shows the newest version of the store. Sign-ins are
remembered between launches.

Auto-update: on start the app reads downloads/app.json from the site. If it
lists a newer APP_VERSION, the app asks, downloads the new EXE, swaps itself
with a tiny helper script after it closes, and starts the new version.
"""
import json
import os
import subprocess
import sys
import tempfile
import urllib.request

import webview

APP_VERSION = "1.2.0"   # bump this before every build that should reach users
STORE_URL = "https://manorkeshet417-code.github.io/man-studio-store/"
UPDATE_INFO = STORE_URL + "downloads/app.json"
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


def vtuple(v: str):
    try:
        return tuple(int(x) for x in str(v).strip().split("."))
    except ValueError:
        return (0,)


class Api:
    """Functions the offline page can call. Keep the window in a _private field:
    pywebview walks every public attribute of js_api, and walking the whole
    Window object froze the UI thread ("Not responding")."""

    def __init__(self):
        self._window = None

    def retry(self):
        if online():
            self._window.load_url(STORE_URL)


def resource(name: str) -> str:
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, name)


def toast(w, text: str):
    """Show a message with the store's own toast (if the page is loaded)."""
    try:
        w.evaluate_js("typeof toast==='function'&&toast(%s)" % json.dumps(text))
    except Exception:
        pass


def check_update(w):
    """Runs off the UI thread. Only the built EXE updates itself."""
    if not getattr(sys, "frozen", False):
        return
    try:
        with urllib.request.urlopen(UPDATE_INFO + "?t=" + str(os.getpid()), timeout=10) as r:
            info = json.loads(r.read().decode("utf-8"))
    except Exception:
        return
    latest = str(info.get("version", ""))
    if vtuple(latest) <= vtuple(APP_VERSION):
        return
    notes = str(info.get("notes", ""))[:300]
    msg = (f"A new version is available: {latest} (you have {APP_VERSION}).\n{notes}\n\nUpdate now?\n"
           f"גרסה חדשה זמינה — לעדכן עכשיו?")
    if not w.create_confirmation_dialog("Man Studio Store — Update", msg):
        return
    toast(w, "⬇ Downloading update " + latest + "…")
    url = info.get("url") or "downloads/ManStudioStore.exe"
    if not url.startswith("https://"):
        url = STORE_URL + url.lstrip("/")
    new_exe = os.path.join(tempfile.gettempdir(), "ManStudioStore_update.exe")
    try:
        urllib.request.urlretrieve(url + "?v=" + latest, new_exe)
        if os.path.getsize(new_exe) < 1_000_000:   # not a real EXE (error page etc.)
            raise ValueError("download too small")
    except Exception:
        toast(w, "Update failed — try again later")
        return
    me = sys.executable
    bat = os.path.join(tempfile.gettempdir(), "ManStudioStore_update.bat")
    # wait for this app to close, swap the EXE (retry while the file is still locked), start the new one
    with open(bat, "w", encoding="ascii", errors="ignore") as f:
        f.write(
            "@echo off\r\n"
            f":wait\r\ntasklist /FI \"PID eq {os.getpid()}\" | find \"{os.getpid()}\" >nul && (ping -n 2 127.0.0.1 >nul & goto wait)\r\n"
            "set n=0\r\n"
            f":copy\r\nmove /y \"{new_exe}\" \"{me}\" >nul 2>&1 && goto run\r\n"
            "set /a n+=1\r\nif %n% geq 20 goto run\r\nping -n 2 127.0.0.1 >nul\r\ngoto copy\r\n"
            f":run\r\nstart \"\" \"{me}\"\r\n"
            "del \"%~f0\"\r\n")
    subprocess.Popen(["cmd", "/c", bat], creationflags=0x08000000 | 0x00000200, close_fds=True)  # no window, own process group
    w.destroy()


def main():
    api = Api()
    webview.settings["ALLOW_DOWNLOADS"] = True               # EXE/ZIP games can be downloaded
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True  # share links, itch.io etc.
    # open the store right away; network checks run off the UI thread
    window = webview.create_window(f"{TITLE}", STORE_URL, js_api=api, width=1280, height=800,
                                   min_size=(420, 600), background_color="#1b2838")
    api._window = window

    def background(w):
        if not online():
            w.load_html(OFFLINE_HTML)
            return
        check_update(w)

    icon = resource("store.ico")
    webview.start(background, window, private_mode=False, storage_path=data_dir(),
                  icon=icon if os.path.exists(icon) else None)


if __name__ == "__main__":
    main()
