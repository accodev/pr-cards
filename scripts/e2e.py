"""Drives a real fullscreen Claude Code session with the pullywog mod, then checks the dots, the hover
card, tracking, the band's keys and a long table.

A fake model (scripts/e2e_kit.py) gives the replies, so no API key is needed. The references point at
pullywog's own PRs, which `gh` reads. Run from the repo root:
    uv run --no-project --with pyte --with pywinpty python -I scripts/e2e.py      (Windows)
    uv run --no-project --with pyte --with ptyprocess python -I scripts/e2e.py    (Linux, macOS)
Each screen is saved as text in scripts/e2e-out/. Exit code 0 means every check passed.
"""
import json, os, re, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I leaves the script's folder off the path
from e2e_kit import REPO, Terminal, base_env, scratch, start_model

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROWS, COLS = 50, 170
# PRs of pullywog that stay put: A and B merged, C a markdown link, the table's numbers bare.
A, B, C = 30, 32, 33
LIST = list(range(16, 31))  # 15 PRs for the long table
HOVER_ROW = 25

sys.stdout.reconfigure(encoding="utf-8")  # screen lines hold ⬤, which the Windows console code page lacks
reply = "\n\n".join([f"Line {i}." for i in range(1, 10)] + [
    f"**PR #{A} fixed** the issue #{B}.",
    f"Merged in [#{C}](https://github.com/{REPO}/pull/{C}).",
    "| # | Title |\n|---|---|\n| 31 | docs: install command |\n| 29 | feat: versions (#28) |",
])
table = "| # | State | Author | Title |\n|---|---|---|---|\n" + "\n".join(
    f"| {n} | merged | accodev | a pull request with a long title that wraps in a narrow column, number {n} |" for n in reversed(LIST))
model = start_model({"PULLYWOG_E2E_REPLY": reply, "PULLYWOG_E2E_LIST": table}, "model-claude.log")

# A fresh config folder: no onboarding, the folder trusted, the fake key accepted, no keybindings.
config = scratch("claude")
KEY = "sk-ant-e2e-fake-key-0000000000000000"
with open(os.path.join(config, ".claude.json"), "w", encoding="utf-8") as f:
    json.dump({"hasCompletedOnboarding": True, "theme": "dark", "customApiKeyResponses": {"approved": [KEY[-20:]], "rejected": []},
               "projects": {PLUGIN.replace("\\", "/"): {"hasTrustDialogAccepted": True}, PLUGIN: {"hasTrustDialogAccepted": True}}}, f)
env = base_env()
env.update(CLAUDE_CONFIG_DIR=config, ANTHROPIC_BASE_URL=model, ANTHROPIC_API_KEY=KEY,
           CLAUDE_CODE_NO_FLICKER="1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1", DISABLE_AUTOUPDATER="1",
           # Links draw as in Windows Terminal, which takes OSC 8.
           WT_SESSION="e2e", TERM_PROGRAM="WindowsTerminal")
# The card says "you" for the signed-in user, unlinked: the author check needs the PR's author as someone else.
viewer = subprocess.run(["gh", "api", "user", "--jq", ".login"], capture_output=True, text=True).stdout.strip()
author = subprocess.run(["gh", "pr", "view", str(A), "--repo", REPO, "--json", "author", "--jq", ".author.login"], capture_output=True, text=True).stdout.strip()

term = Terminal(["claude", "--plugin-dir", PLUGIN], PLUGIN, env, ROWS, COLS)
checks = {}


def chip_at(number):
    for row, line in enumerate(term.text().split("\n")):
        # A band row starts with a group label, or with its blank space on a group's next rows.
        band_row = line.startswith(("      needs you", "      waiting", "      done", " " * 16))
        if f"⬤ #{number} " in line and band_row:
            return line.index(f"#{number}") + 2, row + 1
    return None


def click(x, y):
    term.write(f"\x1b[<0;{x};{y}M\x1b[<0;{x};{y}m")


