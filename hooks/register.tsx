import type { EngineInterface, Register, RenderElement, RenderSurface } from 'claude-code'

type Checks = { ok: number; failed: number; pending: number; total: number }
type Item = {
  kind: 'pr' | 'issue'
  number: number
  repo: string
  title: string
  url: string
  // PR: OPEN | MERGED | CLOSED | DRAFT. Issue: OPEN | COMPLETED | NOT_PLANNED.
  state: string
  author: string
  // `opened 2 days ago`, `merged 3 hours ago`...
  when: string
  // When it was opened, ISO, and for a PR its head and base branch.
  created?: string
  head?: string
  base?: string
  additions?: number
  deletions?: number
  changedFiles?: number
  review?: string
  checks?: Checks
  // The failing checks, each with the page of its run.
  failing?: { name: string; url?: string }[]
  approvedBy?: string[]
  changesBy?: string[]
  // The users whose review is asked for and not given yet.
  requested?: string[]
  threads?: { path: string; line: number | null }[]
  files?: { path: string; additions: number; deletions: number }[]
  comments?: number
}
// `missing`: GitHub has no PR or issue with that number, so the text was no reference after all.
type Entry = { item?: Item; error?: string; missing?: boolean; at: number; loading: boolean }
type Ref = { repo: string | null; number: number; label: string }

