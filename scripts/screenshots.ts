// Renders the README images into PNGs under the given directory. The scenes use pullywog's own
// drawing code (pi/prs.ts and pi/card.ts, which draw the same chips, band and card in both agents)
// on fixed data, so the images change only when that code does. A headless Chromium takes the picture.
//
//   node --experimental-strip-types scripts/screenshots.ts <out-dir>
//
// CHROME names the browser; otherwise google-chrome, chromium, or Edge on Windows.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { bandLines, decorate, keyFor, type Checks, type Entry, type Item, type Style } from '../pi/prs.ts'
import { cardLines } from '../pi/card.ts'

type Layer = { row: number; col: number; lines: string[] }
type Scene = { rows: string[]; layers?: Layer[] }

// Everblush, the scheme of hairline's README images. Its bright black (#2D3437) hides dim text on
// the background in a small image: the images use a lighter one.
const PALETTE = [
  '#232A2D', '#E57474', '#8CCF7E', '#E5C76B', '#67B0E8', '#C47FD5', '#6CBFBF', '#B3B9B8',
  '#6B7375', '#EF7E7E', '#96D988', '#F4D67A', '#71BAF2', '#CE89DF', '#67CBE7', '#BDC3C2',
]
const FG = '#DADADA'
const BG = '#141B1E'
const CELL_W = 8 // Maple Mono at 10 pt, as in Windows Terminal
const CELL_H = 18
const PAD_X = 16
const PAD_Y = 14
const COLUMNS = 118

const outDir = resolve(process.argv[2] ?? 'screenshots')

// The 256-color cube and gray ramp, for the card's fill (236).
function color256(n: number): string {
  if (n < 16) return PALETTE[n]!
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return `rgb(${v},${v},${v})`
  }
  const c = n - 16
  const step = (x: number) => (x ? 55 + x * 40 : 0)
  return `rgb(${step(Math.floor(c / 36))},${step(Math.floor(c / 6) % 6)},${step(c % 6)})`
}

// Maple Mono has no ⬤: a browser takes it from a wider fallback font and shifts the rest of the
// row, where a terminal fits it in one cell. ● has the same look and fits.
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/⬤/g, '●')

// A line of text with SGR codes as HTML spans; OSC 8 links draw as their text.
function ansiToHtml(line: string): string {
  const bare = line.replace(/\x1b\]8;[^\x1b\x07]*(?:\x07|\x1b\\)/g, '')
  let fg: string | null = null
  let bg: string | null = null
  let bold = false
  let html = ''
  for (const part of bare.split(/(\x1b\[[0-9;]*m)/)) {
    const sgr = /^\x1b\[([0-9;]*)m$/.exec(part)
    if (!sgr) {
      if (!part) continue
      const style = [fg && `color:${fg}`, bg && `background:${bg}`, bold && 'font-weight:700'].filter(Boolean).join(';')
      html += style ? `<span style="${style}">${escape(part)}</span>` : escape(part)
      continue
    }
    const codes = (sgr[1] || '0').split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!
      if (c === 0) [fg, bg, bold] = [null, null, false]
      else if (c === 1) bold = true
      else if (c === 22) bold = false
      else if (c >= 30 && c <= 37) fg = PALETTE[c - 30]!
      else if (c >= 90 && c <= 97) fg = PALETTE[c - 90 + 8]!
      else if (c === 39) fg = null
      else if (c >= 40 && c <= 47) bg = PALETTE[c - 40]!
      else if (c >= 100 && c <= 107) bg = PALETTE[c - 100 + 8]!
      else if (c === 49) bg = null
      else if (c === 38 || c === 48) {
        // 38;5;n and 48;5;n pick from 256 colors, 38;2;r;g;b and 48;2;r;g;b give the color.
        const rgb = codes[i + 1] === 2
        const value = rgb ? `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})` : color256(codes[i + 2]!)
        if (c === 38) fg = value
        else bg = value
        i += rgb ? 4 : 2
      }
    }
  }
  return html
}

