// What claude.spec.ts and pi.spec.ts share: a pseudo-terminal, its screen, the env and the report.
// The fake model lives in model.ts.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import pty from '@lydell/node-pty'
import xterm from '@xterm/headless'

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
export const OUT = join(ROOT, 'e2e-out')
// pullywog's own PRs: they stay put, and no work repo shows up in a CI log.
export const REPO = process.env.E2E_REPO ?? 'accodev/pullywog'

export const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

// ConPTY needs a full path: on Windows `claude` and `pi` are .cmd shims that a bare name misses.
function which(name: string, path: string | undefined): string {
  if (process.platform !== 'win32') return name
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
  for (const dir of (path ?? '').split(delimiter)) {
    for (const ext of exts) {
      const file = join(dir, name + ext)
      if (existsSync(file)) return file
    }
  }
  return name
}

export type Cell = { ch: string, bold: boolean, bg: string, fg: string }

// A program in a pseudo-terminal, read into an xterm screen. `raw` keeps the bytes for the escapes
// the screen does not expose: OSC 8 hyperlinks and OSC 52 clipboard writes.
export class Terminal {
  readonly rows: number
  readonly cols: number
  private readonly prefix: string
  private readonly screen: xterm.Terminal
  private readonly proc: pty.IPty
  raw = ''
  private alive = true

  constructor(argv: string[], cwd: string, env: Record<string, string>, rows: number, cols: number, prefix = '') {
    mkdirSync(OUT, { recursive: true })
    this.rows = rows
    this.cols = cols
    this.prefix = prefix
    this.screen = new xterm.Terminal({ cols, rows, allowProposedApi: true })
    this.proc = pty.spawn(which(argv[0], env.PATH ?? env.Path), argv.slice(1), { name: 'xterm-256color', cols, rows, cwd, env })
    this.proc.onData(data => { this.raw += data; this.screen.write(data) })
    this.proc.onExit(() => { this.alive = false })
  }

  write(s: string): void { this.proc.write(s) }

  async send(s: string, gap = 20): Promise<void> {
    for (const ch of s) { this.proc.write(ch); await sleep(gap) }
  }

  lines(): string[] {
    const buffer = this.screen.buffer.active
    const lines: string[] = []
    for (let y = 0; y < this.rows; y++) lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '')
    return lines
  }

  text(): string { return this.lines().join('\n') }

  // A cell by zero-based screen column and row. A color reads "default", "p<n>" for a palette entry,
  // or six hex digits for 24-bit.
  cell(x: number, y: number): Cell {
    const buffer = this.screen.buffer.active
    const c = buffer.getLine(buffer.viewportY + y)?.getCell(x)
    if (!c) return { ch: '', bold: false, bg: 'default', fg: 'default' }
    const color = (dflt: boolean, palette: boolean, n: number) =>
      dflt ? 'default' : palette ? `p${n}` : n.toString(16).padStart(6, '0')
    return {
      ch: c.getChars(), bold: c.isBold() !== 0,
      bg: color(c.isBgDefault(), c.isBgPalette(), c.getBgColor()),
      fg: color(c.isFgDefault(), c.isFgPalette(), c.getFgColor()),
    }
  }

  dump(name: string): void { writeFileSync(join(OUT, this.prefix + name + '.txt'), this.text()) }

  async wait(pred: (text: string) => boolean, seconds: number, label: string): Promise<boolean> {
    const end = Date.now() + seconds * 1000
    while (Date.now() < end) {
      if (pred(this.text())) { this.dump(label); return true }
      await sleep(500)
    }
    this.dump('fail-' + label)
    console.log('TIMEOUT', label)
    return false
  }

  find(s: string): [number, number] | null {
    const lines = this.lines()
    for (let y = 0; y < lines.length; y++) {
      const x = lines[y].indexOf(s)
      if (x >= 0) return [x + 1, y + 1]
    }
    return null
  }

  // OSC 8 may carry an id before the second `;`.
  links(): Set<string> {
    return new Set([...this.raw.matchAll(/\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)/g)].map(m => m[1]))
  }

  // The texts of every OSC 52 clipboard write.
  clipboardWrites(): string[] {
    return [...this.raw.matchAll(/\x1b\]52;[^;]*;([A-Za-z0-9+/=]+)/g)].map(m => Buffer.from(m[1], 'base64').toString('utf8'))
  }

  async stop(): Promise<void> {
    for (let i = 0; i < 2 && this.alive; i++) { this.proc.write('\x03'); await sleep(500) }
    if (this.alive) this.proc.kill()
  }
}

// The Windows clipboard as HTML (last line) and as plain text, split by `---`.
export function windowsClipboard(): { html: string, text: string } {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -TextFormatType Html | Select-Object -Last 1; '---'; Get-Clipboard -TextFormatType UnicodeText"],
  { encoding: 'utf8' })
  const at = out.lastIndexOf('---')
  return { html: out.slice(0, at), text: out.slice(at + 3) }
}

// `c` copies the selected PR: the Windows clipboard holds a rich-text link; elsewhere the plain text
// goes out as an OSC 52 write, or the mod shows its own notice where the host takes the copy another way.
export function copied(term: Terminal, n: number | null): boolean {
  if (process.platform === 'win32') {
    const clip = windowsClipboard()
    return clip.html.includes(`#${n}</a>`) && clip.text.includes(`/${n}`)
  }
  return term.clipboardWrites().some(t => t.includes(`/${n}`)) || term.text().includes(`copied ${REPO}#${n}`)
}

// A fresh folder for one run's agent config, so every run starts the same way.
export const scratch = (name: string): string => mkdtempSync(join(tmpdir(), `pullywog-${name}-`))

export function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  // A run started from inside Claude Code inherits its session markers, which change how it starts.
  for (const name of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT']) delete env[name]
  // 256 colors keep the card's gray a palette entry (236), so the check reads one value on every host.
  delete env.COLORTERM
  env.FORCE_COLOR = '2'
  env.TERM = 'xterm-256color'
  return env
}

export function report(checks: Record<string, boolean>): never {
  for (const [name, ok] of Object.entries(checks)) console.log((ok ? 'PASS ' : 'FAIL ') + name)
  const passed = Object.values(checks).filter(Boolean).length
  console.log(`${passed} of ${Object.keys(checks).length} passed`)
  process.exit(passed && passed === Object.keys(checks).length ? 0 : 3)
}
