"""Drives a real fullscreen Claude Code session with the pr-cards mod, then checks the hover card and the click panel.

Run from the repo root, with the folder of a GitHub repo that has PR 1306 and issue 1250 (fiskaltrust/market-it):
    uv run --no-project --with pywinpty --with pyte python -I scripts/e2e.py C:/code/market-it
Each screen is saved as text in scripts/e2e-out/. Exit code 0 means the card and the panel both appeared.
"""
import os, sys, threading, time
import pyte
from winpty import PtyProcess

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CWD = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
OUT = os.path.join(PLUGIN, "scripts", "e2e-out")
ROWS, COLS = 50, 170
# Nine lines first, so the card that opens upward has room above the reference.
PROMPT = ("Reply with exactly this and use no tools: nine short paragraphs 'Line 1.' to 'Line 9.', each on its own line, "
          "then the sentence 'PR #1306 fixed the issue #1250.' "
          "then a markdown table with columns '#' and 'Title' and two rows: 1318 'ci: submodule' and 1315 'feat: update (#1248)'.")

os.makedirs(OUT, exist_ok=True)
screen = pyte.Screen(COLS, ROWS)
stream = pyte.ByteStream(screen)
lock = threading.Lock()

# Fullscreen rendering turns on mouse reporting; WT_SESSION makes links draw as they do in Windows Terminal.
env = dict(os.environ, CLAUDE_CODE_NO_FLICKER="1", WT_SESSION="e2e", TERM_PROGRAM="WindowsTerminal")
proc = PtyProcess.spawn(["claude", "--plugin-dir", PLUGIN, "--model", "haiku"], cwd=CWD, dimensions=(ROWS, COLS), env=env)


def reader():
    while proc.isalive():
        try:
            data = proc.read(65536)
        except EOFError:
            break
        with lock:
            stream.feed(data.encode("utf-8", "surrogatepass") if isinstance(data, str) else data)


threading.Thread(target=reader, daemon=True).start()


def text():
    with lock:
        return "\n".join(screen.display)


def dump(name):
    with open(os.path.join(OUT, name + ".txt"), "w", encoding="utf-8") as f:
        f.write(text())


def wait(pred, timeout, label):
    end = time.time() + timeout
    while time.time() < end:
        if pred(text()):
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


hovered = clicked = False
try:
    if not wait(lambda t: "❯" in t, 60, "start"):
        sys.exit(1)
    time.sleep(3)
    if "trust" in text().lower():
        proc.write("\r")
        time.sleep(3)
    proc.write(PROMPT)
    time.sleep(1)
    proc.write("\r")
    wait(lambda t: "1315" in t and "PR" in t and "⬤" in t, 120, "reply")
    time.sleep(8)  # the gh lookup and the redraw
    dump("1-reply")
    pos = find("⬤ #1306")
    print("reference at", pos)
    if not pos:
        sys.exit(2)
    x, y = pos[0] + 3, pos[1]  # on the number, past the dot
    proc.write(f"\x1b[<35;{x};{y}M")  # SGR mouse: the pointer moves onto the number
    time.sleep(2)
    dump("2-hover")
    hovered = "#1306" in text() and "checks" in text()
    print("hover card:", hovered)
    # Every cell inside the card's border has a background, so nothing under it shows through.
    with lock:
        lines = screen.display
        top = next(i for i, l in enumerate(lines) if "╭" in l)
        bottom = next(i for i, l in enumerate(lines) if "╰" in l and i > top)
        left, right = lines[top].index("╭"), lines[top].index("╮")
        holes = [(r, c) for r in range(top + 1, bottom) for c in range(left + 1, right) if screen.buffer[r][c].bg == "default"]
    print("card cells without background:", len(holes), holes[:5])
    hovered = hovered and not holes
    proc.write(f"\x1b[<35;{x};{min(ROWS, y + 3)}M")  # the pointer leaves
    time.sleep(1)
    proc.write(f"\x1b[<0;{x};{y}M\x1b[<0;{x};{y}m")  # a plain click
    time.sleep(2)
    dump("3-click")
    clicked = "CHECKS" in text() and "FILES" in text()
    print("panel:", clicked)
finally:
    proc.write("\x03")
    time.sleep(0.5)
    proc.write("\x03")
    time.sleep(1)
    if proc.isalive():
        proc.terminate(force=True)
sys.exit(0 if hovered and clicked else 3)
