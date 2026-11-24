# pr-cards

A Claude Code mod that turns GitHub pull request and issue references in Claude's replies into live links.

![A Claude Code reply with state dots on each PR and issue reference, a bordered table, and the hover card of a PR showing its state, author, size, checks, reviews and threads](docs/screenshot.png)

- `#1234`, `owner/repo#1234`, GitHub URLs and the numbers in a table column headed `#`, `PR` or `Issue` get a dot in the state's color: green open, gray draft, purple merged, red closed.
- Hovering a reference opens a card: state, title, author, age, size, checks, reviews and open threads.
- Every reference in the card is a link: repo, title references, author, reviewers, files, checks and the failing check's run. Ctrl+click opens it.
- A plain click on a reference tracks it in a band above the prompt. Each chip shows the state dot, number, title, author, age and checks, three to a row, in groups: needs you (your review is asked for, or your PR fails its checks or got changes requested), waiting, done. A ▎ marks the selected chip. Sessions in the same GitHub repo, worktrees included, share one tracked list.
- A click on a key under the chips runs it. For the keyboard, press the band focus key (Ctrl+X, then Tab, unless `abovePrompt:focus` is rebound in `~/.claude/keybindings.json`): ↑ ↓ (or Tab) move between chips, Esc goes back to the prompt, and one key acts on the focused chip: `a` approve (press twice), `r` request changes (opens the PR), `f` re-run the failed checks, `o` open, `c` copy the link as rich text for a chat such as Teams (plain text where rich text cannot go), `x` remove.

The details come from one `gh api graphql` call per repo, cached for 60 seconds.

## Requirements

- Claude Code 2.1.327 or later, the version the mod is tested on.
- The GitHub CLI, `gh`, signed in to an account that can read the repos.
- Fullscreen rendering for the hover card: run `/tui fullscreen` once, or start Claude Code with `CLAUDE_CODE_NO_FLICKER=1`. Without it the dots and links show, and cards do not open.

## Install

```sh
claude plugin marketplace add accodev/pr-cards
claude plugin install pr-cards@pr-cards
```

Then run `/reload-plugins` in a running session, or start a new one. Remove it with `claude plugin uninstall pr-cards@pr-cards`.

## Settings

`cardStyle` picks the hover card: `card` (the default) or `github`.

- `card` draws the full card: state, title, author, size, checks, reviews and threads.
- `github` draws GitHub's own hover card layout: repo and date, state with title and number, branches, then the review and checks.

`trackedBand` (default `true`) turns the band above the prompt on or off. `bandPerRow` (default `3`, up to `6`) sets how many tracked PRs share a row of a group. `shareTracked` (default `true`) gives the sessions of one GitHub repo, or of one folder outside git, one tracked list; off, each session keeps its own.

Set them in `/plugin`, or from the shell:

```sh
echo '{"cardStyle": "github"}' | claude plugin configure pr-cards@pr-cards --values-stdin
```

## Develop

```sh
claude --plugin-dir .            # run Claude Code with this checkout
claude plugin validate .
claude plugin test .
uv run --no-project --with pywinpty --with pyte python -I scripts/e2e.py C:/code/market-it
```

`scripts/e2e.py` drives a real fullscreen session in a pseudo-terminal, hovers and clicks references, and checks the screen. The design notes are in `docs/handover.md`, the repo rules in `AGENTS.md`.
