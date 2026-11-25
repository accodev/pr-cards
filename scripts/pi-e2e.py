"""Drives a real Pi session with only the pullywog extension, then checks the band, its keys, the dots,
the hover card and the click that tracks a reference.

A fake model (scripts/e2e_kit.py) gives the reply through a custom provider, so no API key is needed.
The references point at pullywog's own PRs, which `gh` reads. Run from the repo root:
    uv run --no-project --with pyte --with pywinpty python -I scripts/pi-e2e.py      (Windows)
    uv run --no-project --with pyte --with ptyprocess python -I scripts/pi-e2e.py    (Linux, macOS)
Each screen is saved as text in scripts/e2e-out/. Exit code 0 means every check passed.
"""
import json, os, re, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I leaves the script's folder off the path
from e2e_kit import REPO, Terminal, base_env, scratch, start_model

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROWS, COLS = 45, 140
A, B = 30, 32  # merged PRs of pullywog that stay put

sys.stdout.reconfigure(encoding="utf-8")
model = start_model({"PULLYWOG_E2E_REPLY": f"PR #{A} fixed issue #{B}."}, "model-pi.log")

# A fresh agent folder: the fake model as the only provider, and its own tracked list.
agent = scratch("pi")
with open(os.path.join(agent, "models.json"), "w", encoding="utf-8") as f:
    json.dump({"providers": {"fake": {"baseUrl": model, "api": "anthropic-messages", "apiKey": "fake",
                                      "models": [{"id": "fake-model"}]}}}, f)
with open(os.path.join(agent, "settings.json"), "w", encoding="utf-8") as f:
    json.dump({"defaultProvider": "fake", "defaultModel": "fake-model", "tuiMode": "fullscreen"}, f)
env = base_env()
env["PI_CODING_AGENT_DIR"] = agent
term = Terminal(["pi", "-ne", "-e", os.path.join(PLUGIN, "pi", "index.ts"), "--no-session"], PLUGIN, env, ROWS, COLS, prefix="pi-")
checks = {}


def band_chip(number):
    for row, line in enumerate(term.text().split("\n")):
        if f"#{number} " in line and line.startswith("      ") and "⬤" in line:
            return line.index(f"#{number}") + 2, row + 1
    return None


def selected():
    for n in (A, B):
        at = band_chip(n)
        if at:
            row = term.text().split("\n")[at[1] - 1]
            if row[at[0] - 2 - 3] == "▎":  # a ▎ three cells before the #
                return n
    return None


def untrack(n):
    term.send(f"/untrack #{n}")
    time.sleep(0.5)
    term.write("\r")  # the first Enter takes the completion menu's entry, the second runs the command
    time.sleep(0.5)
    term.write("\r")
    time.sleep(1)


try:
    time.sleep(8)
    term.send(f"/track #{A}")
    time.sleep(0.5)
    term.write("\r")
    checks["band"] = term.wait(lambda t: "Tracked PRs" in t and f"#{A}" in t, 40, "band")
    # The chip loads its title from GitHub: more than the number shows.
    checks["chip loaded"] = term.wait(lambda t: any(f"#{A} " in l and "○" not in l and ("waiting" in l or "needs you" in l or "done" in l)
                                                    for l in t.split("\n")), 40, "chip")

    term.send("PULLYWOG_E2E_REPLY")
    time.sleep(0.5)
    term.write("\r")
    checks["dots"] = term.wait(lambda t: any(f"⬤ #{A}" in l and f"⬤ #{B}" in l and "fixed" in l for l in t.split("\n")), 60, "dots")
    at = term.find(f"⬤ #{B}")
    if at:
        x, y = at[0] + 3, at[1]
        term.write(f"\x1b[<35;{x};{y}M")  # the pointer rests on #B
        checks["hover card"] = term.wait(lambda t: f"github.com/{REPO}/pull/{B}" in t, 20, "hover")
        term.write(f"\x1b[<35;{x};{max(1, y - 30)}M")
        checks["card closes"] = term.wait(lambda t: f"github.com/{REPO}/pull/{B}" not in t, 10, "unhover")
        term.write(f"\x1b[<0;{x};{y}M\x1b[<0;{x};{y}m")  # a plain click tracks it
        checks["click tracks"] = term.wait(lambda t: band_chip(B) is not None, 20, "click")
    else:
        checks["hover card"] = False

    # Alt+A gives the band the keyboard: ↓ moves the selection, c copies, x removes, Esc goes back.
    term.write("\x1ba")
    checks["keys"] = term.wait(lambda t: "x remove" in t and "esc back" in t, 15, "keys")
    before = after = selected()
    # ↓ stops at the last chip, ↑ at the first: whichever can move, moves.
    for key in ("\x1b[B", "\x1b[A"):
        term.write(key)
        time.sleep(1)
        after = selected()
        if after != before:
            break
    term.dump("arrow")
    print("selected after Alt+A:", before, "after an arrow:", after)
    checks["arrows move the selection"] = before is not None and after is not None and before != after
    term.write("c")
    time.sleep(4)
    if sys.platform == "win32":
        clip = subprocess.run(["powershell.exe", "-NoProfile", "-Command",
                               "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -TextFormatType Html | Select-Object -Last 1; '---'; Get-Clipboard -TextFormatType UnicodeText"],
                              capture_output=True, encoding="utf-8").stdout
        checks["c copies a rich-text link"] = f"#{after}</a>" in clip and f"/{after}" in clip.split("---")[-1]
    else:
        checks["c copies"] = term.wait(lambda t: f"copied {REPO}#{after}" in t, 10, "copied")
    term.write("x")
    time.sleep(2)
    term.dump("removed")
    checks["x removes the selected chip"] = after is not None and band_chip(after) is None and band_chip(A if after == B else B) is not None
    term.write("\x1b")
    time.sleep(1.5)
    checks["esc goes back"] = term.wait(lambda t: "x remove" not in t, 15, "back")

    for n in (A, B):
        if band_chip(n):
            untrack(n)
    checks["untracked"] = term.wait(lambda t: "Tracked PRs" not in t, 20, "untracked")
finally:
    term.stop()

for name, ok in checks.items():
    print(("PASS " if ok else "FAIL ") + name)
sys.exit(0 if checks and all(checks.values()) else 1)