const TTL_MS = 60_000
const BATCH = 40
// `#1234`, `owner/repo#1234` or a GitHub pull or issue URL; a `#` after a word character, `[`, `#` or `/` is a heading, an anchor or a link label.
const REF = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)|(?<![\w[#/])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g
// The PR or issue a GitHub URL names, for a markdown link's target.
const GITHUB_ITEM = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)(?:[/?#].*)?$/
// A table column of bare numbers is a list of PRs or issues when its header says so.
const NUMBER_HEADER = /^(#|pr|prs|pull|issue|issues|number|no\.?)$/i
const C = { open: 'ansi256(2)', merged: 'ansi256(5)', closed: 'ansi256(1)', draft: 'ansi256(8)', warn: 'ansi256(3)', link: 'ansi256(4)', dim: 'ansi256(8)', code: 'ansi256(6)' }
const STATE_COLOR: Record<string, string> = { OPEN: C.open, DRAFT: C.draft, MERGED: C.merged, CLOSED: C.closed, COMPLETED: C.merged, NOT_PLANNED: C.draft }
const STATE_WORD: Record<string, string> = { OPEN: 'Open', DRAFT: 'Draft', MERGED: 'Merged', CLOSED: 'Closed', COMPLETED: 'Closed', NOT_PLANNED: 'Not planned' }
const REVIEW_WORD: Record<string, string> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'review required' }
const DOT = '⬤'
const CARD_WIDTH = 66
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// `Nov 18`, as GitHub dates a card; the year only when it is not this one.
const day = (iso?: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  const year = d.getUTCFullYear() === new Date().getUTCFullYear() ? '' : `, ${d.getUTCFullYear()}`
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${year}`
}

const cache = new Map<string, Entry>()
// The session folder's GitHub repo: undefined until asked, null when it has none.
let cwdRepo: string | null | undefined
const queue = new Map<string, Set<number>>()
let flushQueued = false
// The signed-in GitHub user: their own reviews read "you", as in the mockup.
let viewer = ''

// The PRs and issues a click on a reference tracked, for the band above the prompt, in the mod's
// store (shared by every session). With `shareTracked` on, the sessions of one GitHub repo share a
// list, `tracked.repo.<owner/name>`, its worktrees and clones included; a folder outside git has
// `tracked.dir.<path>`. Off, each session keeps `tracked.<session id>`. `selected` is the focused chip.
type Tracked = { repo: string; number: number }
type SavedList = { at: number; items: Tracked[] }
let tracked: Tracked[] = []
let trackedLoaded = false
let listKey: string | null = null
let shareTracked = true
let listReadAt = 0
let selected: string | null = null
// Approving is seen by others on GitHub: the first press arms it, the second sends it.
let armed: string | null = null
// The band shows only its title bar, for this session, after a click on it.
let folded = false
// A saved list goes once no session has used it for this long.
const TRACKED_TTL_MS = 14 * 86_400_000
// Another session may change a shared list: the band reads it again this often.
const SHARED_READ_MS = 5_000

const isTracked = (t: unknown): t is Tracked => !!t && typeof (t as Tracked).repo === 'string' && typeof (t as Tracked).number === 'number'
const savedItems = (saved: unknown) => (Array.isArray((saved as SavedList | undefined)?.items) ? (saved as SavedList).items.filter(isTracked) : [])

async function trackedKey($: EngineInterface) {
  if (!shareTracked) return `tracked.${await $.session.id()}`
  const repo = await cwdRepoNow($)
  return repo ? `tracked.repo.${repo}` : `tracked.dir.${await $.session.cwd()}`
}

function loadTracked($: EngineInterface) {
  if (trackedLoaded) return
  trackedLoaded = true
  void (async () => {
    listKey = await trackedKey($)
    const earlier = savedItems(await $.store.get(listKey))
    listReadAt = Date.now()
    // A click before the list came back is kept, after what the list held before.
    const clicked = tracked.filter((t) => !earlier.some((e) => keyFor(e.repo, e.number) === keyFor(t.repo, t.number)))
    tracked = [...earlier, ...clicked]
    if (clicked.length) changeTracked($, (items) => [...items, ...clicked.filter((c) => !items.some((t) => keyFor(t.repo, t.number) === keyFor(c.repo, c.number)))])
    $.ui.invalidate('ui.render')
    // An idle session draws nothing, so its band would keep a list other sessions changed: read
    // the shared list on a timer too.
    if (shareTracked) $.clock.every(SHARED_READ_MS, () => { listReadAt = 0; rereadTracked($) })
    // Drop the lists idle past TRACKED_TTL_MS, and the one list 0.4 and 0.5 shared.
    for (const key of await $.store.keys()) {
      if (key === 'tracked') await $.store.delete(key)
      else if (key.startsWith('tracked.') && key !== listKey) {
        const other = (await $.store.get(key)) as SavedList | undefined
        if (!other || typeof other.at !== 'number' || Date.now() - other.at > TRACKED_TTL_MS) await $.store.delete(key)
      }
    }
  })().catch(() => undefined)
}

// A shared list changes in other sessions too: read it again, at most every SHARED_READ_MS.
function rereadTracked($: EngineInterface) {
  if (!shareTracked || !listKey || Date.now() - listReadAt < SHARED_READ_MS) return
  listReadAt = Date.now()
  const key = listKey
  void $.store.get(key).then((saved) => {
    const items = savedItems(saved)
    const same = items.length === tracked.length && items.every((t, i) => keyFor(t.repo, t.number) === keyFor(tracked[i]!.repo, tracked[i]!.number))
    if (same || key !== listKey) return
    tracked = items
    if (selected && !tracked.some((t) => keyFor(t.repo, t.number) === selected)) selected = null
    $.ui.invalidate('ui.render')
  }).catch(() => undefined)
}

// Applies one change to the list as the store holds it now, not to this session's copy: a copy
// another session changed since would otherwise be written back whole, undoing that change.
function changeTracked($: EngineInterface, change: (items: Tracked[]) => Tracked[]) {
  tracked = change(tracked)
  $.ui.invalidate('ui.render')
  const key = listKey
  if (!key) return // the list has not loaded yet: loadTracked merges this session's clicks in
  listReadAt = Date.now()
  void (async () => {
    const items = change(savedItems(await $.store.get(key)))
    await $.store.set(key, { at: Date.now(), items } satisfies SavedList)
    if (key !== listKey) return
    tracked = items
    if (selected && !tracked.some((t) => keyFor(t.repo, t.number) === selected)) selected = null
    $.ui.invalidate('ui.render')
  })().catch(() => undefined)
}

function track($: EngineInterface, repo: string, number: number) {
  // A click can come before the band ever drew: the session's list loads here, the click merges in.
  loadTracked($)
  const key = keyFor(repo, number)
  selected = key
  changeTracked($, (items) => (items.some((t) => keyFor(t.repo, t.number) === key) ? items : [...items, { repo, number }]))
}

function untrack($: EngineInterface, key: string) {
  if (selected === key) selected = null
  changeTracked($, (items) => items.filter((t) => keyFor(t.repo, t.number) !== key))
}

// Runs a gh command for an action and reports how it went in a toast.
// ---------- Copying a link as rich text ----------

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Bytes of `s` in UTF-8: CF_HTML's offsets count bytes, not characters.
function utf8Length(s: string) {
  let n = 0
  for (const ch of s) {
    const code = ch.codePointAt(0)!
    n += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return n
}

// The Windows clipboard's HTML format: a header of byte offsets around the fragment.
function cfHtml(fragment: string) {
  const pre = '<html><body><!--StartFragment-->'
  const post = '<!--EndFragment--></body></html>'
  const header = (a: number, b: number, c: number, d: number) =>
    `Version:0.9\r\nStartHTML:${String(a).padStart(10, '0')}\r\nEndHTML:${String(b).padStart(10, '0')}\r\nStartFragment:${String(c).padStart(10, '0')}\r\nEndFragment:${String(d).padStart(10, '0')}\r\n`
  const startHtml = utf8Length(header(0, 0, 0, 0))
  const startFragment = startHtml + utf8Length(pre)
  const endFragment = startFragment + utf8Length(fragment)
  const endHtml = endFragment + utf8Length(post)
  return header(startHtml, endHtml, startFragment, endFragment) + pre + fragment + post
}

// Windows PowerShell 5.1 puts both formats on the clipboard in one data object: HTML for chats such
// as Teams, plain text for everything else. It reads them as JSON on stdin, so no quoting reaches a shell.
const CLIPBOARD_PS =
  "[Console]::InputEncoding=[Text.Encoding]::UTF8; $in=[Console]::In.ReadToEnd() | ConvertFrom-Json; " +
  'Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.DataObject; ' +
  "$d.SetData('HTML Format', $in.html); $d.SetData('UnicodeText', $in.text); " +
  '[System.Windows.Forms.Clipboard]::SetDataObject($d, $true)'

// `acme/shop#58` as a link, then the title: what a chat shows when it takes rich text.
async function copyLink($: EngineInterface, item: Item, surface: RenderSurface) {
  const label = `${item.repo}#${item.number}`
  const html = `<a href="${escapeHtml(item.url)}">${escapeHtml(label)}</a> ${escapeHtml(item.title)}`
  const text = `${label} ${item.title} ${item.url}`
  try {
    const out = await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', CLIPBOARD_PS], {
      stdin: JSON.stringify({ html: cfHtml(html), text }), timeoutMs: 15_000,
    })
    if (out.exitCode === 0) return $.ui.toast(`copied ${label} as a link`)
  } catch {
    // No Windows PowerShell here: the plain text below still gets the link across.
  }
  await $.ui.copy({ text, surface }).catch(() => undefined)
  $.ui.toast(`copied ${label} as plain text`)
}

async function act($: EngineInterface, argv: string[], done: string) {
  try {
    const out = await $.process.run(argv, { timeoutMs: 60_000 })
    $.ui.toast(out.exitCode === 0 ? done : `${argv.slice(0, 3).join(' ')} failed: ${out.stderr.trim().split('\n')[0] || `exit ${out.exitCode}`}`)
  } catch (err) {
    $.ui.toast(`${argv.slice(0, 3).join(' ')} failed: ${String(err)}`)
  }
}

const keyFor = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`
const repoOf = (r: Ref) => r.repo ?? cwdRepo
const entryOf = (r: Ref) => {
  const repo = repoOf(r)
  return repo ? cache.get(keyFor(repo, r.number)) : undefined
}

// ---------- Finding references ----------

const maskCode = (text: string) => text.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => ' '.repeat(m.length))

type Piece = { text: string } | { ref: Ref }

// Splits inline text into plain runs and references; code spans keep their `#123` as written.
function pieces(text: string): Piece[] {
  const out: Piece[] = []
  let at = 0
  for (const m of maskCode(text).matchAll(REF)) {
    if (m.index! > at) out.push({ text: text.slice(at, m.index) })
    const isUrl = m[1] !== undefined
    const number = Number(m[2] ?? m[4])
    const repo = m[1] ?? m[3] ?? null
    out.push({ ref: { repo, number, label: isUrl || repo ? `${repo}#${number}` : `#${number}` } })
    at = m.index! + m[0].length
  }
  if (at < text.length) out.push({ text: text.slice(at) })
  return out
}

const refsIn = (text: string) => pieces(text).flatMap((p) => ('ref' in p ? [p.ref] : []))

// ---------- Blocks ----------

type Block =
  | { kind: 'markdown'; text: string }
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'list'; items: { indent: number; marker: string; text: string }[] }
  | { kind: 'heading'; level: number; text: string }
  // `source`: the table as Claude wrote it, for Claude Code to draw when it holds no reference.
  | { kind: 'table'; header: string[]; rows: string[][]; numbered: boolean[]; source: string }

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line)
const isRule = (line: string) => /^\s*\|[\s:|-]+\|\s*$/.test(line)
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/

// A `#` column counting 1, 2, 3 (or 7, 8, 9) numbers the rows; a list of PRs does not count up from so low.
function isRowIndex(values: string[]) {
  const numbers = values.map((v) => (/^\d{1,7}$/.test(v.trim()) ? Number(v) : NaN))
  if (numbers.some(Number.isNaN) || numbers[0]! > 20) return false
  return numbers.every((n, i) => i === 0 || n === numbers[i - 1]! + 1)
}

function cells(line: string) {
  const out: string[] = []
  let start = line.indexOf('|') + 1
  for (let i = start; i < line.length; i++) {
    if (line[i] === '|' && line[i - 1] !== '\\') {
      out.push(line.slice(start, i).trim())
      start = i + 1
    }
  }
  return out
}

// Paragraphs, lists, headings and tables, the blocks a reference can sit in; anything else stays Claude Code's Markdown.
function blocks(text: string): Block[] {
  const lines = text.split('\n')
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) { i++; continue }
    if (/^\s*```/.test(line)) {
      const start = i++
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) i++
      out.push({ kind: 'markdown', text: lines.slice(start, ++i).join('\n') })
      continue
    }
    if (isTableRow(line) && i + 1 < lines.length && isRule(lines[i + 1]!)) {
      const header = cells(line)
      const rows: string[][] = []
      const start = i
      i += 2
      while (i < lines.length && isTableRow(lines[i]!)) rows.push(cells(lines[i++]!))
      out.push({ kind: 'table', header, rows, numbered: header.map((h, c) => NUMBER_HEADER.test(h) && !isRowIndex(rows.map((r) => r[c] ?? ''))), source: lines.slice(start, i).join('\n') })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) { out.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! }); i++; continue }
    if (LIST.test(line)) {
      const items: { indent: number; marker: string; text: string }[] = []
      while (i < lines.length && lines[i]!.trim()) {
        const m = LIST.exec(lines[i]!)
        if (m) items.push({ indent: m[1]!.length, marker: m[2]!, text: m[3]! })
        else if (items.length) items[items.length - 1]!.text += ' ' + lines[i]!.trim()
        i++
      }
      out.push({ kind: 'list', items })
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() && !/^\s*```/.test(lines[i]!) && !LIST.test(lines[i]!) && !/^#{1,6}\s/.test(lines[i]!) && !isTableRow(lines[i]!)) para.push(lines[i++]!)
    if (para.length) out.push({ kind: 'paragraph', lines: para })
    else out.push({ kind: 'markdown', text: lines[i++]! })
  }
  return out
}