const heightOf = (scene: Scene) => Math.max(scene.rows.length, ...(scene.layers ?? []).map((l) => l.row + l.lines.length))

// One picture: rows of text, and boxes of text laid over them at a row and column.
function page(scene: Scene): string {
  const pre = (lines: string[], attrs = '') => `<pre${attrs}>${lines.map(ansiToHtml).join('\n')}</pre>`
  // A span's background covers the whole cell height, as a terminal fills it, with no seam between rows.
  const css = [
    `html, body { margin: 0; background: ${BG}; }`,
    `.term { position: relative; padding: ${PAD_Y}px ${PAD_X}px; width: ${COLUMNS * CELL_W}px; height: ${heightOf(scene) * CELL_H}px; }`,
    `pre { margin: 0; font: 13.3px/${CELL_H}px 'Maple Mono NF', 'Maple Mono', 'Cascadia Mono', monospace; color: ${FG}; white-space: pre; }`,
    `pre span { display: inline-block; height: ${CELL_H}px; vertical-align: top; }`,
    '.layer { position: absolute; }',
  ].join('\n')
  const over = (scene.layers ?? []).map((l) => pre(l.lines, ` class="layer" style="top:${PAD_Y + l.row * CELL_H}px;left:${PAD_X + l.col * CELL_W}px"`)).join('')
  return `<!doctype html><meta charset="utf-8"><style>${css}</style><div class="term">${pre(scene.rows)}${over}</div>`
}

// ---------- The scenes, on made-up repos and people ----------

const now = Date.now()
const ago = (days: number) => new Date(now - days * 86_400_000).toISOString()
const checks = (ok: number, failed: number, pending: number): Checks => ({ ok, failed, pending, total: ok + failed + pending })
const pr = (o: Partial<Item> & Pick<Item, 'number' | 'title' | 'state' | 'author' | 'when'>): Item => ({
  kind: 'pr', repo: 'acme/shop', url: `https://github.com/acme/shop/pull/${o.number}`, changesBy: [], approvedBy: [], requested: [], threads: [], failing: [], ...o,
})
const items: Record<number, Item> = {
  58: pr({ number: 58, title: 'Round the till total to the nearest cent', state: 'OPEN', author: 'lgreen', when: 'opened 2 days ago', created: ago(2), head: 'fix/till-rounding', base: 'main', additions: 48, deletions: 12, changedFiles: 3, review: 'REVIEW_REQUIRED', checks: checks(5, 1, 0), failing: [{ name: 'test (ubuntu)' }], approvedBy: ['mrossi'], threads: [{ path: 'till.ts', line: 40 }], requested: ['you'] }),
  61: pr({ number: 61, title: 'Add the receipt footer to the printer queue', state: 'OPEN', author: 'you', when: 'opened 5 hours ago', created: ago(0.2), additions: 120, deletions: 4, changedFiles: 6, checks: checks(4, 0, 2) }),
  64: pr({ number: 64, title: 'Bump the payment SDK to 7.2', state: 'DRAFT', author: 'dkim', when: 'opened 1 day ago', created: ago(1), additions: 8, deletions: 8, changedFiles: 2, checks: checks(6, 0, 0) }),
  52: pr({ number: 52, title: 'Cache the tax tables per store', state: 'MERGED', author: 'mrossi', when: 'merged 3 days ago', created: ago(6), additions: 210, deletions: 31, changedFiles: 9, checks: checks(6, 0, 0), approvedBy: ['you'] }),
  49: pr({ number: 49, title: 'Retry a failed card payment once', state: 'CLOSED', author: 'lgreen', when: 'closed 4 days ago', created: ago(9), additions: 30, deletions: 2, changedFiles: 1, checks: checks(5, 0, 0) }),
}
const lookup = (r: { number: number }): Entry | undefined => (items[r.number] ? { item: items[r.number], at: now, loading: false } : undefined)