try:
    if not term.wait(lambda t: "❯" in t, 60, "start"):
        sys.exit(1)
    time.sleep(3)
    # Answer any first-run question the config did not settle: trust, the key, the theme.
    for _ in range(3):
        low = term.text().lower()
        if "trust" in low or "api key" in low or "theme" in low:
            term.write("\r")
            time.sleep(2)
    term.send("PULLYWOG_E2E_REPLY")
    time.sleep(0.5)
    term.write("\r")
    term.wait(lambda t: "29" in t and f"#{A}" in t and "⬤" in t, 120, "reply")
    time.sleep(8)  # the gh lookup and the redraw
    term.dump("1-reply")
    pos = term.find(f"⬤ #{A}")
    print("reference at", pos)
    if not pos:
        sys.exit(2)

    # Bold around a reference: no `**` left in the reply, and "PR" before it drawn bold.
    line = term.text().split("\n")[pos[1] - 1]
    pr_col = line.find("PR")
    with term.lock:
        bold_pr = pr_col >= 0 and term.screen.buffer[pos[1] - 1][pr_col].bold
    checks["bold around a reference"] = "**" not in line and bold_pr
    checks["markdown link gets a dot"] = term.find(f"Merged in ⬤ #{C}") is not None

    x, y = pos[0] + 3, pos[1]  # on the number, past the dot
    term.write(f"\x1b[<35;{x};{y}M")  # SGR mouse: the pointer moves onto the number
    time.sleep(2)
    term.dump("2-hover")
    hovered = f"#{A}" in term.text() and "checks" in term.text()
    # The card is the rectangle of cells filled with its gray (ansi256 236): every cell in it is
    # filled, and no box-drawing frame sits on its edge.
    with term.lock:
        buf = term.screen.buffer
        gray = [(r, c) for r in range(ROWS) for c in range(COLS) if buf[r][c].bg == "303030"]
        holes = frame = []
        if gray:
            top, bottom = min(r for r, _ in gray), max(r for r, _ in gray)
            left, right = min(c for _, c in gray), max(c for _, c in gray)
            holes = [(r, c) for r in range(top, bottom + 1) for c in range(left, right + 1) if buf[r][c].bg == "default"]
            frame = [(r, c) for r in range(top, bottom + 1) for c in (left, right) if buf[r][c].data in "╭╮╰╯─│"]
    print("card cells:", len(gray), "unfilled:", len(holes), "frame:", len(frame))
    checks["hover card, filled, 66 wide"] = hovered and bool(gray) and not holes and not frame and right - left + 1 == 66
    targets = term.links()
    checks["card links the PR"] = f"https://github.com/{REPO}/pull/{A}" in targets
    if author and author != viewer:
        checks["card links the author"] = f"https://github.com/{author}" in targets
    checks["no ctrl+click hint row"] = "ctrl+click" not in term.text()

    term.write(f"\x1b[<35;{x};{min(ROWS, y + 3)}M")  # the pointer leaves
    time.sleep(1)
    click(x, y)  # a plain click tracks the PR
    time.sleep(2)
    term.dump("3-click")
    first = chip_at(A)
    checks["click tracks: chip and key row"] = first is not None and "x: remove" in term.text()

    # Design P3: "Tracked PRs" on a bar of Claude Code's orange, bold; a click on it folds the band.
    bar = None
    for row, l in enumerate(term.text().split("\n")):
        if l.startswith("   ▾ Tracked PRs"):
            with term.lock:
                cell = term.screen.buffer[row][3]
            checks["bar has a background and bold"] = cell.bg not in ("default", "") and cell.bold
            bar = row + 1
    if bar:
        click(10, bar)
        time.sleep(2)
        term.dump("3-folded")
        folded = chip_at(A) is None and "▸ Tracked PRs · 1" in term.text()
        bar = next((r + 1 for r, l in enumerate(term.text().split("\n")) if "▸ Tracked PRs" in l), bar)
        click(10, bar)
        time.sleep(2)
        checks["bar folds and unfolds"] = folded and chip_at(A) is not None
    else:
        checks["bar has a background and bold"] = False

    # Track a second PR, select the first chip, focus the band, ↓ to the second, c copies, x removes.
    second_ref = term.find(f"⬤ #{B}")
    if first and second_ref:
        click(second_ref[0] + 3, second_ref[1])
        time.sleep(2)
        first = chip_at(A)
        click(first[0], first[1])
        time.sleep(1)
        term.write("\x18\t")  # Claude Code's default band focus key: ctrl+x, then tab
        time.sleep(1)
        term.dump("3a-focused")

        def picked():
            marks = {}
            for n in (A, B):
                at = chip_at(n)
                if not at:
                    return None
                with term.lock:
                    row = term.screen.display[at[1] - 1]
                marks[n] = row[at[0] - 2 - 3] == "▎"  # Design G1: a ▎ three cells before the #
            return next((n for n, on in marks.items() if on), None) if sum(marks.values()) == 1 else None

        before = after = picked()
        for _ in range(3):
            term.write("\x1b[B")
            time.sleep(1)
            after = picked()
            if after != before:
                break
        term.dump("3b-arrow")
        print("selected after the focus key:", before, "after ↓:", after)
        checks["↓ moves the selection"] = before is not None and after is not None and before != after

        term.write("c")
        time.sleep(4)
        if sys.platform == "win32":
            clip = subprocess.run(["powershell.exe", "-NoProfile", "-Command",
                                   "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -TextFormatType Html | Select-Object -Last 1; '---'; Get-Clipboard -TextFormatType UnicodeText"],
                                  capture_output=True, encoding="utf-8").stdout
            checks["c copies a rich-text link"] = f"#{after}</a>" in clip and f"/{after}" in clip.split("---")[-1]
        else:
            # No Windows clipboard: the plain text goes out as an OSC 52 clipboard write.
            import base64
            with term.lock:
                writes = re.findall(rb"\x1b\]52;[^;]*;([A-Za-z0-9+/=]+)", bytes(term.raw))
            texts = [base64.b64decode(w).decode("utf-8", "replace") for w in writes]
            # Or the mod's own notice, where Claude Code takes the copy another way.
            checks["c copies the link"] = any(f"/{after}" in t for t in texts) or f"copied {REPO}#{after}" in term.text()

        term.write("x")
        time.sleep(2)
        term.dump("3c-removed")
        checks["x removes the selected chip"] = after is not None and chip_at(after) is None and chip_at(A if after == B else B) is not None
        for _ in range(3):  # leave nothing tracked
            if not (chip_at(A) or chip_at(B)):
                break
            term.write("\x18\tx")
            time.sleep(2)
    else:
        checks["second PR tracked"] = False

    # A long table: 15 PRs, the reply that once crashed the hooks worker.
    term.write("/clear\r")
    time.sleep(3)
    term.send("PULLYWOG_E2E_LIST")
    time.sleep(0.5)
    term.write("\r")
    term.wait(lambda t: "Title" in t and t.count("⬤") >= 15, 120, "list")
    time.sleep(10)
    term.dump("4-list")
    with term.lock:
        dots = [term.screen.buffer[r][c].fg for r in range(ROWS) for c in range(COLS) if term.screen.buffer[r][c].data == "⬤"]
    pending = term.text().count("○")  # a hollow dot is still loading
    failed = len(re.findall(r"(?<!\w)x #\d", term.text()))  # a cross is a failed lookup
    print("list dots:", len(dots), "colors:", sorted(set(dots)), "loading:", pending, "failed:", failed)
    checks["long table: 15 dots, all loaded"] = "crashed" not in term.text() and len(dots) >= 15 and not pending and not failed
    lines = term.text().split("\n")
    top = next((i for i, l in enumerate(lines) if "┌" in l), None)
    bottom = next((i for i, l in enumerate(lines) if "└" in l and top is not None and i > top), None)
    aligned = False
    if top is not None and bottom is not None:
        left, right = lines[top].index("┌"), lines[top].rindex("┐")
        aligned = all(lines[i][left] in "│├└" and lines[i][right] in "│┤┘" for i in range(top + 1, bottom + 1))
    checks["long table keeps its borders"] = aligned
    row = term.find(f"⬤ {HOVER_ROW}")
    if row:
        term.write(f"\x1b[<35;{row[0] + 3};{row[1]}M")
        time.sleep(2)
        term.dump("5-list-hover")
        targets = term.links()
        pr = f"https://github.com/{REPO}/pull/{HOVER_ROW}"
        checks["table number opens a card with links"] = (f"{REPO} #{HOVER_ROW}" in term.text() and f"https://github.com/{REPO}" in targets
                                                          and pr + "/files" in targets and pr + "/checks" in targets)
    else:
        checks["table number opens a card with links"] = False
finally:
    term.stop()

for name, ok in checks.items():
    print(("PASS " if ok else "FAIL ") + name)
sys.exit(0 if checks and all(checks.values()) else 3)