const blockText = (b: Block): string =>
  b.kind === 'markdown' ? b.text
    : b.kind === 'paragraph' ? b.lines.join('\n')
      : b.kind === 'heading' ? `${'#'.repeat(b.level)} ${b.text}`
        : b.kind === 'list' ? b.items.map((it) => `${' '.repeat(it.indent)}${it.marker} ${it.text}`).join('\n')
          : b.source

function blockRefs(b: Block): Ref[] {
  if (b.kind === 'markdown') return []
  if (b.kind !== 'table') return refsIn(blockText(b))
  return b.rows.flatMap((row) => row.flatMap((cell, c) => (b.numbered[c] && /^\d{1,7}$/.test(cell) ? [{ repo: null, number: Number(cell), label: cell }] : refsIn(cell))))
}

// ---------- Loading from GitHub ----------

let cwdRepoAsking: Promise<string | null> | null = null

function askCwdRepo($: EngineInterface) {
  void cwdRepoNow($)
}

// The session folder's GitHub repo, asked of gh once.
function cwdRepoNow($: EngineInterface): Promise<string | null> {
  if (cwdRepo !== undefined) return Promise.resolve(cwdRepo)
  if (cwdRepoAsking) return cwdRepoAsking
  cwdRepoAsking = $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { timeoutMs: 15_000 })
    .then((out) => (cwdRepo = out.exitCode === 0 && out.stdout.trim() ? out.stdout.trim() : null))
    .catch(() => (cwdRepo = null))
    .finally(() => $.ui.invalidate('ui.render'))
  return cwdRepoAsking
}

function want($: EngineInterface, ref: Ref) {
  const repo = repoOf(ref)
  if (repo === undefined) return askCwdRepo($)
  if (repo === null) return
  const key = keyFor(repo, ref.number)
  const hit = cache.get(key)
  if (hit && (hit.loading || Date.now() - hit.at < TTL_MS)) return
  cache.set(key, { ...hit, at: Date.now(), loading: true })
  const numbers = queue.get(repo) ?? new Set<number>()
  queue.set(repo, numbers.add(ref.number))
  if (!flushQueued) {
    flushQueued = true
    // One render asks for every reference it holds: send them as one query per repo.
    void Promise.resolve().then(() => flush($))
  }
}

const FIELDS = `
  __typename
  ... on PullRequest { number title url state isDraft author { login } additions deletions changedFiles reviewDecision createdAt mergedAt closedAt headRefName baseRefName
    statusCheckRollup { contexts(first: 100) { totalCount checkRunCountsByState { state count } statusContextCountsByState { state count }
      nodes { __typename ... on CheckRun { name conclusion detailsUrl } ... on StatusContext { context state targetUrl } } } }
    latestReviews(first: 20) { nodes { state author { login } } }
    reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
    reviewThreads(first: 100) { nodes { isResolved path line } }
    files(first: 4) { nodes { path additions deletions } } }
  ... on Issue { number title url state stateReason author { login } comments { totalCount } createdAt closedAt }`

async function flush($: EngineInterface) {
  flushQueued = false
  const jobs = [...queue].flatMap(([repo, numbers]) => {
    const all = [...numbers]
    const chunks: number[][] = []
    for (let i = 0; i < all.length; i += BATCH) chunks.push(all.slice(i, i + BATCH))
    return chunks.map((chunk) => ({ repo, chunk }))
  })
  queue.clear()
  await Promise.all(jobs.map(({ repo, chunk }) => fetchChunk($, repo, chunk)))
  $.ui.invalidate('ui.render')
}

