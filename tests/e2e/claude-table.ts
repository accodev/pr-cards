// The long table check of claude.spec.ts: 15 PRs, the reply that once crashed the hooks worker.
import { REPO, sleep, type Terminal } from './kit.ts'

export const LIST = Array.from({ length: 15 }, (_, i) => 16 + i)
const HOVER_ROW = 25

export async function checkTable(term: Terminal, checks: Record<string, boolean>): Promise<void> {
  term.write('/clear\r')
  await sleep(3000)
  await term.send('PULLYWOG_E2E_LIST')
  await sleep(500)
  term.write('\r')
  await term.wait(t => t.includes('Title') && t.split('⬤').length - 1 >= 15, 120, 'list')
  await sleep(10000)
  term.dump('4-list')
  const colors: string[] = []
  for (let r = 0; r < term.rows; r++) for (let c = 0; c < term.cols; c++) {
    const cell = term.cell(c, r)
    if (cell.ch === '⬤') colors.push(cell.fg)
  }
  const text = term.text()
  const pending = text.split('○').length - 1 // a hollow dot is still loading
  const failed = [...text.matchAll(/(?<!\w)x #\d/g)].length // a cross is a failed lookup
  console.log('list dots:', colors.length, 'colors:', [...new Set(colors)].sort(), 'loading:', pending, 'failed:', failed)
  checks['long table: 15 dots, all loaded'] = !text.includes('crashed') && colors.length >= 15 && !pending && !failed

  const lines = term.lines()
  const top = lines.findIndex(l => l.includes('┌'))
  const bottom = top < 0 ? -1 : lines.findIndex((l, i) => i > top && l.includes('└'))
  let aligned = false
  if (top >= 0 && bottom >= 0) {
    const left = lines[top].indexOf('┌'), right = lines[top].lastIndexOf('┐')
    aligned = lines.slice(top + 1, bottom + 1).every(l => '│├└'.includes(l[left] || ' ') && '│┤┘'.includes(l[right] || ' '))
  }
  checks['long table keeps its borders'] = aligned

  const row = term.find(`⬤ ${HOVER_ROW}`)
  if (!row) { checks['table number opens a card with links'] = false; return }
  term.write(`\x1b[<35;${row[0] + 3};${row[1]}M`)
  await sleep(2000)
  term.dump('5-list-hover')
  const targets = term.links()
  const pr = `https://github.com/${REPO}/pull/${HOVER_ROW}`
  checks['table number opens a card with links'] = term.text().includes(`${REPO} #${HOVER_ROW}`)
    && targets.has(`https://github.com/${REPO}`) && targets.has(pr + '/files') && targets.has(pr + '/checks')
}
