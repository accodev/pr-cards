# pr-cards

A Claude Code mod that turns GitHub pull request and issue references in Claude's replies into live links.

- `#1234`, `owner/repo#1234`, GitHub URLs and the numbers in a table column headed `#`, `PR` or `Issue` get a dot in the state's color: green open, gray draft, purple merged, red closed.
- Hovering a reference opens a card: state, title, author, age, size, checks, reviews and open threads.
- Every reference in the card is a link: repo, title references, author, reviewers, files, checks and the failing check's run. Ctrl+click opens it.
- A plain click on a reference opens a panel under the reply with the checks, reviews, threads and files.

The details come from one `gh api graphql` call per repo, cached for 60 seconds.

## Requirements

- Claude Code 2.1.327 or later, the version the mod is tested on.
- The GitHub CLI, `gh`, signed in to an account that can read the repos.
- Fullscreen rendering for hover and click: run `/tui fullscreen` once, or start Claude Code with `CLAUDE_CODE_NO_FLICKER=1`. Without it the dots and links show, and cards do not open.

## Install

```sh
claude plugin marketplace add accodev/pr-cards
claude plugin install pr-cards@pr-cards
```

Then run `/reload-plugins` in a running session, or start a new one. Remove it with `claude plugin uninstall pr-cards@pr-cards`.

## Develop

```sh
claude --plugin-dir .            # run Claude Code with this checkout
claude plugin validate .
claude plugin test .
uv run --no-project --with pywinpty --with pyte python -I scripts/e2e.py C:/code/market-it
```

`scripts/e2e.py` drives a real fullscreen session in a pseudo-terminal, hovers and clicks references, and checks the screen. The design notes are in `docs/handover.md`, the repo rules in `AGENTS.md`.
