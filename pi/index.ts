import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { copyToClipboard, getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { matchesKey, type Component, type TUI } from '@earendil-works/pi-tui'
import { CARD_WIDTH, cardLines, errorCard } from './card.ts'
import { watchPointer } from './pointer.ts'
import {
  BATCH, bandLines, fresh, readGh, decorate, findRefs, keyFor, label, linkFormats, listName, pruned, query, refAt, runIds, sameList, savedItems, step,
  toItem, withTracked, withoutTracked, type Band, type Entry, type Hit, type Raw, type Ref, type SavedList, type Style, type Tracked,
} from './prs.ts'

// Another session may change a shared list: the band reads the file again this often.
const SHARED_READ_MS = 5_000
// The band refreshes its PRs' checks and reviews this often.
const REFRESH_MS = 60_000
const FOCUS_KEY = 'alt+a'

type Settings = { cardStyle: 'card' | 'github'; trackedBand: boolean; perRow: number; share: boolean }
function readSettings(raw: unknown): Settings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const off = (v: unknown) => v === false || String(v).toLowerCase() === 'false'
  return {
    cardStyle: String(o.cardStyle ?? 'card').trim().toLowerCase() === 'github' ? 'github' : 'card',
    trackedBand: !off(o.trackedBand), perRow: Math.max(1, Math.min(6, Math.round(Number(o.bandPerRow) || 3))), share: !off(o.shareTracked),
  }
}

// The system's own handler opens a page, as Pi does for a link.
function openUrl(url: string) {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => undefined).unref()
}

