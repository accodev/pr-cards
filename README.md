# pullywog

[![npm](https://img.shields.io/npm/v/@accodev/pullywog)](https://www.npmjs.com/package/@accodev/pullywog)
[![npm downloads](https://img.shields.io/npm/dm/@accodev/pullywog)](https://www.npmjs.com/package/@accodev/pullywog)
[![ci](https://github.com/accodev/pullywog/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/accodev/pullywog/actions/workflows/ci.yml)
[![e2e](https://github.com/accodev/pullywog/actions/workflows/e2e.yml/badge.svg?branch=main)](https://github.com/accodev/pullywog/actions/workflows/e2e.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/accodev/pullywog/badge)](https://scorecard.dev/viewer/?uri=github.com/accodev/pullywog)
[![license](https://img.shields.io/github/license/accodev/pullywog)](LICENSE)

pullywog turns GitHub pull request and issue references in your agent's replies into live chips. It works in Claude Code and in Pi.

![pullywog](https://raw.githubusercontent.com/accodev/pullywog/screenshots/reply.png)

## How it works

Every `#1234`, `owner/repo#1234` or GitHub link in a reply gets a dot in the state's color: green open, gray draft, purple merged, red closed. In Claude Code, so do the numbers in a table column headed `#`, `PR` or `Issue`.

Hover a reference to open its card. The card shows the state, title, author, size, checks, reviews and open threads, and Ctrl+click opens any link in it.

The details come from one `gh api graphql` call per repo, cached for 60 seconds.

## Tracking PRs

A plain click on a reference tracks it in a band above the prompt. The band sorts tracked PRs into three groups:

- needs you: your review is asked for, or your own PR fails its checks or got changes requested
- waiting: open, with nothing for you to do yet
- done: merged or closed

Sessions in the same GitHub repo share one list, worktrees included.

![The tracked PRs, with the keys for the selected one](https://raw.githubusercontent.com/accodev/pullywog/screenshots/band.png)

To act on a PR, move to the band with its focus key, pick a chip with ↑ ↓, and press one of these keys:

| Key | Effect |
|---|---|
| `a` | Approves the PR. Press it twice: the first press arms it. |
| `r` | Opens the PR to request changes, which need a comment. |
| `f` | Re-runs the failed checks. |
| `o` | Opens the PR or issue on GitHub. |
| `c` | Copies the link as rich text for chats such as Teams. |
| `x` | Stops tracking it. |

In Claude Code the focus key is Ctrl+X, then Tab, unless `abovePrompt:focus` is bound to another key in `~/.claude/keybindings.json`. In Pi it is Alt+A. Esc goes back to the prompt.

A click on the orange bar folds the band.

## The card

`cardStyle` picks one of two layouts. `card` is the full card shown at the top. `github` follows GitHub's own hover card, with the branches and a footer for the review and the checks.

![The card in the github style](https://raw.githubusercontent.com/accodev/pullywog/screenshots/card-github.png)

## Install

pullywog needs the GitHub CLI, `gh`, signed in to an account that can read the repos.

### Claude Code

```sh
claude plugin marketplace add accodev/pullywog
claude plugin install pullywog@pullywog
```

Run `/reload-plugins` to load it. It needs Claude Code 2.1.327 or later.

The cards need fullscreen rendering: run `/tui fullscreen` once. Without it the dots still show, but cards do not open.

### Pi

```sh
pi install npm:@accodev/pullywog
```

Run `/reload` to load it. In Pi's fullscreen mode it works as in Claude Code.

Pi's regular mode, tmux, Zellij and Screen send no mouse events. There the dots still show, and these commands replace the clicks:

| Command or key | Effect |
|---|---|
| `/track #1234` | Tracks a PR. With no argument it lists this session's references. |
| `/untrack #1234` | Stops tracking it. |
| `Alt+A` | Moves to the band, where the keys above work. |

## Settings

| Option | Default | Effect |
|---|---|---|
| `cardStyle` | `card` | `card` or `github`, as shown above. |
| `trackedBand` | `true` | Shows the band of tracked PRs. |
| `bandPerRow` | `3` | Tracked PRs in a row of a group, 1 to 6. |
| `shareTracked` | `true` | One list per repo. Off, each session keeps its own. |

In Claude Code, set them in `/plugin`, or from the shell:

```sh
echo '{"cardStyle": "github"}' | claude plugin configure pullywog@pullywog --values-stdin
```

In Pi, put them under a `pullywog` key in `settings.json`, for example `"pullywog": { "cardStyle": "github" }`.

## Development

The checks that CI runs on every push and pull request:

```sh
claude plugin validate .
claude plugin test .
npm ci
npm run typecheck:pi
npm run test:pi
```

The end-to-end tests drive real Claude Code and Pi sessions in a terminal. A fake model writes the replies, so they need no API key:

```sh
npm ci
npm run e2e:claude
npm run e2e:pi
```

Each screen is saved as text in `e2e-out/`. CI runs both on every pull request that touches `claude/`, `pi/` or `tests/e2e/`.

The README images come from `scripts/screenshots.ts`, which draws them on made-up repos and people:

```sh
node --experimental-strip-types scripts/screenshots.ts out
```

The design notes are in `docs/handover.md`, the repo rules in `AGENTS.md`.
