"""Drives a real fullscreen Claude Code session with the pr-cards mod, then checks the hover card and the click panel.

Run from the repo root, with the folder of a GitHub repo that has PR 1306 and issue 1250 (fiskaltrust/market-it):
    uv run --no-project --with pywinpty --with pyte python -I scripts/e2e.py C:/code/market-it
Each screen is saved as text in scripts/e2e-out/. Exit code 0 means the card and the panel both appeared.
"""
import os, re, sys, threading, time
import pyte
from winpty import PtyProcess

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CWD = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
OUT = os.path.join(PLUGIN, "scripts", "e2e-out")
ROWS, COLS = 50, 170
# Nine lines first, so the card that opens upward has room above the reference.
PROMPT = ("Reply with exactly this and use no tools: nine short paragraphs 'Line 1.' to 'Line 9.', each on its own line, "
          "then the sentence '**PR #1306 fixed** the issue #1250.' with that markdown bold "
          "then a markdown table with columns '#' and 'Title' and two rows: 1318 'ci: submodule' and 1315 'feat: update (#1248)'.")

os.makedirs(OUT, exist_ok=True)
sys.stdout.reconfigure(encoding="utf-8")  # screen lines hold ⬤, which the Windows console code page lacks
screen = pyte.Screen(COLS, ROWS)
stream = pyte.ByteStream(screen)
lock = threading.Lock()
raw = bytearray()  # what the terminal received, for the OSC 8 hyperlinks pyte does not keep

# Fullscreen rendering turns on mouse reporting; WT_SESSION makes links draw as they do in Windows Terminal.
env = dict(os.environ, CLAUDE_CODE_NO_FLICKER="1", WT_SESSION="e2e", TERM_PROGRAM="WindowsTerminal")
proc = PtyProcess.spawn(["claude", "--plugin-dir", PLUGIN, "--model", "haiku"], cwd=CWD, dimensions=(ROWS, COLS), env=env)


def reader():
    while proc.isalive():
        try:
            data = proc.read(65536)
        except EOFError:
            break
        b = data.encode("utf-8", "surrogatepass") if isinstance(data, str) else data
        with lock:
            raw.extend(b)
            stream.feed(b)


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


hovered = clicked = bold_ok = False
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
    # Bold around a reference: no `**` left in the reply, and "PR" before it drawn bold.
    line = text().split("\n")[pos[1] - 1]
    pr_col = line.find("PR")
    with lock:
        bold_pr = pr_col >= 0 and screen.buffer[pos[1] - 1][pr_col].bold
    bold_ok = "**" not in line and bold_pr
    print("bold around reference:", bold_ok, repr(line.strip()))
    x, y = pos[0] + 3, pos[1]  # on the number, past the dot
    proc.write(f"\x1b[<35;{x};{y}M")  # SGR mouse: the pointer moves onto the number
    time.sleep(2)
    dump("2-hover")
    hovered = "#1306" in text() and "checks" in text()
    print("hover card:", hovered)
    # Every cell inside the card's border has a background, so nothing under it shows through.
    # The card is the rectangle of cells filled with its gray (ansi256 236); every cell in it is filled,
    # and no box-drawing frame sits on its edge.
    with lock:
        gray = [(r, c) for r in range(ROWS) for c in range(COLS) if screen.buffer[r][c].bg == "303030"]
        top, bottom = min(r for r, _ in gray), max(r for r, _ in gray)
        left, right = min(c for _, c in gray), max(c for _, c in gray)
        holes = [(r, c) for r in range(top, bottom + 1) for c in range(left, right + 1) if screen.buffer[r][c].bg == "default"]  # the state badge has its own color
        frame = [(r, c) for r in (top, bottom) for c in range(left, right + 1) if screen.buffer[r][c].data in "╭╮╰╯─│"] + \
                [(r, c) for r in range(top, bottom + 1) for c in (left, right) if screen.buffer[r][c].data in "╭╮╰╯─│"]
    print("card", (top, left, bottom, right), "unfilled cells:", len(holes), holes[:5], "frame cells:", len(frame))
    hovered = hovered and not holes and not frame and right - left + 1 == 66
    # The author is a hyperlink to the profile, the URL row one to the PR.
    with lock:
        # OSC 8 carries parameters (an id) before the second `;`.
        targets = set(m.decode("utf-8", "replace") for m in re.findall(rb"\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)", bytes(raw)))
        author_link = "https://github.com/danielscainifiskaltrust" in targets
        pr_link = "https://github.com/fiskaltrust/market-it/pull/1306" in targets
    print("author link:", author_link, "pr link:", pr_link, "footer:", "ctrl+click opens a link" in text())
    hovered = hovered and author_link and pr_link and "ctrl+click opens a link" in text()
    proc.write(f"\x1b[<35;{x};{min(ROWS, y + 3)}M")  # the pointer leaves
    time.sleep(1)
    proc.write(f"\x1b[<0;{x};{y}M\x1b[<0;{x};{y}m")  # a plain click
    time.sleep(2)
    dump("3-click")
    clicked = "CHECKS" in text() and "FILES" in text()
    print("panel:", clicked)

    # The real list: 15 PRs with long titles, the reply that once crashed the hooks worker.
    proc.write("/clear\r")
    time.sleep(3)
    proc.write("List the last 15 PRs of this repo as a markdown table with columns #, State, Author, Title. Use gh.")
    time.sleep(1)
    proc.write("\r")
    wait(lambda t: "Title" in t and t.count("⬤") >= 15, 180, "list")
    time.sleep(10)
    dump("4-list")
    with lock:
        dots = [screen.buffer[r][c].fg for r in range(ROWS) for c in range(COLS) if screen.buffer[r][c].data == "⬤"]
    print("dot colors:", sorted(set(dots)))
    # A hollow dot is a reference still loading, a cross one whose lookup failed.
    pending = text().count("○")
    failed = text().count("✖ ")
    crashed = "crashed" in text()
    print("list dots:", len(dots), "loading:", pending, "failed:", failed, "crashed:", crashed)
    clicked = clicked and not crashed and len(dots) >= 15 and not pending and not failed
    row = find("⬤ 1320")
    if row:
        proc.write(f"\x1b[<35;{row[0] + 3};{row[1]}M")
        time.sleep(2)
        dump("5-list-hover")
        card = "Draft" in text() and "#1320" in text()
        with lock:
            targets = set(m.decode("utf-8", "replace") for m in re.findall(rb"\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)", bytes(raw)))
        pr = "https://github.com/fiskaltrust/market-it/pull/1320"
        card_links = {
            "repo": "https://github.com/fiskaltrust/market-it" in targets,
            "files": pr + "/files" in targets,
            "checks": pr + "/checks" in targets,
            "failing run": any("/actions/runs/" in t or "/runs/" in t for t in targets),
        }
        print("list hover card:", card, "links:", card_links)
        card = card and all(card_links.values())
        clicked = clicked and card
finally:
    proc.write("\x03")
    time.sleep(0.5)
    proc.write("\x03")
    time.sleep(1)
    try:
        if proc.isalive():
            proc.terminate(force=True)
    except OSError:
        pass  # already exiting after the second ctrl+c
sys.exit(0 if hovered and clicked and bold_ok else 3)