// Every Pi session's tracked lists, in one file as the Claude Code mod keeps them in its store.
type Store = { lists?: Record<string, SavedList> }
const storePath = () => join(getAgentDir(), 'pullywog.json')
function readStore(): Store {
  try {
    const raw = JSON.parse(readFileSync(storePath(), 'utf8')) as Store
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}
// A rename puts the whole file down at once: a session reading meanwhile sees the old one or the new one.
function writeStore(store: Store) {
  const tmp = `${storePath()}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(store))
  renameSync(tmp, storePath())
}

type Run = { code: number; stdout: string; stderr: string }
function run(argv: string[], options: { cwd?: string; stdin?: string; timeoutMs?: number } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 20_000)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(err) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
    child.stdin.end(options.stdin ?? '')
  })
}

// Windows PowerShell 5.1 puts both formats on the clipboard in one data object: HTML for chats such
// as Teams, plain text for everything else. It reads them as JSON on stdin, so no quoting reaches a shell.
const CLIPBOARD_PS =
  "[Console]::InputEncoding=[Text.Encoding]::UTF8; $in=[Console]::In.ReadToEnd() | ConvertFrom-Json; " +
  'Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.DataObject; ' +
  "$d.SetData('HTML Format', $in.html); $d.SetData('UnicodeText', $in.text); " +
  '[System.Windows.Forms.Clipboard]::SetDataObject($d, $true)'

export default function pullywog(pi: ExtensionAPI) {
  let settings = readSettings(undefined)
  let ctx: ExtensionContext | undefined
  let tui: TUI | undefined
  let cwd = process.cwd()
  let sessionId = ''
  // The session folder's GitHub repo: undefined until asked, null when it has none.
  let cwdRepo: string | null | undefined
  let viewer = ''
  const cache = new Map<string, Entry>()
  const queue = new Map<string, Set<number>>()
  let flushQueued = false
  // References in this session's replies, newest last, for /track's completions.
  const seen = new Map<string, Ref>()
  // Keys the transcript asked for before GitHub answered: the replies holding them draw again once it has.
  const asked = new Set<string>()

  let tracked: Tracked[] = []
  let listKey: string | null = null
  let selected: string | null = null
  // Approving is seen by others on GitHub: the first press arms it, the second sends it.
  let armed: string | null = null
  let folded = false
  // While the band has the keyboard it draws in the editor's place, and the widget draws nothing.
  let focused = false
  let timers: NodeJS.Timeout[] = []
  // The stdin reader for hover and click on references, one per TUI.
  let pointerTui: TUI | undefined
  let stopPointer: (() => void) | undefined

  const redraw = () => tui?.requestRender()
  const repoOf = (r: Ref) => r.repo ?? cwdRepo
  const lookup = (r: Ref) => {
    const repo = repoOf(r)
    return repo ? cache.get(keyFor(repo, r.number)) : undefined
  }

  function askRepo() {
    if (cwdRepo !== undefined) return Promise.resolve(cwdRepo)
    return run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd, timeoutMs: 15_000 }).then((out) => {
      cwdRepo = out.code === 0 && out.stdout.trim() ? out.stdout.trim() : null
      redraw()
      return cwdRepo
    })
  }

  function want(r: Ref, force = false) {
    const repo = repoOf(r)
    if (repo === undefined) return void askRepo().then(() => want(r, force))
    if (repo === null) return
    const key = keyFor(repo, r.number)
    const hit = cache.get(key)
    if (!force && fresh(hit)) return
    cache.set(key, { ...hit, at: Date.now(), loading: true })
    queue.set(repo, (queue.get(repo) ?? new Set()).add(r.number))
    if (flushQueued) return
    flushQueued = true
    // Every reference asked for in one pass goes out as one query per repo.
    queueMicrotask(() => void flush())
  }

  async function flush() {
    flushQueued = false
    const jobs = [...queue].flatMap(([repo, numbers]) => {
      const all = [...numbers]
      const chunks: { repo: string; numbers: number[] }[] = []
      for (let i = 0; i < all.length; i += BATCH) chunks.push({ repo, numbers: all.slice(i, i + BATCH) })
      return chunks
    })
    queue.clear()
    await Promise.all(jobs.map((j) => fetchChunk(j.repo, j.numbers)))
    const answered = jobs.some((j) => j.numbers.some((n) => asked.delete(keyFor(j.repo, n))))
    // Pi keeps each message's drawn lines: invalidating them runs the transformer again.
    if (answered) tui?.invalidate()
    tui?.requestRender(answered)
  }

  async function fetchChunk(repo: string, numbers: number[]) {
    // A failure keeps the last good answer on the chip and the card, and only marks it for a retry.
    const fail = (error: string) => numbers.forEach((n) => cache.set(keyFor(repo, n), { ...cache.get(keyFor(repo, n)), at: Date.now(), loading: false, error }))
    // The query goes in on stdin: a batch of 40 passes Windows' 32,767-character command line.
    const out = await run(['gh', 'api', 'graphql', '--input', '-'], { stdin: JSON.stringify({ query: query(repo, numbers) }) })
    try {
      const read = readGh<{ data?: { viewer?: { login: string }; repository?: Record<string, Raw | null> | null }; errors?: { message: string }[] }>(out.stdout, out.stderr, out.code)
      if ('error' in read) return fail(read.error)
      const body = read.body
      viewer = body.data?.viewer?.login ?? viewer
      const found = body.data?.repository
      if (!found) return fail(body.errors?.[0]?.message ?? (out.stderr.trim().split('\n')[0] || `gh exited ${out.code}`))
      for (const n of numbers) {
        const raw = found[`n${n}`]
        cache.set(keyFor(repo, n), raw ? { at: Date.now(), loading: false, item: toItem(repo, raw) } : { at: Date.now(), loading: false, missing: true })
      }
    } catch (err) {
      fail(String(err))
    }
  }

  // ---------- The tracked list ----------

  async function loadList() {
    listKey = listName(settings.share, sessionId, settings.share ? await askRepo() : null, cwd)
    const store = readStore()
    tracked = savedItems(store.lists?.[listKey])
    writeStore({ ...store, lists: pruned(store.lists ?? {}, listKey) })
    for (const t of tracked) want(t)
    redraw()
  }

  // Applies one change to the list as the file holds it now, not to this session's copy: a copy
  // another session changed since would otherwise be written back whole, undoing that change.
  function change(edit: (items: Tracked[]) => Tracked[]) {
    tracked = edit(tracked)
    if (listKey) {
      const store = readStore()
      tracked = edit(savedItems(store.lists?.[listKey]))
      writeStore({ ...store, lists: { ...store.lists, [listKey]: { at: Date.now(), items: tracked } } })
    }
    if (selected && !tracked.some((t) => keyFor(t.repo, t.number) === selected)) selected = null
    redraw()
  }

  function reread() {
    if (!settings.share || !listKey) return
    const items = savedItems(readStore().lists?.[listKey])
    if (sameList(items, tracked)) return
    tracked = items
    if (selected && !tracked.some((t) => keyFor(t.repo, t.number) === selected)) selected = null
    for (const t of tracked) want(t)
    redraw()
  }

  async function track(r: Ref) {
    const repo = r.repo ?? (await askRepo())
    if (!repo) return ctx?.ui.notify(`${label(r)} names no repo, and this folder has none`, 'warning')
    const t = { repo, number: r.number }
    selected = keyFor(repo, r.number)
    change((items) => withTracked(items, t))
    want(t)
  }

  // ---------- Actions on the selected PR ----------

  async function act(argv: string[], done: string) {
    const out = await run(argv, { cwd, timeoutMs: 60_000 })
    ctx?.ui.notify(out.code === 0 ? done : `${argv.slice(0, 3).join(' ')} failed: ${out.stderr.trim().split('\n')[0] || `exit ${out.code}`}`, out.code === 0 ? 'info' : 'error')
  }

  async function copyLink(key: string) {
    const item = cache.get(key)?.item
    if (!item) return
    const { name, html, text } = linkFormats(item)
    if (process.platform === 'win32') {
      const out = await run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', CLIPBOARD_PS], { stdin: JSON.stringify({ html, text }), timeoutMs: 15_000 })
      if (out.code === 0) return ctx?.ui.notify(`copied ${name} as a link`, 'info')
    }
    await copyToClipboard(text)
    ctx?.ui.notify(`copied ${name} as plain text`, 'info')
  }

  // One key on the selected chip. Returns false for a key the band does not use.
  function press(data: string): boolean {
    const band = bandState()
    const move = (by: number) => { selected = step(band, by); armed = null; redraw() }
    if (matchesKey(data, 'up') || matchesKey(data, 'left') || matchesKey(data, 'shift+tab')) return move(-1), true
    if (matchesKey(data, 'down') || matchesKey(data, 'right') || matchesKey(data, 'tab')) return move(1), true
    const key = selected
    const item = key ? cache.get(key)?.item : undefined
    if (!key) return false
    if (data === 'x') return change((items) => withoutTracked(items, key)), true
    if (!item) return false
    const web = ['gh', item.kind === 'pr' ? 'pr' : 'issue', 'view', String(item.number), '--repo', item.repo, '--web']
    const refresh = () => want(item, true)
    const isOpen = item.kind === 'pr' && (item.state === 'OPEN' || item.state === 'DRAFT')
    if (data === 'a' && isOpen && item.author !== viewer) {
      if (armed !== key) return (armed = key), redraw(), true
      armed = null
      void act(['gh', 'pr', 'review', String(item.number), '--repo', item.repo, '--approve'], `approved #${item.number}`).then(refresh)
      return true
    }
    // A review that asks for changes needs a comment: it opens the PR in the browser.
    if (data === 'r' && isOpen && item.author !== viewer) return void act(web, `opened #${item.number} to request changes`), true
    if (data === 'f' && runIds(item).length) {
      void (async () => {
        for (const id of runIds(item)) await act(['gh', 'run', 'rerun', id, '--failed', '--repo', item.repo], `re-running the failed jobs of #${item.number}`)
        refresh()
      })()
      return true
    }
    if (data === 'o') return void act(web, `opened #${item.number}`), true
    if (data === 'c') return void copyLink(key), true
    return false
  }

  // ---------- Drawing ----------

  const bandState = (): Band => ({ tracked, lookup, viewer, selected, armed, folded, perRow: settings.perRow, focused })

  function bandComponent(style: Style, keyboard: boolean): Component {
    let hits: Hit[] = []
    return {
      render(width) {
        if (focused !== keyboard) return []
        const drawn = bandLines(bandState(), width, style)
        hits = drawn.hits
        return drawn.lines
      },
      handleMouse(e) {
        if (e.type !== 'press' || e.button !== 'left') return undefined
        const hit = hits.find((h) => h.row === e.y && e.x >= h.from && e.x < h.to)
        if (!hit) return undefined
        if (hit.target === 'bar') folded = !folded
        else { selected = hit.target; armed = null }
        redraw()
        return { handled: true }
      },
      invalidate() {},
    }
  }

  function showWidget(c: ExtensionContext) {
    if (c.mode !== 'tui') return
    if (!settings.trackedBand) return c.ui.setWidget('pullywog', undefined)
    c.ui.setWidget('pullywog', (t, theme) => {
      tui = t
      if (pointerTui !== t) {
        stopPointer?.()
        pointerTui = t
        stopPointer = watchPointer(t, {
          width: CARD_WIDTH,
          cardFor: (r) => {
            const entry = lookup(r)
            return entry?.item ? cardLines(entry.item, settings.cardStyle, viewer) : entry?.error ? errorCard(entry.error) : undefined
          },
          want: (r) => want(r),
          track: (r) => void track(r),
          open: (r) => {
            const repo = r.repo ?? cwdRepo
            if (repo) openUrl(lookup(r)?.item?.url ?? `https://github.com/${repo}/issues/${r.number}`)
          },
        })
      }
      return bandComponent({ bar: (s) => theme.inverse(theme.fg('accent', s)), mark: (s) => theme.fg('accent', s), bold: (s) => theme.bold(s) }, false)
    }, { placement: 'aboveEditor' })
  }

  // The keyboard path: the band takes the editor's place until Esc.
  async function focusBand(c: ExtensionContext) {
    if (c.mode !== 'tui' || !tracked.length) return
    focused = true
    selected ??= step(bandState(), 1)
    redraw()
    await c.ui.custom<void>((t, theme, _keys, done) => {
      const inner = bandComponent({ bar: (s) => theme.inverse(theme.fg('accent', s)), mark: (s) => theme.fg('accent', s), bold: (s) => theme.bold(s) }, true)
      return {
        ...inner,
        render: (width) => inner.render(width),
        handleInput(data) {
          if (matchesKey(data, 'escape') || !tracked.length) return done()
          if (press(data)) t.requestRender()
        },
      }
    })
    focused = false
    armed = null
    redraw()
  }

  // ---------- References in the transcript ----------

  // Pi draws the transcript itself: each known reference gets its state's dot and becomes a link.
  // A reference not loaded yet is asked for, and draws once Pi draws the message again.
  pi.registerMarkdownTransformer((md) => {
    for (const f of findRefs(md)) {
      const repo = repoOf(f)
      if (repo === undefined) {
        void askRepo().then((r) => r && (asked.add(keyFor(r, f.number)), want(f)))
        continue
      }
      if (repo && !cache.get(keyFor(repo, f.number))?.item) asked.add(keyFor(repo, f.number))
      want(f)
    }
    return decorate(md, lookup)
  }, { messageTypes: ['assistant'] })

  function remember(text: string) {
    for (const f of findRefs(text)) {
      const k = label(f)
      seen.delete(k)
      seen.set(k, { repo: f.repo, number: f.number })
    }
  }
  const textOf = (message: unknown) => {
    const m = message as { role?: string; content?: unknown } | undefined
    if (m?.role !== 'assistant') return ''
    if (typeof m.content === 'string') return m.content
    return Array.isArray(m.content) ? m.content.flatMap((c: { type?: string; text?: string }) => (c?.type === 'text' && c.text ? [c.text] : [])).join('\n') : ''
  }

  pi.on('message_end', (e) => remember(textOf(e.message)))

  const parseRef = (arg: string): Ref | null => {
    const f = findRefs(arg.trim())[0]
    if (f) return { repo: f.repo, number: f.number }
    const n = /^\d+$/.exec(arg.trim())
    return n ? { repo: null, number: Number(n[0]) } : null
  }
  const completions = (prefix: string, refs: Ref[]) =>
    refs.map((r) => {
      const item = lookup(r)?.item
      return { value: label(r), label: label(r), description: item?.title }
    }).filter((c) => c.value.toLowerCase().includes(prefix.trim().replace(/^#/, '').toLowerCase()))

  pi.registerCommand('track', {
    description: 'Track a PR or issue in the band above the editor: #1234, owner/repo#1234 or a GitHub URL',
    getArgumentCompletions: (prefix) => completions(prefix, [...seen.values()].reverse()),
    handler: async (args, c) => {
      ctx = c
      let ref = parseRef(args)
      if (!ref && !args.trim()) {
        const options = [...seen.keys()].reverse()
        if (!options.length) return c.ui.notify('no PR references in this session yet: /track #1234', 'info')
        const pick = await c.ui.select('Track which?', options)
        ref = pick ? seen.get(pick) ?? null : null
      }
      if (!ref) return args.trim() ? c.ui.notify(`${args.trim()} is no PR reference`, 'warning') : undefined
      await track(ref)
    },
  })

  pi.registerCommand('untrack', {
    description: 'Stop tracking a PR or issue',
    getArgumentCompletions: (prefix) => completions(prefix, tracked.map((t) => ({ repo: t.repo, number: t.number }))),
    handler: async (args, c) => {
      ctx = c
      const ref = parseRef(args)
      const repo = ref ? ref.repo ?? (await askRepo()) : null
      if (!ref || !repo) return c.ui.notify('/untrack owner/repo#1234', 'info')
      change((items) => withoutTracked(items, keyFor(repo, ref.number)))
    },
  })

  pi.registerShortcut(FOCUS_KEY, {
    description: 'Move to the tracked PRs: arrows pick one, a key acts on it',
    handler: (c) => focusBand(c),
  })

  pi.on('session_start', async (_e, c) => {
    ctx = c
    cwd = c.cwd
    sessionId = c.sessionManager.getSessionId()
    settings = readSettings((pi.getSettings() as Record<string, unknown>).pullywog)
    for (const entry of c.sessionManager.getEntries() as { type?: string; message?: unknown }[]) {
      if (entry.type === 'message') remember(textOf(entry.message))
    }
    showWidget(c)
    await loadList()
    timers.forEach(clearInterval)
    timers = [
      setInterval(reread, SHARED_READ_MS),
      setInterval(() => tracked.forEach((t) => want(t)), REFRESH_MS),
    ]
  })

  pi.on('session_shutdown', async () => {
    stopPointer?.()
    stopPointer = undefined
    pointerTui = undefined
    timers.forEach(clearInterval)
    timers = []
  })
}
