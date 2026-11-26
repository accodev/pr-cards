// Drives a real Pi session with only the pullywog extension, then checks the band, its keys, the dots,
// the hover card and the click that tracks a reference.
// A fake model (model.ts) gives the reply through a custom provider, so no API key is needed. The
// references point at pullywog's own PRs, which `gh` reads. Run from the repo root after `npm ci` with
// `npm run e2e:pi`. Each screen is saved as text in e2e-out/. Exit code 0 means every check passed.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseEnv, copied, REPO, report, ROOT, scratch, sleep, Terminal } from './kit.ts'
import { startModel } from './model.ts'

const ROWS = 45, COLS = 140
const A = 30, B = 32 // merged PRs of pullywog that stay put

const model = await startModel({ PULLYWOG_E2E_REPLY: `PR #${A} fixed issue #${B}.` }, 'model-pi.log')

// A fresh agent folder: the fake model as the only provider, and its own tracked list.
const agent = scratch('pi')
writeFileSync(join(agent, 'models.json'), JSON.stringify({
  providers: { fake: { baseUrl: model, api: 'anthropic-messages', apiKey: 'fake', models: [{ id: 'fake-model' }] } },
}))
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-model', tuiMode: 'fullscreen' }))
const env = { ...baseEnv(), PI_CODING_AGENT_DIR: agent }

const term = new Terminal(['pi', '-ne', '-e', join(ROOT, 'pi', 'index.ts'), '--no-session'], ROOT, env, ROWS, COLS, 'pi-')
const checks: Record<string, boolean> = {}

function bandChip(n: number): [number, number] | null {
  const lines = term.lines()
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row]
    if (line.includes(`#${n} `) && line.startsWith('      ') && line.includes('⬤')) return [line.indexOf(`#${n}`) + 2, row + 1]
  }
  return null
}

function selected(): number | null {
  for (const n of [A, B]) {
    const at = bandChip(n)
    if (at && term.lines()[at[1] - 1][at[0] - 2 - 3] === '▎') return n // a ▎ three cells before the #
  }
  return null
}

async function untrack(n: number): Promise<void> {
  await term.send(`/untrack #${n}`)
  await sleep(500)
  term.write('\r') // the first Enter takes the completion menu's entry, the second runs the command
  await sleep(500)
  term.write('\r')
  await sleep(1000)
}

try {
  await sleep(8000)
  await term.send(`/track #${A}`)
  await sleep(500)
  term.write('\r')
  checks['band'] = await term.wait(t => t.includes('Tracked PRs') && t.includes(`#${A}`), 40, 'band')
  // The chip loads its title from GitHub: more than the number shows.
  checks['chip loaded'] = await term.wait(t => t.split('\n').some(l => l.includes(`#${A} `) && !l.includes('○')
    && (l.includes('waiting') || l.includes('needs you') || l.includes('done'))), 40, 'chip')

  await term.send('PULLYWOG_E2E_REPLY')
  await sleep(500)
  term.write('\r')
  checks['dots'] = await term.wait(t => t.split('\n').some(l => l.includes(`⬤ #${A}`) && l.includes(`⬤ #${B}`) && l.includes('fixed')), 60, 'dots')
  const at = term.find(`⬤ #${B}`)
  if (at) {
    const x = at[0] + 3, y = at[1]
    term.write(`\x1b[<35;${x};${y}M`) // the pointer rests on #B
    checks['hover card'] = await term.wait(t => t.includes(`github.com/${REPO}/pull/${B}`), 20, 'hover')
    term.write(`\x1b[<35;${x};${Math.max(1, y - 30)}M`)
    checks['card closes'] = await term.wait(t => !t.includes(`github.com/${REPO}/pull/${B}`), 10, 'unhover')
    term.write(`\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`) // a plain click tracks it
    checks['click tracks'] = await term.wait(() => bandChip(B) !== null, 20, 'click')
  } else {
    checks['hover card'] = false
  }

  // Alt+A gives the band the keyboard: ↓ moves the selection, c copies, x removes, Esc goes back.
  term.write('\x1ba')
  checks['keys'] = await term.wait(t => t.includes('x remove') && t.includes('esc back'), 15, 'keys')
  const before = selected()
  let after = before
  // ↓ stops at the last chip, ↑ at the first: whichever can move, moves.
  for (const key of ['\x1b[B', '\x1b[A']) {
    term.write(key)
    await sleep(1000)
    after = selected()
    if (after !== before) break
  }
  term.dump('arrow')
  console.log('selected after Alt+A:', before, 'after an arrow:', after)
  checks['arrows move the selection'] = before !== null && after !== null && before !== after
  term.write('c')
  await sleep(4000)
  checks[process.platform === 'win32' ? 'c copies a rich-text link' : 'c copies'] = copied(term, after)
  term.write('x')
  await sleep(2000)
  term.dump('removed')
  checks['x removes the selected chip'] = after !== null && bandChip(after) === null && bandChip(after === B ? A : B) !== null
  term.write('\x1b')
  await sleep(1500)
  checks['esc goes back'] = await term.wait(t => !t.includes('x remove'), 15, 'back')

  for (const n of [A, B]) if (bandChip(n)) await untrack(n)
  checks['untracked'] = await term.wait(t => !t.includes('Tracked PRs'), 20, 'untracked')
} finally {
  await term.stop()
}

report(checks)