const ESC = '\x1b'
const dim = (s: string) => `${ESC}[90m${s}${ESC}[39m`
const bold = (s: string) => `${ESC}[1m${s}${ESC}[22m`
// The bar as Claude Code draws it: bold, the theme's inverse text on its orange.
const style: Style = {
  bar: (s) => `${ESC}[48;2;215;119;87m${ESC}[38;2;20;27;30m${s}${ESC}[0m`,
  mark: (s) => `${ESC}[94m${s}${ESC}[39m`,
  bold,
}
const head = [`${bold('❯')} what is left before the release?`, '', `${dim('●')} Three PRs are open against main:`, '']
const reply = [
  decorate('  - #58 rounds the till total; one check fails and your review is asked for.', lookup),
  decorate('  - #61 adds the receipt footer; two checks are still running.', lookup),
  decorate('  - #64 bumps the payment SDK and is still a draft.', lookup),
  '',
  decorate('  #52 already went in, and #49 was closed in favour of #58.', lookup),
  '',
]

type Band = Parameters<typeof bandLines>[0]
const tracked = [52, 58, 61, 64].map((number) => ({ repo: 'acme/shop', number }))
const band = (over: Partial<Band> = {}) =>
  bandLines({ tracked, lookup, viewer: 'you', selected: keyFor('acme/shop', 58), armed: null, folded: false, perRow: 3, focused: false, ...over }, COLUMNS, style).lines
const prompt = ['', dim('─'.repeat(COLUMNS)), `${bold('❯')} `, dim('─'.repeat(COLUMNS))]

// The card opens upward from the reference under the pointer, #58 here, over the rows above it.
// Those rows stay blank in the images, so the card hides none of the reply.
const hovered = (lines: string[]) => ({
  rows: [...head, ...Array<string>(lines.length).fill(''), ...reply],
  layers: [{ row: head.length, col: 4, lines }],
})
const card = hovered(cardLines(items[58]!, 'card', 'you'))
const github = hovered(cardLines(items[58]!, 'github', 'you'))
const scenes: Record<string, Scene> = {
  // A reply with its references, the card of #58 open, and the tracked PRs above the prompt.
  'reply.png': { rows: [...card.rows, ...band(), ...prompt], layers: card.layers },
  'card-github.png': { rows: github.rows.slice(0, head.length + github.layers[0]!.lines.length + 1), layers: github.layers },
  'band.png': { rows: [...band({ focused: true }).slice(1), ...prompt] },
}

function browser(): string {
  if (process.env.CHROME) return process.env.CHROME
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    if (spawnSync(name, ['--version']).status === 0) return name
  }
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  if (existsSync(edge)) return edge
  throw new Error('no Chrome, Chromium or Edge: set CHROME')
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

// A profile of its own per shot, so the browser does not join a running one. Edge on Windows can
// stay open after it saved the shot: wait until the file stops growing, then end it.
async function shoot(exe: string, html: string, shot: string, size: string) {
  rmSync(shot, { force: true })
  const child = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${html}.profile`,
    '--force-device-scale-factor=2', `--window-size=${size}`, `--screenshot=${shot}`, `file:///${html.replace(/\\/g, '/')}`,
  ], { stdio: 'ignore' })
  const exited = new Promise((done) => child.on('exit', done))
  let last = -1
  for (const end = Date.now() + 60_000; Date.now() < end; ) {
    await sleep(250)
    const bytes = existsSync(shot) ? statSync(shot).size : -1
    if (bytes > 0 && bytes === last) break
    last = bytes
  }
  child.kill()
  await exited
  if (!existsSync(shot)) throw new Error(`no ${shot}`)
}

mkdirSync(outDir, { recursive: true })
const work = join(tmpdir(), `pullywog-shots-${process.pid}`)
mkdirSync(work, { recursive: true })
const exe = browser()
for (const [name, scene] of Object.entries(scenes)) {
  const html = join(work, name.replace('.png', '.html'))
  writeFileSync(html, page(scene))
  const size = `${COLUMNS * CELL_W + 2 * PAD_X},${heightOf(scene) * CELL_H + 2 * PAD_Y}`
  await shoot(exe, html, join(outDir, name), size)
  console.log(join(outDir, name))
}
rmSync(work, { recursive: true, force: true })
