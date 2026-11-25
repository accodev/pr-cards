"""Drives a real Pi session with only the pullywog extension, then checks the band, the keys, the dots,
the hover card and the click that tracks a reference.

Run from the repo root, with the folder of a GitHub repo that has PR 1306 and issue 1250 (fiskaltrust/market-it):
    uv run --no-project --with pywinpty --with pyte python -I scripts/pi-e2e.py C:/code/market-it
It tracks PR 1306 and issue 1250 and removes them again; it presses no action key that reaches GitHub.
Each screen is saved as text in scripts/e2e-out/. Exit code 0 means every check passed.
"""
import os, sys, threading, time
import pyte
from winpty import PtyProcess

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CWD = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
OUT = os.path.join(PLUGIN, "scripts", "e2e-out")
ROWS, COLS = 45, 140

os.makedirs(OUT, exist_ok=True)
sys.stdout.reconfigure(encoding="utf-8")
screen = pyte.Screen(COLS, ROWS)
stream = pyte.ByteStream(screen)
lock = threading.Lock()
cmd = ["pi", "-ne", "-e", os.path.join(PLUGIN, "pi", "index.ts"), "--no-session"]
proc = PtyProcess.spawn(cmd, cwd=CWD, dimensions=(ROWS, COLS))


def reader():
    while proc.isalive():
        try:
            data = proc.read(65536)
        except EOFError:
            break
        b = data.encode("utf-8", "surrogatepass") if isinstance(data, str) else data
        with lock:
            stream.feed(b)


threading.Thread(target=reader, daemon=True).start()


def text():
    with lock:
        return "\n".join(screen.display)


def dump(name):
    with open(os.path.join(OUT, "pi-" + name + ".txt"), "w", encoding="utf-8") as f:
        f.write(text())


def wait(pred, timeout, label):
    end = time.time() + timeout
    while time.time() < end:
        if pred(text()):
            dump(label)
            return True
        time.sleep(0.5)
    dump("fail-" + label)
    print("TIMEOUT", label)
    return False


def find(s):
    for y, line in enumerate(text().split("\n")):
        x = line.find(s)
        if x >= 0:
            return x + 1, y + 1
    return None


def send(s):
    for ch in s:
        proc.write(ch)
        time.sleep(0.02)


checks = {}
try:
    time.sleep(8)
    send("/track #1306")
    time.sleep(0.5)
    proc.write("\r")
    checks["band"] = wait(lambda t: "Tracked PRs" in t and "#1306" in t, 40, "band")
    # The chip loads its title from GitHub: more than the number shows.
    checks["chip loaded"] = wait(lambda t: any("#1306 " in l and "○" not in l and ("waiting" in l or "needs you" in l or "done" in l) for l in t.split("\n")), 40, "chip")
    proc.write("\x1ba")  # Alt+A
    checks["keys"] = wait(lambda t: "x remove" in t and "esc back" in t, 15, "keys")
    proc.write("\x1b")
    time.sleep(1.5)
    checks["back"] = wait(lambda t: "x remove" not in t and "Tracked PRs" in t, 15, "back")
    send("Reply with exactly this sentence and use no tools: PR #1306 fixed issue #1250.")
    proc.write("\r")
    checks["dots"] = wait(lambda t: any("⬤ #1306" in l and "⬤ #1250" in l for l in t.split("\n")), 120, "dots")
    # The pointer rests on #1250 in the reply: its card opens with the repo and the issue's URL.
    at = find("⬤ #1250")
    if at:
        x, y = at[0] + 3, at[1]
        proc.write(f"\x1b[<35;{x};{y}M")
        checks["hover card"] = wait(lambda t: "github.com/fiskaltrust/market-it/issues/1250" in t, 20, "hover")
        proc.write(f"\x1b[<35;{x};{max(1, y - 30)}M")
        checks["card closes"] = wait(lambda t: "github.com/fiskaltrust/market-it/issues/1250" not in t, 10, "unhover")
        # A plain click on the reference tracks it.
        proc.write(f"\x1b[<0;{x};{y}M")
        proc.write(f"\x1b[<0;{x};{y}m")
        checks["click tracks"] = wait(lambda t: any("#1250 " in l and ("waiting" in l or "done" in l or "needs you" in l or l.startswith(" " * 16)) for l in t.split("\n")), 20, "click")
        send("/untrack #1250")
        time.sleep(0.5)
        proc.write("\r")
        time.sleep(0.5)
        proc.write("\r")
        time.sleep(1)
    else:
        checks["hover card"] = False
    send("/untrack #1306")
    time.sleep(0.5)
    # The first Enter takes the completion menu's entry, the second runs the command.
    proc.write("\r")
    time.sleep(0.5)
    proc.write("\r")
    checks["untracked"] = wait(lambda t: "Tracked PRs" not in t, 20, "untracked")
finally:
    proc.terminate(force=True)

for name, ok in checks.items():
    print(("PASS " if ok else "FAIL ") + name)
sys.exit(0 if checks and all(checks.values()) else 1)
