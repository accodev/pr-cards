// Drives a real fullscreen Claude Code session with the pullywog mod, then checks the dots, the hover
// card, tracking, the band's keys and a long table.
// A fake model (model.ts) gives the replies, so no API key is needed. The references point at
// pullywog's own PRs, which `gh` reads. Run from the repo root after `npm ci` with `npm run e2e:claude`.
// Each screen is saved as text in e2e-out/. Exit code 0 means every check passed.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseEnv, REPO, report, ROOT, scratch, sleep, Terminal } from './kit.ts'
import { startModel } from './model.ts'
import { A, B, C, checkBand } from './claude-band.ts'
import { checkTable, LIST } from './claude-table.ts'

const ROWS = 50, COLS = 170
const KEY = 'sk-ant-e2e-fake-key-0000000000000000'

const reply = [...Array.from({ length: 9 }, (_, i) => `Line ${i + 1}.`),
  `**PR #${A} fixed** the issue #${B}.`,
  `Merged in [#${C}](https://github.com/${REPO}/pull/${C}).`,
  '| # | Title |\n|---|---|\n| 31 | docs: install command |\n| 29 | feat: versions (#28) |',
].join('\n\n')
const table = '| # | State | Author | Title |\n|---|---|---|---|\n' + [...LIST].reverse().map(n =>
  `| ${n} | merged | accodev | a pull request with a long title that wraps in a narrow column, number ${n} |`).join('\n')
const model = await startModel({ PULLYWOG_E2E_REPLY: reply, PULLYWOG_E2E_LIST: table }, 'model-claude.log')

// A fresh config folder: no onboarding, the folder trusted, the fake key accepted, no keybindings.
const config = scratch('claude')
writeFileSync(join(config, '.claude.json'), JSON.stringify({
  hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
  projects: { [ROOT.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true }, [ROOT]: { hasTrustDialogAccepted: true } },
}))
const env = {
  ...baseEnv(), CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: model, ANTHROPIC_API_KEY: KEY,
  CLAUDE_CODE_NO_FLICKER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
  // Links draw as in Windows Terminal, which takes OSC 8.
  WT_SESSION: 'e2e', TERM_PROGRAM: 'WindowsTerminal',
}
const gh = (...args: string[]): string => {
  try { return execFileSync('gh', args, { encoding: 'utf8' }).trim() } catch { return '' }
}
// The card says "you" for the signed-in user, unlinked: the author check needs the PR's author as someone else.
const viewer = gh('api', 'user', '--jq', '.login')
const author = gh('pr', 'view', String(A), '--repo', REPO, '--json', 'author', '--jq', '.author.login')

const term = new Terminal(['claude', '--plugin-dir', ROOT], ROOT, env, ROWS, COLS)
const checks: Record<string, boolean> = {}

// The card is the rectangle of cells filled with its gray (ansi256 236): every cell in it is filled,
// and no box-drawing frame sits on its edge.
function card(): { cells: number, holes: number, frame: number, width: number } {
  const gray: [number, number][] = []
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (term.cell(c, r).bg === 'p236') gray.push([r, c])
  if (!gray.length) return { cells: 0, holes: 0, frame: 0, width: 0 }
  const rs = gray.map(g => g[0]), cs = gray.map(g => g[1])
  const top = Math.min(...rs), bottom = Math.max(...rs), left = Math.min(...cs), right = Math.max(...cs)
  let holes = 0, frame = 0
  for (let r = top; r <= bottom; r++) {
    for (let c = left; c <= right; c++) if (term.cell(c, r).bg === 'default') holes++
    for (const c of [left, right]) if ('╭╮╰╯─│'.includes(term.cell(c, r).ch || ' ')) frame++
  }
  return { cells: gray.length, holes, frame, width: right - left + 1 }
}

try {
  if (!await term.wait(t => t.includes('❯'), 60, 'start')) process.exit(1)
  await sleep(3000)
  // Answer any first-run question the config did not settle: trust, the key, the theme.
  for (let i = 0; i < 3; i++) {
    const low = term.text().toLowerCase()
    if (low.includes('trust') || low.includes('api key') || low.includes('theme')) {
      term.write('\r')
      await sleep(2000)
    }
  }
  await term.send('PULLYWOG_E2E_REPLY')
  await sleep(500)
  term.write('\r')
  await term.wait(t => t.includes('29') && t.includes(`#${A}`) && t.includes('⬤'), 120, 'reply')
  await sleep(8000) // the gh lookup and the redraw
  term.dump('1-reply')
  const pos = term.find(`⬤ #${A}`)
  console.log('reference at', pos)
  if (!pos) process.exit(2)

  // Bold around a reference: no `**` left in the reply, and "PR" before it drawn bold.
  const line = term.lines()[pos[1] - 1]
  const prCol = line.indexOf('PR')
  checks['bold around a reference'] = !line.includes('**') && prCol >= 0 && term.cell(prCol, pos[1] - 1).bold
  checks['markdown link gets a dot'] = term.find(`Merged in ⬤ #${C}`) !== null

  const x = pos[0] + 3, y = pos[1] // on the number, past the dot
  term.write(`\x1b[<35;${x};${y}M`) // SGR mouse: the pointer moves onto the number
  await sleep(2000)
  term.dump('2-hover')
  const hovered = term.text().includes(`#${A}`) && term.text().includes('checks')
  const box = card()
  console.log('card cells:', box.cells, 'unfilled:', box.holes, 'frame:', box.frame, 'width:', box.width)
  checks['hover card, filled, 66 wide'] = hovered && box.cells > 0 && !box.holes && !box.frame && box.width === 66
  const targets = term.links()
  checks['card links the PR'] = targets.has(`https://github.com/${REPO}/pull/${A}`)
  if (author && author !== viewer) checks['card links the author'] = targets.has(`https://github.com/${author}`)
  checks['no ctrl+click hint row'] = !term.text().includes('ctrl+click')

  term.write(`\x1b[<35;${x};${Math.min(ROWS, y + 3)}M`) // the pointer leaves
  await sleep(1000)
  await checkBand(term, checks, x, y)
  await checkTable(term, checks)
} finally {
  await term.stop()
}

report(checks)
