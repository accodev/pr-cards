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
          "then the sentence '**PR #1306 fixed** the issue #1250.' with that markdown bold, "
          "then the sentence 'Merged in [#1318](https://github.com/fiskaltrust/market-it/pull/1318).' with that markdown link "
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
    # A markdown link to a PR gets the dot like a plain `#1318`.
    md_link = find("Merged in ⬤ #1318") is not None
    print("markdown link reference:", md_link)
    bold_ok = bold_ok and md_link
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
    no_hint = "ctrl+click" not in text()
    print("author link:", author_link, "pr link:", pr_link, "no hint row:", no_hint)
    pr_link = pr_link and no_hint
    # The author is drawn without a solid underline, so the terminal's dotted hyperlink underline shows.
    at = find("@danielscainifiskaltrust")
    with lock:
        solid = at is not None and screen.buffer[at[1] - 1][at[0] - 1].underscore
    print("author solid underline:", solid)
    author_link = author_link and at is not None and not solid
    hovered = hovered and author_link and pr_link
    proc.write(f"\x1b[<35;{x};{min(ROWS, y + 3)}M")  # the pointer leaves
    time.sleep(1)
    proc.write(f"\x1b[<0;{x};{y}M\x1b[<0;{x};{y}m")  # a plain click
    time.sleep(2)
    dump("3-click")
    # A plain click tracks the PR: a chip above the prompt and the hotkey row of the selected one.
    # The e2e never presses a, r, f or c: those act on a real PR.
    def chip_at(number):
        for row, line in enumerate(text().split("\n")):
            # A band row starts with a group label, or with its blank space on a group's next rows.
            band_row = line.startswith(("  needs you", "  waiting", "  done", " " * 12))
            if f"⬤ #{number} " in line and band_row:
                return line.index(f"#{number}") + 2, row + 1
        return None

    first = chip_at(1306)
    keyrow = "x: remove" in text()
    print("tracked chip and hotkey row:", first, keyrow)
    # Design P3: "Tracked PRs" on a bar of Claude Code's orange, bold.
    titled = None
    for row, line in enumerate(text().split("\n")):
        if line.startswith("   Tracked PRs"):
            with lock:
                cell = screen.buffer[row][3]
            titled = (cell.bg, cell.bold)
    print("title 'Tracked PRs' (background, bold):", titled)
    titled = bool(titled and titled[0] not in ("default", "") and titled[1])
    clicked = first is not None and keyrow and titled and "crashed" not in text()
    # Track a second one, focus the band with a click on the first chip, → to the second, x removes it.
    issue = find("⬤ #1250")
    if clicked and issue:
        proc.write(f"\x1b[<0;{issue[0] + 3};{issue[1]}M\x1b[<0;{issue[0] + 3};{issue[1]}m")
        time.sleep(2)
        second = chip_at(1250)
        first = chip_at(1306)
        proc.write(f"\x1b[<0;{first[0]};{first[1]}M\x1b[<0;{first[0]};{first[1]}m")  # selects the first chip
        time.sleep(1)
        # The band's focus chord: the last Chat binding of abovePrompt:focus in keybindings.json,
        # else Claude Code's default, ctrl+x tab.
        import json
        import pathlib

        def focus_chord():
            chord = "ctrl+x tab"
            try:
                file = json.loads((pathlib.Path.home() / ".claude" / "keybindings.json").read_text(encoding="utf-8"))
                for block in file.get("bindings", []):
                    if block.get("context") != "Chat":
                        continue
                    for keys, action in block.get("bindings", {}).items():
                        if action == "abovePrompt:focus":
                            chord = keys
                        elif keys == chord:
                            chord = None
            except (OSError, ValueError):
                pass
            return chord

        def keys_of(chord):
            out = ""
            for part in chord.split(" "):
                *mods, key = part.split("+")
                key = {"tab": "\t", "enter": "\r", "space": " "}.get(key, key)
                if "ctrl" in mods and len(key) == 1 and key.isalpha():
                    key = chr(ord(key) - 96)
                if "alt" in mods or "meta" in mods:
                    key = "\x1b" + key
                out += key
            return out

        chord = focus_chord()
        focus = keys_of(chord) if chord else "\x18\t"
        print("focus chord from keybindings.json:", chord)
        proc.write(focus)  # the band takes the keyboard
        time.sleep(1)
        dump("3a-focused")

        # Design G1: the selected chip starts with a ▎ (three cells before its #), no chip is underlined.
        def look(number):
            at = chip_at(number)
            if not at:
                return None
            with lock:
                row = screen.display[at[1] - 1]
                cell = screen.buffer[at[1] - 1][at[0] - 1]
            start = at[0] - 2  # the 0-based column of the #
            return row[start - 3] == "▎", cell.underscore, row[max(0, start - 14):start + 30]

        def picked():
            a, b = look(1306), look(1250)
            print("chips (marked, underlined, text):", a, b)
            if not a or not b or a[1] or b[1] or a[0] == b[0]:
                return None
            return 1306 if a[0] else 1250

        before = picked()
        # ↓ moves to the next control: the chip's own × first, then the next chip.
        after = before
        for _ in range(3):
            proc.write("\x1b[B")
            time.sleep(1)
            after = picked()
            if after != before:
                break
        dump("3b-arrow")
        print("focused after the focus chord:", before, "after ↓:", after)
        moved = before is not None and after is not None and before != after
        # c copies the focused one as a link: the clipboard holds an HTML link and the plain text.
        proc.write("c")
        time.sleep(4)
        import subprocess
        clip = subprocess.run(["powershell.exe", "-NoProfile", "-Command",
                               "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -TextFormatType Html | Select-Object -Last 1; '---'; Get-Clipboard -TextFormatType UnicodeText"],
                              capture_output=True, encoding="utf-8")
        copied = f'#{after}</a>' in clip.stdout and f'/{after}' in clip.stdout.split('---')[-1]
        print("c copied a link:", copied, repr(clip.stdout.strip()[-160:]))
        moved = moved and copied
        proc.write("x")
        time.sleep(2)
        dump("3c-removed")
        # x removes the chip ↓ moved to.
        gone = after is not None and chip_at(after) is None and chip_at(1306 if after == 1250 else 1250) is not None
        print("↓ moved the selection:", moved, "x removed it:", gone)
        clicked = clicked and moved and gone
        # Leave nothing tracked.
        for _ in range(3):
            if not (chip_at(1306) or chip_at(1250)):
                break
            proc.write(focus + "x")  # focus the band, then x on whichever chip holds the focus
            time.sleep(2)
    else:
        clicked = False

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
    failed = len(re.findall(r"(?<!\w)x #\d", text()))
    crashed = "crashed" in text()
    print("list dots:", len(dots), "loading:", pending, "failed:", failed, "crashed:", crashed)
    clicked = clicked and not crashed and len(dots) >= 15 and not pending and not failed
    # The table keeps Claude Code's borders: every line from ┌ to └ starts and ends on the same columns.
    lines = text().split("\n")
    top = next((i for i, l in enumerate(lines) if "┌" in l), None)
    bottom = next((i for i, l in enumerate(lines) if "└" in l and top is not None and i > top), None)
    aligned = False
    if top is not None and bottom is not None:
        left, right = lines[top].index("┌"), lines[top].rindex("┐")
        aligned = all(lines[i][left] in "│├└" and lines[i][right] in "│┤┘" for i in range(top + 1, bottom + 1))
    print("table borders:", top is not None and bottom is not None, "aligned:", aligned)
    clicked = clicked and aligned
    row = find("⬤ 1320")
    if row:
        proc.write(f"\x1b[<35;{row[0] + 3};{row[1]}M")
        time.sleep(2)
        dump("5-list-hover")
        # #1320's state and checks change on GitHub: only its number is fixed.
        card = "fiskaltrust/market-it #1320" in text()
        failing_shown = bool(re.search(r"(?<!\w)x \d+ of \d+ checks|· x ", text()))
        with lock:
            targets = set(m.decode("utf-8", "replace") for m in re.findall(rb"\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)", bytes(raw)))
        pr = "https://github.com/fiskaltrust/market-it/pull/1320"
        card_links = {
            "repo": "https://github.com/fiskaltrust/market-it" in targets,
            "files": pr + "/files" in targets,
            "checks": pr + "/checks" in targets,
            "failing run": not failing_shown or any("/runs/" in t for t in targets),
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