async function fetchChunk($: EngineInterface, repo: string, numbers: number[]) {
  const [owner, name] = repo.split('/')
  const query = `query { viewer { login } repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${numbers.map((n) => `n${n}: issueOrPullRequest(number: ${n}) { ${FIELDS} }`).join('\n')} } }`
  const fail = (error: string) => numbers.forEach((n) => cache.set(keyFor(repo, n), { at: Date.now(), loading: false, error }))
  try {
    // The query goes in on stdin: about 900 characters a PR, so a batch of 40 (36,000) passes
    // Windows' 32,767-character command line, and gh would not start.
    const out = await $.process.run(['gh', 'api', 'graphql', '--input', '-'], { stdin: JSON.stringify({ query }), timeoutMs: 20_000 })
    const body = JSON.parse(out.stdout || '{}') as { data?: { viewer?: { login: string }; repository?: Record<string, Raw | null> | null }; errors?: { message: string }[] }
    viewer = body.data?.viewer?.login ?? viewer
    const found = body.data?.repository
    if (!found) return fail(body.errors?.[0]?.message ?? (out.stderr.trim().split('\n')[0] || `gh exited ${out.exitCode}`))
    for (const n of numbers) {
      const raw = found[`n${n}`]
      cache.set(keyFor(repo, n), raw ? { at: Date.now(), loading: false, item: toItem(repo, raw) } : { at: Date.now(), loading: false, missing: true })
    }
  } catch (err) {
    fail(String(err))
  }
}

type Count = { state: string; count: number }
type Raw = {
  __typename: 'PullRequest' | 'Issue'
  number: number; title: string; url: string; state: string; isDraft?: boolean; stateReason?: string | null
  author?: { login: string } | null; additions?: number; deletions?: number; changedFiles?: number; reviewDecision?: string | null
  createdAt?: string; mergedAt?: string | null; closedAt?: string | null; headRefName?: string | null; baseRefName?: string | null
  statusCheckRollup?: {
    contexts: {
      totalCount: number; checkRunCountsByState?: Count[]; statusContextCountsByState?: Count[]
      nodes?: { __typename: string; name?: string; conclusion?: string | null; detailsUrl?: string | null; context?: string; state?: string; targetUrl?: string | null }[]
    }
  } | null
  latestReviews?: { nodes: { state: string; author?: { login: string } | null }[] }
  reviewRequests?: { nodes: { requestedReviewer?: { login?: string } | null }[] }
  reviewThreads?: { nodes: { isResolved: boolean; path: string; line: number | null }[] }
  files?: { nodes: { path: string; additions: number; deletions: number }[] }
  comments?: { totalCount: number }
}

const OK = ['SUCCESS', 'NEUTRAL', 'SKIPPED']
const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']

function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return ''
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  const [n, unit] = minutes < 60 ? [minutes, 'minute'] : minutes < 1440 ? [Math.round(minutes / 60), 'hour'] : [Math.round(minutes / 1440), 'day']
  return n === 0 ? 'just now' : `${n} ${unit}${n === 1 ? '' : 's'} ago`
}

function toItem(repo: string, raw: Raw): Item {
  const author = raw.author?.login ?? 'ghost'
  if (raw.__typename === 'Issue') {
    const state = raw.state === 'OPEN' ? 'OPEN' : raw.stateReason === 'NOT_PLANNED' ? 'NOT_PLANNED' : 'COMPLETED'
    const when = state === 'OPEN' ? `opened ${ago(raw.createdAt)}` : `closed ${ago(raw.closedAt)}`
    return { kind: 'issue', number: raw.number, repo, title: raw.title, url: raw.url, state, author, when, created: raw.createdAt, comments: raw.comments?.totalCount ?? 0 }
  }
  const contexts = raw.statusCheckRollup?.contexts
  const counts = [...(contexts?.checkRunCountsByState ?? []), ...(contexts?.statusContextCountsByState ?? [])]
  const sum = (states: string[]) => counts.filter((c) => states.includes(c.state)).reduce((a, c) => a + c.count, 0)
  const total = contexts?.totalCount ?? 0
  const ok = sum(OK)
  const failed = sum(FAILED)
  const failing = (contexts?.nodes ?? []).filter((c) => FAILED.includes(c.conclusion ?? c.state ?? '')).map((c) => ({ name: c.name ?? c.context ?? '?', url: c.detailsUrl ?? c.targetUrl ?? undefined }))
  const reviews = raw.latestReviews?.nodes ?? []
  const by = (s: string) => reviews.filter((r) => r.state === s).map((r) => r.author?.login ?? 'ghost')
  const state = raw.state === 'OPEN' && raw.isDraft ? 'DRAFT' : raw.state
  const when = state === 'MERGED' ? `merged ${ago(raw.mergedAt)}` : state === 'CLOSED' ? `closed ${ago(raw.closedAt)}` : `opened ${ago(raw.createdAt)}`
  return {
    kind: 'pr', number: raw.number, repo, title: raw.title, url: raw.url, state, author, when,
    created: raw.createdAt, head: raw.headRefName ?? undefined, base: raw.baseRefName ?? undefined,
    additions: raw.additions, deletions: raw.deletions, changedFiles: raw.changedFiles,
    review: raw.reviewDecision ?? undefined, checks: { ok, failed, pending: Math.max(0, total - ok - failed), total }, failing,
    approvedBy: by('APPROVED'), changesBy: by('CHANGES_REQUESTED'),
    requested: (raw.reviewRequests?.nodes ?? []).flatMap((r) => r.requestedReviewer?.login ?? []),
    threads: (raw.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved).map((t) => ({ path: t.path, line: t.line })),
    files: raw.files?.nodes ?? [],
  }
}

const color = (item: Item) => STATE_COLOR[item.state] ?? C.dim

