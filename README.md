# pullywog

![pullywog](https://raw.githubusercontent.com/accodev/pullywog/screenshots/reply.png)

pullywog is a Claude Code mod and a [Pi](https://pi.dev) extension that turns the GitHub pull request and issue references in the agent's replies into live chips. `#1234`, `owner/repo#1234`, GitHub URLs and the numbers in a table column headed `#`, `PR` or `Issue` get a dot in the state's color: green open, gray draft, purple merged, red closed. Hover a reference for its card: state, title, author, age, size, checks, reviews and open threads, each a link that Ctrl+click opens. A plain click tracks the PR in a band above the prompt, where the tracked PRs sit in three groups: needs you (your review is asked for, or your PR fails its checks or got changes requested), waiting, and done. Sessions in the same GitHub repo, worktrees included, share one tracked list. From the band one key acts on the selected PR: approve, request changes, re-run the failed checks, open it, copy its link as rich text for a chat such as Teams, or remove it. The details come from one `gh api graphql` call per repo, cached for 60 seconds.

![The tracked PRs, with the keys for the selected one](https://raw.githubusercontent.com/accodev/pullywog/screenshots/band.png)

![The card in the github style](https://raw.githubusercontent.com/accodev/pullywog/screenshots/card-github.png)

## Install

pullywog needs the GitHub CLI, `gh`, signed in to an account that can read the repos.

```sh
claude plugin marketplace add accodev/pullywog
claude plugin install pullywog@pullywog
```

Run `/reload-plugins` in an open session to load it. pullywog is tested on Claude Code 2.1.327, and needs that version or later. The hover card needs fullscreen rendering: run `/tui fullscreen` once, or start Claude Code with `CLAUDE_CODE_NO_FLICKER=1`. Without it the dots and links show, and cards do not open.

A click on a key under the chips runs it. For the keyboard, press the band focus key (Ctrl+X, then Tab, unless `abovePrompt:focus` is rebound in `~/.claude/keybindings.json`): ↑ ↓ (or Tab) move between chips, Esc goes back to the prompt, and one key acts on the focused chip.

| Key | Effect |
|---|---|
| `a` | Approves the PR. Press it twice: the first press arms it. |
| `r` | Opens the PR to request changes, which need a comment. |
| `f` | Re-runs the failed checks. |
| `o` | Opens the PR or issue on GitHub. |
| `c` | Copies the link as rich text, or plain text where rich text cannot go. |
| `x` | Stops tracking it. |

A click on the Tracked PRs bar folds the band to the bar and the count.

Before 0.8.0 the plugin was named pr-cards. To move over, remove the old one and its marketplace, then install as above:

```sh
claude plugin uninstall pr-cards@pr-cards
claude plugin marketplace remove pr-cards
```

The tracked lists live in the plugin's own store file under `~/.claude/plugins/store/`. To keep them, copy `pr-cards_pr-cards-*.json` over the new `pullywog_pullywog-*.json` once pullywog has run.

## Pi

```sh
pi install git:github.com/accodev/pullywog
```

Run `/reload` in an open session to load it. In Pi's fullscreen mode (`tuiMode`, the default) the extension works as the Claude Code mod: the dots, the card on hover, a plain click to track and Ctrl+click to open. Pi gives extensions no mouse hook in its transcript, so pullywog reads the mouse reports from the terminal input beside Pi, as `@narumitw/pi-inline` does. Pi's regular mode, tmux, Zellij and Screen send none: there the dots show, and the commands below stand in for the click.

| Command or key | Effect |
|---|---|
| `/track #1234` | Tracks a PR or issue: `#1234`, `owner/repo#1234` or a GitHub URL. With no argument it offers the references of this session's replies. |
| `/untrack #1234` | Stops tracking it. |
| `Alt+A` | Moves to the band: arrows pick a chip, the keys above act on it, Esc goes back. |

Bare numbers in a table column headed `#`, `PR` or `Issue` get no dot in Pi. Pi has no orange theme key, so the bar takes the theme's accent color. The Pi extension keeps its tracked lists in `~/.pi/agent/pullywog.json`, apart from Claude Code's. Pi's `settings.json` takes the options below under a `pullywog` key, for example `"pullywog": { "cardStyle": "github" }`.

## Settings

Claude Code keeps them in `settings.json`, under `pluginConfigs["pullywog@pullywog"].options`. Set them in `/plugin`, or from the shell:

```sh
echo '{"cardStyle": "github"}' | claude plugin configure pullywog@pullywog --values-stdin
```

| Option | Default | Effect |
|---|---|---|
| `cardStyle` | `card` | `card` draws the full card: state, title, author, size, checks, reviews and threads. `github` follows GitHub's own hover card: repo and date, state with title and number, branches, then the review and checks. |
| `trackedBand` | `true` | Shows the band of tracked PRs above the prompt. Off, a click on a reference does nothing. |
| `bandPerRow` | `3` | Tracked PRs in a row of a group, 1 to 6. |
| `shareTracked` | `true` | Gives the sessions of one GitHub repo, or of one folder outside git, one tracked list. Off, each session keeps its own. |

## Development

```sh
claude plugin validate .
claude plugin test .
```

```sh
npm ci
npm run typecheck:pi
npm run test:pi
```

Those check the Pi extension in `pi/`. CI runs all five commands on every push to `main` and on pull requests. On `main` it also renders the README images with `scripts/screenshots.mjs` and pushes them to the `screenshots` branch.

```sh
node --experimental-strip-types scripts/screenshots.mjs out
```

That renders them locally, with Chrome or Edge. The scenes use pullywog's own drawing code on made-up repos and people.

```sh
uv run --no-project --with pywinpty --with pyte python -I scripts/e2e.py <folder of a GitHub repo>
uv run --no-project --with pywinpty --with pyte python -I scripts/pi-e2e.py <folder of a GitHub repo>
```

Those drive a real fullscreen Claude Code or Pi session in a pseudo-terminal: they hover and click references, track a PR, and check the screen. The PR and issue numbers they use are at the top of each script. The design notes are in `docs/handover.md`, the repo rules in `AGENTS.md`.
