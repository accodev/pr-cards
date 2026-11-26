// The band checks of claude.spec.ts: a click tracks a reference, the bar folds the band, and the
// focus key, the arrows, `c` and `x` work on the selected chip.
import { copied, sleep, type Terminal } from './kit.ts'

// PRs of pullywog that stay put: A and B merged, C a markdown link.
export const A = 30, B = 32, C = 33

export function chipAt(term: Terminal, n: number): [number, number] | null {
  const lines = term.lines()
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row]
    // A band row starts with a group label, or with its blank space on a group's next rows.
    const bandRow = ['      needs you', '      waiting', '      done', ' '.repeat(16)].some(p => line.startsWith(p))
    if (line.includes(`⬤ #${n} `) && bandRow) return [line.indexOf(`#${n}`) + 2, row + 1]
  }
  return null
}

const click = (term: Terminal, x: number, y: number) => term.write(`\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`)

// The chip with a ▎ three cells before its # (design G1), when exactly one has it.
function picked(term: Terminal): number | null {
  const marks = new Map<number, boolean>()
  for (const n of [A, B]) {
    const at = chipAt(term, n)
    if (!at) return null
    marks.set(n, term.lines()[at[1] - 1][at[0] - 2 - 3] === '▎')
  }
  const on = [...marks].filter(([, m]) => m)
  return on.length === 1 ? on[0][0] : null
}

export async function checkBand(term: Terminal, checks: Record<string, boolean>, x: number, y: number): Promise<void> {
  click(term, x, y) // a plain click tracks the PR
  await sleep(2000)
  term.dump('3-click')
  let first = chipAt(term, A)
  checks['click tracks: chip and key row'] = first !== null && term.text().includes('x: remove')

  // Design P3: "Tracked PRs" on a bar of Claude Code's orange, bold; a click on it folds the band.
  let bar = 0
  term.lines().forEach((l, row) => {
    if (!l.startsWith('   ▾ Tracked PRs')) return
    const cell = term.cell(3, row)
    checks['bar has a background and bold'] = cell.bg !== 'default' && cell.bold
    bar = row + 1
  })
  if (bar) {
    click(term, 10, bar)
    await sleep(2000)
    term.dump('3-folded')
    const folded = chipAt(term, A) === null && term.text().includes('▸ Tracked PRs · 1')
    const again = term.lines().findIndex(l => l.includes('▸ Tracked PRs'))
    click(term, 10, again >= 0 ? again + 1 : bar)
    await sleep(2000)
    checks['bar folds and unfolds'] = folded && chipAt(term, A) !== null
  } else {
    checks['bar has a background and bold'] = false
  }

  // Track a second PR, select the first chip, focus the band, ↓ to the second, c copies, x removes.
  const second = term.find(`⬤ #${B}`)
  if (!first || !second) { checks['second PR tracked'] = false; return }
  click(term, second[0] + 3, second[1])
  await sleep(2000)
  first = chipAt(term, A)
  if (first) click(term, first[0], first[1])
  await sleep(1000)
  term.write('\x18\t') // Claude Code's default band focus key: ctrl+x, then tab
  await sleep(1000)
  term.dump('3a-focused')

  const before = picked(term)
  let after = before
  for (let i = 0; i < 3; i++) {
    term.write('\x1b[B')
    await sleep(1000)
    after = picked(term)
    if (after !== before) break
  }
  term.dump('3b-arrow')
  console.log('selected after the focus key:', before, 'after ↓:', after)
  checks['↓ moves the selection'] = before !== null && after !== null && before !== after

  term.write('c')
  await sleep(4000)
  checks[process.platform === 'win32' ? 'c copies a rich-text link' : 'c copies the link'] = copied(term, after)

  term.write('x')
  await sleep(2000)
  term.dump('3c-removed')
  checks['x removes the selected chip'] = after !== null && chipAt(term, after) === null && chipAt(term, after === B ? A : B) !== null
  for (let i = 0; i < 3; i++) { // leave nothing tracked
    if (!chipAt(term, A) && !chipAt(term, B)) break
    term.write('\x18\tx')
    await sleep(2000)
  }
}