// `2d`, `5h`, `20m`: how long ago, for a chip.
function age(iso?: string, now = Date.now()) {
  if (!iso) return ''
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`
}

// The band's group: 0 needs you (your review is asked for, or your PR fails its checks or got
// changes requested), 1 waiting (open, or not loaded yet), 2 done (merged or closed).
function groupOf(item?: Item) {
  if (!item) return 1
  if (item.state !== 'OPEN' && item.state !== 'DRAFT') return 2
  if (!viewer) return 1
  if (item.requested?.includes(viewer)) return 0
  if (item.author === viewer && (item.checks?.failed || item.review === 'CHANGES_REQUESTED')) return 0
  return 1
}
const short = (url: string) => url.replace(/^https:\/\//, '')

// ---------- Drawing ----------

export const register: Register = (on, options) => {
  // `card` (the default) or `github`, from the plugin's settings.
  const style = String(options.cardStyle ?? 'card').trim().toLowerCase() === 'github' ? 'github' : 'card'
  // The band of tracked PRs above the prompt, on unless the setting says false.
  const band = options.trackedBand !== false && String(options.trackedBand ?? 'true').toLowerCase() !== 'false'
  const perRow = Math.max(1, Math.min(6, Math.round(Number(options.bandPerRow) || 3)))
  // One tracked list per repo (or folder) unless the setting says false.
  shareTracked = options.shareTracked !== false && String(options.shareTracked ?? 'true').toLowerCase() !== 'false'
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const parsed = blocks(e.props.text)
    const refs = parsed.flatMap(blockRefs)
    if (!refs.length) return next(e)
    for (const r of refs) want($, r)

    const { Box, Text, Markdown, Link } = $.ui.resolve(e)
    const id = `pr-${e.requestId}`
    // The reply's room: the terminal less its two-cell indent.
    const columns = Math.max(20, (e.viewport?.columns ?? 100) - 2)
    let serial = 0

    const span = (text: string, c?: string, extra: { bold?: boolean; italic?: boolean; underline?: boolean; backgroundColor?: string } = {}) => Text({ color: c, ...extra, children: [text] })

    // A card is drawn as text rows padded to its full width: a Box background paints only the cells
    // that hold text, so the transcript under a short row would show through.
    // `href` draws the run as a Link: an OSC 8 hyperlink that ctrl+click opens, inside the filled row.
    type Seg = { text: string; color?: string; bold?: boolean; underline?: boolean; backgroundColor?: string; href?: string }
    const profile = (login: string) => `https://github.com/${login}`
    // `@login` linked to the profile; the signed-in user reads "you", unlinked.
    const person = (login: string, c?: string): Seg => (login === viewer ? { text: 'you', color: c } : { text: `@${login}`, color: c ?? C.link, href: profile(login) })
    // A run that ctrl+click opens, in its own color, plain text when there is no target. Links carry no
    // underline of their own: the terminal draws its dotted hyperlink underline, which a solid one hides.
    const linked = (text: string, href: string | undefined, c?: string): Seg => (href ? { text, color: c, href } : { text, color: c })
    // The title with its `#123`, `owner/repo#123` and GitHub URLs as links; GitHub sends an issue URL of a PR to the PR.
    const titleSegs = (item: Item): Seg[] =>
      pieces(item.title).map((p) =>
        'ref' in p
          ? { text: p.ref.label, color: C.link, bold: true, href: `https://github.com/${p.ref.repo ?? item.repo}/issues/${p.ref.number}` }
          : { text: p.text, bold: true })
    const people = (logins: string[], c?: string): Seg[] => logins.flatMap((l, i) => [...(i ? [{ text: ', ', color: c }] : []), person(l, c)])
    // A fixed dark gray (#303030), as the mockup's card: palette black is the terminal background in
    // most dark schemes, so a card filled with it shows no edge. Mods get no theme background key.
    const BG = 'ansi256(236)'
    const INNER = CARD_WIDTH - 4 // two border cells and one blank cell on each side
    const seg = (text: string, c?: string, extra: Omit<Seg, 'text' | 'color'> = {}): Seg => ({ text, color: c, ...extra })
    const fill = (segs: Seg[]): RenderElement[] => {
      const rows: Seg[][] = [[]]
      let used = 0
      for (const s of segs) {
        for (const word of s.text.split(/(?<=\s)/)) {
          let rest = word
          while (rest) {
            const room = INNER - used
            // A full row, or a word that does not fit after others: start a new row. Each pass takes at
            // least one character, so the loop always ends.
            if (room <= 0 || (used > 0 && rest.trimEnd().length > room)) {
              rows.push([])
              used = 0
              rest = rest.trimStart()
              continue
            }
            const take = rest.slice(0, room)
            rows[rows.length - 1]!.push({ ...s, text: take })
            used += take.length
            rest = rest.slice(take.length)
          }
        }
      }
      const same = (a: Seg, b: Seg) => a.color === b.color && a.bold === b.bold && a.underline === b.underline && a.backgroundColor === b.backgroundColor && a.href === b.href
      const merged = rows.map((row) => row.reduce<Seg[]>((out, s) => {
        const last = out[out.length - 1]
        if (last && same(last, s)) last.text += s.text
        else out.push({ ...s })
        return out
      }, []))
      return merged.map((row) => {
        const width = row.reduce((n, s) => n + s.text.length, 0)
        return Text({ backgroundColor: BG, children: ['  ', ...runs(row, BG), ' '.repeat(Math.max(0, INNER - width) + 2)] })
      })
    }
    // Each run as Text on the fill, and as a Link around it when it has a target.
    const runs = (row: Seg[], bg: string) =>
      row.map((s) => {
        const run = Text({ color: s.color, bold: s.bold, underline: s.underline, backgroundColor: s.backgroundColor ?? bg, children: [s.text] })
        return s.href ? Link({ href: s.href, children: [run] }) : run
      })
    // The fill is the card's edge. A box-drawing line runs through the middle of its cell, so a border
    // cell either leaves a dark half inside the line or a gray half outside it.
    const edge = () => Text({ backgroundColor: BG, children: [' '.repeat(CARD_WIDTH)] })

    // The card's rows under the title, as the mockup: who and when, size, checks, reviews, threads.
    const facts = (item: Item): Seg[][] => {
      if (item.kind === 'issue') return [[person(item.author), seg(` · ${item.when} · `, C.dim), linked(`${item.comments} comments`, item.url, C.dim)]]
      const c = item.checks!
      const rows: Seg[][] = [
        [person(item.author), seg(` · ${item.when} · `, C.dim), seg(`+${item.additions}`, C.open), seg(' '), seg(`−${item.deletions}`, C.closed), seg(' · ', C.dim), linked(`${item.changedFiles} files`, `${item.url}/files`, C.dim)],
      ]
      if (c.total) {
        rows.push([
          seg('✓', C.open), seg(' '), linked(`${c.ok} of ${c.total} checks`, `${item.url}/checks`),
          ...(item.failing?.length
            ? [seg(' · '), seg('x ', C.closed), linked(item.failing[0]!.name, item.failing[0]!.url, C.closed), ...(item.failing.length > 1 ? [seg(` +${item.failing.length - 1}`, C.closed)] : [])]
            : []),
          ...(c.pending ? [seg(' · '), seg(`● ${c.pending} running`, C.warn)] : []),
        ])
      }
      const reviews: Seg[] = []
      if (item.approvedBy?.length) reviews.push(seg('✓', C.open), seg(' approved by '), ...people(item.approvedBy))
      if (item.changesBy?.length) reviews.push(...(reviews.length ? [seg(' · ')] : []), seg('● changes requested by ', C.warn), ...people(item.changesBy, C.warn))
      rows.push(reviews.length ? reviews : [seg(REVIEW_WORD[item.review ?? ''] ?? 'no reviews yet', C.dim)])
      if (item.threads?.length) rows.push([linked(`${item.threads.length} open review thread${item.threads.length === 1 ? '' : 's'}`, item.url)])
      return rows
    }

    // Opens upward: rows drawn after the reference would paint over a card below it.
    const popup = (rows: Seg[][]) =>
      Box({
        position: 'absolute', bottom: 1, left: 0, display: 'none', hover: { display: 'flex' },
        flexDirection: 'column', width: CARD_WIDTH,
        children: [edge(), ...rows.flatMap((r) => fill(r)), edge()],
      })

    const card = (item: Item) =>
      popup([
        [seg(` ${STATE_WORD[item.state] ?? item.state} `, 'ansi256(0)', { backgroundColor: color(item), bold: true }), seg('  '), linked(item.repo, `https://github.com/${item.repo}`, C.dim), seg(' '), linked(`#${item.number}`, item.url, C.dim)],
        titleSegs(item),
        ...facts(item),
        [seg(short(item.url), C.link, { href: item.url })],
      ])

    // `cardStyle: github`, design 9, laid out as GitHub's own hover card: the repo and the day it was
    // opened; the state dot, title and number; the branches; one footer row with the review and checks.
    const githubCard = (item: Item) => {
      const repoUrl = `https://github.com/${item.repo}`
      const rows: Seg[][] = [
        [linked(item.repo, repoUrl, C.link), seg(` on ${day(item.created)}`, C.dim)],
        [],
        [seg(`${DOT} `, color(item)), ...titleSegs(item), seg(' '), linked(`#${item.number}`, item.url, C.dim)],
      ]
      if (item.head && item.base) {
        rows.push([linked(item.head, `${repoUrl}/tree/${item.head}`, C.code), seg(' → ', C.dim), linked(item.base, `${repoUrl}/tree/${item.base}`, C.code)])
      }
      // Design 9c: the footer opens with who opened it, then the review and the checks.
      const foot: Seg[] = [seg('opened by ', C.dim), person(item.author), seg(' · ', C.dim)]
      if (item.kind === 'issue') foot.push(linked(`${item.comments} comments`, item.url, C.dim))
      // Your own review reads as the mockup says it, short enough to keep the footer on one row.
      else if (item.changesBy?.length === 1 && item.changesBy[0] === viewer) foot.push(seg('● you requested changes', C.warn))
      else if (item.changesBy?.length) foot.push(seg('● changes requested by ', C.warn), ...people(item.changesBy, C.warn))
      else if (item.approvedBy?.length === 1 && item.approvedBy[0] === viewer) foot.push(seg('✓ you approved', C.open))
      else if (item.approvedBy?.length) foot.push(seg('✓ approved by ', C.open), ...people(item.approvedBy, C.open))
      else foot.push(seg(REVIEW_WORD[item.review ?? ''] ?? 'no reviews yet', C.dim))
      const c = item.checks
      if (!c?.total) return popup([...rows, [], foot])
      const checks = linked(`${c.failed ? 'x' : '✓'} ${c.ok} of ${c.total} checks`, `${item.url}/checks`, c.failed ? C.closed : C.open)
      // A long login would wrap the checks in the middle: then they take a row of their own.
      const fits = foot.reduce((n, s) => n + s.text.length, 0) + 3 + checks.text.length <= INNER
      return popup([...rows, [], ...(fits ? [[...foot, seg(' · ', C.dim), checks]] : [foot, [checks]])])
    }

    // A reference where the text has it: the state dot, the number as a link, the card on hover.
    const reference = (ref: Ref) => {
      const entry = entryOf(ref)
      // No such PR or issue: the number stays the text Claude wrote, with no dot and no card.
      if (entry?.missing) return span(ref.label)
      const item = entry?.item
      // A gray filled dot is a draft; loading is hollow and a failed lookup a cross, so neither reads as a state.
      const dot = item ? span(`${DOT} `, color(item)) : entry?.error ? span('x ', C.closed) : span('○ ', C.dim)
      const label = item
        ? Markdown({
            key: `${id}-link-${serial}`, text: `[${ref.label}](${item.url})`,
            // A plain click tracks it in the band above the prompt; ctrl+click still opens GitHub.
            ...(band ? { pressableLinks: [item.url], onLinkPress: () => track($, item.repo, item.number) } : {}),
          })
        : span(ref.label, C.link, { underline: true })
      const pop = item ? [style === 'github' ? githubCard(item) : card(item)] : entry?.error ? [popup([[seg(entry.error, C.closed)]])] : []
      return Box({ key: `${id}-ref-${serial++}`, flexShrink: 0, children: [dot, label, ...pop] })
    }

    // The cells a reference takes: its label, plus the dot and a space unless it turned out missing.
    const refWidth = (ref: Ref) => ref.label.length + (entryOf(ref)?.missing ? 0 : 2)


    type Style = { bold?: boolean; italic?: boolean }

    // One unit of inline layout and the cells it takes: a word with its trailing space, a code span, a
    // link or a reference. A table wraps its cells by these widths itself, so its bars match each row.
    type Atom = { el: RenderElement; w: number; text?: string; color?: string; style?: Style }
    const word = (text: string, style: Style, c?: string): Atom => ({ el: span(text, c, { ...style }), w: text.length, text, color: c, style })
    const element = (el: RenderElement, w: number): Atom => ({ el, w })
    // Without its trailing space: what must fit before the line ends.
    const inner = (a: Atom) => (a.text !== undefined ? a.text.trimEnd().length : a.w)

    // Plain words that wrap one by one, with the references among them drawn in place.
    const words = (text: string, style: Style): Atom[] =>
      pieces(text).flatMap((p) =>
        'ref' in p ? [element(reference(p.ref), refWidth(p.ref))] : p.text.split(/(?<=\s)/).filter(Boolean).map((w) => word(w.replace(/\s+$/, ' '), style)))

    // Inline markdown over the whole line first, references second: a reference can sit inside a bold
    // or italic span, and splitting at it first would leave the span's markers unmatched, drawn as `**`.
    const flow = (text: string, base: Style = {}): RenderElement[] => atoms(text, base).map((a) => a.el)
    const atoms = (text: string, base: Style = {}): Atom[] => {
      const out: Atom[] = []
      const style: Style = { ...base }
      let buffer = ''
      const flush = () => {
        if (buffer) out.push(...words(buffer, style))
        buffer = ''
      }
      let i = 0
      while (i < text.length) {
        const ch = text[i]!
        const rest = text.slice(i)
        const link = /^\[([^\]]+)\]\((https?:[^)\s]+)\)/.exec(rest)
        const code = ch === '`' ? text.indexOf('`', i + 1) : -1
        const strong = rest.startsWith('**') || rest.startsWith('__') ? rest.slice(0, 2) : ''
        const before = text[i - 1] ?? ' '
        const after = text[i + 1] ?? ' '
        if (code > i) {
          flush()
          out.push(word(text.slice(i + 1, code), { bold: style.bold }, C.code))
          i = code + 1
        } else if (link) {
          flush()
          // Claude often writes a PR as a markdown link, `[#1338](…/pull/1338)`: that is a reference too,
          // drawn with its own label.
          const target = GITHUB_ITEM.exec(link[2]!)
          out.push(target
            ? (() => {
                const ref = { repo: target[1]!, number: Number(target[2]), label: link[1]! }
                return element(reference(ref), refWidth(ref))
              })()
            : element(Markdown({ text: link[0] }), link[1]!.length))
          i += link[0].length
        } else if (strong && (style.bold || text.indexOf(strong, i + 2) > 0)) {
          // A marker opens only when it closes later in the line, so a stray `**` stays text.
          flush()
          style.bold = !style.bold
          i += 2
        } else if ((ch === '*' || ch === '_') && (style.italic ? !/\s/.test(before) : !/[\w*]/.test(before) && !/\s/.test(after) && text.indexOf(ch, i + 1) > 0)) {
          flush()
          style.italic = !style.italic
          i += 1
        } else {
          buffer += ch
          i += 1
        }
      }
      flush()
      return out
    }

    const row = (children: RenderElement[], extra: Record<string, unknown> = {}) => Box({ flexDirection: 'row', flexWrap: 'wrap', ...extra, children })

    // Atoms into lines of at most `width` cells. A plain word longer than a line is cut, so no line
    // pushes the table's bars out of place.
    const wrap = (list: Atom[], width: number): Atom[][] => {
      const lines: Atom[][] = [[]]
      let used = 0
      for (const a of list) {
        let atom = a
        while (true) {
          if (used > 0 && used + inner(atom) > width) {
            lines.push([])
            used = 0
          }
          if (atom.text !== undefined && inner(atom) > width - used) {
            const head = atom.text.slice(0, width - used)
            lines[lines.length - 1]!.push(word(head, atom.style ?? {}, atom.color))
            lines.push([])
            used = 0
            atom = word(atom.text.slice(head.length), atom.style ?? {}, atom.color)
            if (!atom.text!.trim()) break
            continue
          }
          lines[lines.length - 1]!.push(atom)
          used += atom.w
          break
        }
      }
      return lines.filter((l, i) => l.length || i === 0)
    }

    // Claude Code's own table grid, drawn around cells the mod lays out, so the references in them get
    // their dot and card and the table keeps its borders.
    const table = (b: Extract<Block, { kind: 'table' }>) => {
      const count = b.header.length
      const head = b.header.map((h) => atoms(h, { bold: true }))
      const body = b.rows.map((r) => b.header.map((_, c) => {
        const text = r[c] ?? ''
        if (!b.numbered[c] || !/^\d{1,7}$/.test(text)) return atoms(text)
        const ref = { repo: null, number: Number(text), label: text }
        return [element(reference(ref), refWidth(ref))]
      }))
      const measure = (list: Atom[]) => list.reduce((n, a) => n + a.w, 0) - (list.length && list[list.length - 1]!.text?.endsWith(' ') ? 1 : 0)
      const widths = b.header.map((_, c) => Math.max(1, measure(head[c]!), ...body.map((r) => measure(r[c]!))))
      // `│ a │ b │`: three cells around each column plus the last bar.
      const room = columns - (3 * count + 1)
      while (widths.reduce((a, w) => a + w, 0) > room) {
        const widest = widths.indexOf(Math.max(...widths))
        if (widths[widest]! <= 8) break
        widths[widest]!--
      }
      const rule = (left: string, mid: string, right: string) => span(left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right)
      const rows = (cells: Atom[][], center: boolean): RenderElement[] => {
        const wrapped = cells.map((list, c) => wrap(list, widths[c]!))
        const height = Math.max(...wrapped.map((l) => l.length))
        return Array.from({ length: height }, (_, k) =>
          Box({
            flexDirection: 'row',
            children: [
              span('│ '),
              ...wrapped.flatMap((lines, c) => {
                const line = lines[k] ?? []
                const pad = Math.max(0, widths[c]! - measure(line))
                const left = center ? Math.floor(pad / 2) : 0
                return [
                  Box({ width: widths[c], flexShrink: 0, flexDirection: 'row', children: [...(left ? [span(' '.repeat(left))] : []), ...line.map((a) => a.el)] }),
                  span(c < count - 1 ? ' │ ' : ' │'),
                ]
              }),
            ],
          }))
      }
      return Box({
        flexDirection: 'column',
        children: [
          rule('┌', '┬', '┐'),
          ...rows(head, true),
          ...body.flatMap((r) => [rule('├', '┼', '┤'), ...rows(r, false)]),
          rule('└', '┴', '┘'),
        ],
      })
    }

    const draw = (b: Block): RenderElement => {
      if (!blockRefs(b).length) return Markdown({ text: blockText(b) })
      switch (b.kind) {
        case 'table': return table(b)
        case 'heading': return row(flow(b.text, { bold: true }))
        case 'list': return Box({ flexDirection: 'column', children: b.items.map((it) => row([span(/\d/.test(it.marker) ? `${it.marker} ` : '• '), ...flow(it.text)], { paddingLeft: it.indent })) })
        case 'paragraph': return Box({ flexDirection: 'column', children: b.lines.map((l) => row(flow(l))) })
        default: return Markdown({ text: blockText(b) })
      }
    }

    return Box({ flexDirection: 'column', rowGap: 1, children: parsed.map(draw) })
  })

  // Arrows (and a click) move the band's focus ring between chips: the focused chip is the selected one.
  on('ui.focus', ($, e, next) => {
    const prefix = 'pr-cards-select-'
    if (band && e.plugin === 'pr-cards' && e.element?.startsWith(prefix)) {
      const key = e.element.slice(prefix.length)
      if (selected !== key) {
        selected = key
        armed = null
        $.ui.invalidate('ui.render')
      }
    }
    return next(e)
  })

  // Design B2e: the tracked PRs as chips above the prompt, `perRow` to a row, driven by the
  // keyboard: arrows move between chips, one key runs an action on the focused one.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const theirs = await next(e)
    if (!band) return theirs
    loadTracked($)
    rereadTracked($)
    if (!tracked.length || e.props.hasSurvey) return theirs
    for (const t of tracked) want($, { repo: t.repo, number: t.number, label: '' })

    const { Box, Text, Button, Link } = $.ui.resolve(e)
    // Design G1: chips in groups (needs you, waiting, done), a dim label before each group's first
    // row; a ▎ in the theme's suggestion color marks the selected chip. No fill or underline: a
    // terminal draws an underline in each character's color.
    const LABEL = 10
    // Design I3: the group rows start four cells right of the Tracked PRs bar, as its contents.
    const INDENT = 4
    const columns = Math.max(40, e.props.bodyColumns) - 2
    // `perRow` chips share what the indent and label leave, each with a cell of gap: 32 cells in 120 columns.
    const CHIP = Math.max(24, Math.min(44, Math.floor((columns - INDENT - LABEL) / perRow) - 1))
    type Run = { text: string; color?: string; bold?: boolean }

    const chip = (t: Tracked) => {
      const key = keyFor(t.repo, t.number)
      const entry = cache.get(key)
      const item = entry?.item
      const runs: Run[] = []
      if (!item) runs.push({ text: `${entry?.error ? 'x' : '○'} `, color: entry?.error ? C.closed : C.dim }, { text: `#${t.number}`, color: C.link, bold: true })
      else {
        const c = item.checks
        const tail: Run[] = [
          // A long login would eat the title: ten cells at most.
          { text: ` ${item.author.length > 10 ? `${item.author.slice(0, 9)}…` : item.author} ${age(item.created)}`, color: C.dim },
          ...(c?.total ? [{ text: ` ${c.failed ? 'x' : c.pending ? '●' : '✓'}`, color: c.failed ? C.closed : c.pending ? C.warn : C.open }] : []),
        ]
        const head = `#${t.number} `
        // The title takes what the chip has left after the marker, dot, number, author, age, checks and one cell of space.
        const room = Math.max(4, CHIP - 3 - head.length - tail.reduce((n, r) => n + r.text.length, 0) - 1)
        const title = item.title.length > room ? `${item.title.slice(0, room - 1)}…` : item.title
        runs.push({ text: `${DOT} `, color: color(item) }, { text: head, color: C.link, bold: true }, { text: title }, ...tail)
      }
      const used = 1 + runs.reduce((n, r) => n + r.text.length, 0)
      // No × on the chip: x (or a click on `x: remove`) removes the selected one.
      runs.push({ text: ' '.repeat(Math.max(1, CHIP - used)) })
      const edge = selected === key ? { text: '▎', color: 'suggestion' } : { text: ' ' }
      return Box({
        key: `pr-cards-chip-${key}`, flexDirection: 'row', flexShrink: 0,
        children: [
          // One focus stop per chip, so ↑ ↓ step chip by chip.
          Button({
            key: `pr-cards-select-${key}`, label: `select #${t.number}`, plain: true,
            onPress: () => { selected = key; armed = null; $.ui.invalidate('ui.render') },
            children: [edge, ...runs].map((r) => Text({ color: r.color, bold: 'bold' in r ? r.bold : undefined, children: [r.text] })),
          }),
        ],
      })
    }

    // A hotkey button drawn plain: the key in the accent color, then its label (`a: approve`).
    const hotkey = (letter: string, label: string, onPress: () => unknown) => Button({ key: `pr-cards-${letter}`, hotkey: letter, label, plain: true, onPress })

    const picked = tracked.find((t) => keyFor(t.repo, t.number) === selected)
    const item = picked ? cache.get(keyFor(picked.repo, picked.number))?.item : undefined
    const keys: RenderElement[] = []
    if (picked) {
      const key = keyFor(picked.repo, picked.number)
      if (item) {
        const isOpen = item.kind === 'pr' && (item.state === 'OPEN' || item.state === 'DRAFT')
        const runIds = [...new Set((item.failing ?? []).flatMap((f) => /\/actions\/runs\/(\d+)/.exec(f.url ?? '')?.[1] ?? []))]
        const refresh = () => { cache.delete(key); want($, { repo: item.repo, number: item.number, label: '' }) }
        const web = ['gh', item.kind === 'pr' ? 'pr' : 'issue', 'view', String(item.number), '--repo', item.repo, '--web']
        if (isOpen && item.author !== viewer) {
          keys.push(hotkey('a', armed === key ? 'press a again to approve' : 'approve', async () => {
            if (armed !== key) { armed = key; $.ui.invalidate('ui.render'); return }
            armed = null
            await act($, ['gh', 'pr', 'review', String(item.number), '--repo', item.repo, '--approve'], `approved #${item.number}`)
            refresh()
          }))
          // A review that asks for changes needs a comment: it opens the PR in the browser.
          keys.push(hotkey('r', 'request changes', () => act($, web, `opened #${item.number} to request changes`)))
        }
        if (runIds.length) {
          keys.push(hotkey('f', 're-run failed', async () => {
            for (const run of runIds) await act($, ['gh', 'run', 'rerun', run, '--failed', '--repo', item.repo], `re-running the failed jobs of #${item.number}`)
            refresh()
          }))
        }
        keys.push(hotkey('o', 'open', () => act($, web, `opened #${item.number}`)))
        keys.push(hotkey('c', 'copy link', () => copyLink($, item, e.surface)))
      }
      keys.push(hotkey('x', 'remove', () => untrack($, key)))
    }

    // Each group fills rows of `perRow` chips; only its first row carries the label.
    const groups: [string, Tracked[]][] = [['needs you', []], ['waiting', []], ['done', []]]
    for (const t of tracked) groups[groupOf(cache.get(keyFor(t.repo, t.number))?.item)]![1].push(t)
    const rows: RenderElement[] = []
    for (const [name, list] of groups) {
      for (let i = 0; i < list.length; i += perRow) {
        rows.push(Box({
          flexDirection: 'row', paddingLeft: 2 + INDENT,
          children: [
            Text({ color: C.dim, children: [(i ? '' : name).padEnd(LABEL)] }),
            Box({ flexDirection: 'row', columnGap: 1, children: list.slice(i, i + perRow).map(chip) }),
          ],
        }))
      }
    }
    // Design P3: the title on a bar of Claude Code's orange across the band, bold, in the theme's
    // inverse text color. A Box's background leaves empty cells bare, so the text runs the width.
    // A click on it folds the chips away and back: the engine's own collapse (ctrl+x ctrl+a, [-])
    // hides the whole band, this bar included.
    const label = folded ? ` ▸ Tracked PRs · ${tracked.length}` : ' ▾ Tracked PRs'
    const hint = Box({
      flexDirection: 'row', paddingLeft: 2, marginTop: 1,
      children: [Button({
        key: 'pr-cards-fold', label: folded ? 'show the tracked PRs' : 'hide the tracked PRs', plain: true,
        onPress: () => { folded = !folded; $.ui.invalidate('ui.render') },
        children: [Text({ color: 'inverseText', backgroundColor: 'claude', bold: true, children: [label.padEnd(columns)] })],
      })],
    })
    const keyRow = keys.length ? [Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 3, paddingLeft: 2, children: keys })] : []
    const ours = Box({ flexDirection: 'column', children: folded ? [hint] : [hint, ...rows, ...keyRow] })
    return theirs ? Box({ flexDirection: 'column', children: [ours, theirs] }) : ours
  })
}
