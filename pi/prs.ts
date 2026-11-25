// The parts of the Pi extension that need no Pi host: finding references, the GraphQL query, the
// tracked list and the band's lines. `node --test pi/tests.ts` runs them as they are.

export type Checks = { ok: number; failed: number; pending: number; total: number }
export type Item = {
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
  comments?: number
}
export type Entry = { item?: Item; error?: string; missing?: boolean; at: number; loading: boolean }
export type Ref = { repo: string | null; number: number }
export type Tracked = { repo: string; number: number }
export type SavedList = { at: number; items: Tracked[] }

export const TTL_MS = 60_000
export const BATCH = 40
// A saved list goes once no session has used it for this long.
export const TRACKED_TTL_MS = 14 * 86_400_000

// `#1234`, `owner/repo#1234` or a GitHub pull or issue URL, as the Claude Code mod finds them; a `#`
// after a word character, `[`, `#` or `/` is a heading, an anchor or a link label.
const REF = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)|(?<![\w[#/])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g

export const keyFor = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`
export const label = (r: Ref) => (r.repo ? `${r.repo}#${r.number}` : `#${r.number}`)

// Code spans and blocks, and link labels and targets, hold no references to draw: blank them out
// with spaces, so offsets in the masked text match the original.
const mask = (md: string) => md.replace(/```[\s\S]*?```|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)/g, (m) => ' '.repeat(m.length))

export type Found = Ref & { start: number; end: number; url: boolean }

export function findRefs(md: string): Found[] {
  const found: Found[] = []
  for (const m of mask(md).matchAll(REF)) {
    const url = m[1] !== undefined
    found.push({ repo: url ? m[1]! : m[3] ?? null, number: Number(url ? m[2] : m[4]), start: m.index!, end: m.index! + m[0].length, url })
  }
  return found
}

// The 16 palette slots, as the Claude Code mod draws them: a terminal theme recolors them.
export const SGR = { open: 32, merged: 35, closed: 31, draft: 90, warn: 33, link: 34, dim: 90, code: 36, black: 30 } as const
export type Tone = keyof typeof SGR
export const paint = (tone: Tone, text: string) => `\x1b[${SGR[tone]}m${text}\x1b[39m`
const STATE_TONE: Record<string, Tone> = { OPEN: 'open', DRAFT: 'draft', MERGED: 'merged', CLOSED: 'closed', COMPLETED: 'merged', NOT_PLANNED: 'draft' }
export const toneOf = (item: Item): Tone => STATE_TONE[item.state] ?? 'dim'
export const DOT = '⬤'

// Each reference gets a dot, as the Claude Code mod draws them: the state's color once GitHub
// answered, hollow while loading, a red x when the lookup failed. A URL reads `owner/repo#N`. The
// reference stays text, not a link: Pi opens a link on any click, and a plain click tracks the PR.
// One GitHub does not know, or in a folder without a repo, stays as written.
export function decorate(md: string, lookup: (r: Ref) => Entry | undefined): string {
  let out = ''
  let at = 0
  for (const f of findRefs(md)) {
    const entry = lookup(f)
    if (!entry || entry.missing) continue
    const item = entry.item
    const dot = item ? paint(toneOf(item), DOT) : entry.error ? paint('closed', 'x') : paint('dim', '○')
    const text = f.url ? `${f.repo}#${f.number}` : md.slice(f.start, f.end)
    out += md.slice(at, f.start) + `${dot} ${paint('link', text)}`
    at = f.end
  }
  return out + md.slice(at)
}

// The reference a decorated reply shows at column `col` of a screen line: the dot, a space, then the
// reference. The dot tells a decorated reference from the same text in the editor or a code block.
export function refAt(line: string, col: number): Ref | null {
  // One character per cell, so string offsets are columns.
  const text = plainCells(line).join('')
  for (const m of text.matchAll(/(?:⬤|○|x) ((?:([\w.-]+\/[\w.-]+))?#(\d+))\b/g)) {
    if (col >= m.index! && col < m.index! + m[0].length) return { repo: m[2] ?? null, number: Number(m[3]) }
  }
  return null
}

// A screen line as one character per cell: escape sequences dropped, a wide character's second cell
// a space. Pi's screen lines carry SGR colors and OSC 8 links.
export function plainCells(line: string): string[] {
  const bare = line.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<>]*[ -/]*[@-~]|\x1b[@-_]/g, '')
  const cells: string[] = []
  for (const ch of bare) {
    cells.push(ch)
    if (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1f300}-\u{1faff}]/u.test(ch)) cells.push(' ')
  }
  return cells
}

// The Claude Code mod's query: the band and the card need the same fields.
export const FIELDS = `
  __typename
  ... on PullRequest { number title url state isDraft author { login } additions deletions changedFiles reviewDecision createdAt mergedAt closedAt headRefName baseRefName
    statusCheckRollup { contexts(first: 100) { totalCount checkRunCountsByState { state count } statusContextCountsByState { state count }
      nodes { __typename ... on CheckRun { name conclusion detailsUrl } ... on StatusContext { context state targetUrl } } } }
    latestReviews(first: 20) { nodes { state author { login } } }
    reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
    reviewThreads(first: 100) { nodes { isResolved path line } } }
  ... on Issue { number title url state stateReason author { login } comments { totalCount } createdAt closedAt }`

export function query(repo: string, numbers: number[]) {
  const [owner, name] = repo.split('/')
  return `query { viewer { login } repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${numbers.map((n) => `n${n}: issueOrPullRequest(number: ${n}) { ${FIELDS} }`).join('\n')} } }`
}

type Count = { state: string; count: number }
export type Raw = {
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
  comments?: { totalCount: number }
}

const OK = ['SUCCESS', 'NEUTRAL', 'SKIPPED']
const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']

export function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return ''
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  const [n, unit] = minutes < 60 ? [minutes, 'minute'] : minutes < 1440 ? [Math.round(minutes / 60), 'hour'] : [Math.round(minutes / 1440), 'day']
  return n === 0 ? 'just now' : `${n} ${unit}${n === 1 ? '' : 's'} ago`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// `Nov 18`, as GitHub dates a card; the year only when it is not this one.
export function day(iso?: string) {
  if (!iso) return ''
  const d = new Date(iso)
  const year = d.getUTCFullYear() === new Date().getUTCFullYear() ? '' : `, ${d.getUTCFullYear()}`
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${year}`
}

export function toItem(repo: string, raw: Raw): Item {
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
  const reviews = raw.latestReviews?.nodes ?? []
  const by = (s: string) => reviews.filter((r) => r.state === s).map((r) => r.author?.login ?? 'ghost')
  const state = raw.state === 'OPEN' && raw.isDraft ? 'DRAFT' : raw.state
  const when = state === 'MERGED' ? `merged ${ago(raw.mergedAt)}` : state === 'CLOSED' ? `closed ${ago(raw.closedAt)}` : `opened ${ago(raw.createdAt)}`
  return {
    kind: 'pr', number: raw.number, repo, title: raw.title, url: raw.url, state, author, when,
    created: raw.createdAt, head: raw.headRefName ?? undefined, base: raw.baseRefName ?? undefined,
    additions: raw.additions, deletions: raw.deletions, changedFiles: raw.changedFiles,
    review: raw.reviewDecision ?? undefined,
    checks: { ok, failed, pending: Math.max(0, total - ok - failed), total },
    failing: (contexts?.nodes ?? []).filter((c) => FAILED.includes(c.conclusion ?? c.state ?? '')).map((c) => ({ name: c.name ?? c.context ?? '?', url: c.detailsUrl ?? c.targetUrl ?? undefined })),
    approvedBy: by('APPROVED'), changesBy: by('CHANGES_REQUESTED'),
    requested: (raw.reviewRequests?.nodes ?? []).flatMap((r) => r.requestedReviewer?.login ?? []),
    threads: (raw.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved).map((t) => ({ path: t.path, line: t.line })),
  }
}

// `2d`, `5h`, `20m`: how long ago, for a chip.
export function age(iso?: string, now = Date.now()) {
  if (!iso) return ''
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`
}

// The band's group: 0 needs you (your review is asked for, or your PR fails its checks or got
// changes requested), 1 waiting (open, or not loaded yet), 2 done (merged or closed).
export function groupOf(item: Item | undefined, viewer: string) {
  if (!item) return 1
  if (item.state !== 'OPEN' && item.state !== 'DRAFT') return 2
  if (!viewer) return 1
  if (item.requested?.includes(viewer)) return 0
  if (item.author === viewer && (item.checks?.failed || item.review === 'CHANGES_REQUESTED')) return 0
  return 1
}

// ---------- The tracked list ----------

const isTracked = (t: unknown): t is Tracked => !!t && typeof (t as Tracked).repo === 'string' && typeof (t as Tracked).number === 'number'
export const savedItems = (saved: unknown) => (Array.isArray((saved as SavedList | undefined)?.items) ? (saved as SavedList).items.filter(isTracked) : [])
export const sameList = (a: Tracked[], b: Tracked[]) => a.length === b.length && a.every((t, i) => keyFor(t.repo, t.number) === keyFor(b[i]!.repo, b[i]!.number))
export const withTracked = (items: Tracked[], t: Tracked) => (items.some((i) => keyFor(i.repo, i.number) === keyFor(t.repo, t.number)) ? items : [...items, t])
export const withoutTracked = (items: Tracked[], key: string) => items.filter((t) => keyFor(t.repo, t.number) !== key)

// The list's name in the store: one per GitHub repo, its worktrees and clones included, or per folder
// outside git; one per session when sharing is off.
export function listName(share: boolean, sessionId: string, repo: string | null, cwd: string) {
  if (!share) return `session.${sessionId}`
  return repo ? `repo.${repo}` : `dir.${cwd}`
}

// Lists no session has used for TRACKED_TTL_MS go.
export function pruned(lists: Record<string, SavedList>, keep: string, now = Date.now()) {
  return Object.fromEntries(Object.entries(lists).filter(([k, v]) => k === keep || (v && typeof v.at === 'number' && now - v.at <= TRACKED_TTL_MS)))
}

// ---------- The band ----------

export type Band = {
  tracked: Tracked[]
  lookup: (t: Tracked) => Entry | undefined
  viewer: string
  selected: string | null
  armed: string | null
  folded: boolean
  perRow: number
  // Keys are listed only while the band has the keyboard.
  focused: boolean
}
export type Style = { bar: (text: string) => string; mark: (text: string) => string; bold: (text: string) => string }
// What a click at a row and column hits: the bar folds the band, a chip selects its PR.
export type Hit = { row: number; from: number; to: number; target: 'bar' | string }

export const LABEL = 10
// Design I3: the group rows start four cells right of the Tracked PRs bar, as its contents.
export const INDENT = 4
const GROUPS = ['needs you', 'waiting', 'done']

const cut = (s: string, n: number) => (n <= 0 ? '' : s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s)

export function chipWidth(columns: number, perRow: number) {
  return Math.max(24, Math.min(44, Math.floor((columns - INDENT - LABEL) / perRow) - 1))
}

// One chip, `width` cells: the edge (▎ when selected), the dot, number, title, author and age, the
// checks' mark, then spaces to its end.
export function chip(t: Tracked, entry: Entry | undefined, width: number, selected: boolean, s: Style): string {
  const item = entry?.item
  const runs: { text: string; tone?: Tone; bold?: boolean }[] = []
  if (!item) runs.push({ text: `${entry?.error ? 'x' : '○'} `, tone: entry?.error ? 'closed' : 'dim' }, { text: `#${t.number}`, tone: 'link', bold: true })
  else {
    const c = item.checks
    const tail = [
      // A long login would eat the title: ten cells at most.
      { text: ` ${cut(item.author, 10)} ${age(item.created)}`, tone: 'dim' as Tone },
      ...(c?.total ? [{ text: ` ${c.failed ? 'x' : c.pending ? '●' : '✓'}`, tone: (c.failed ? 'closed' : c.pending ? 'warn' : 'open') as Tone }] : []),
    ]
    const head = `#${t.number} `
    const room = Math.max(4, width - 3 - head.length - tail.reduce((n, r) => n + r.text.length, 0) - 1)
    runs.push({ text: `${DOT} `, tone: toneOf(item) }, { text: head, tone: 'link', bold: true }, { text: cut(item.title, room) }, ...tail)
  }
  const used = 1 + runs.reduce((n, r) => n + r.text.length, 0)
  const body = runs.map((r) => {
    const text = r.tone ? paint(r.tone, r.text) : r.text
    return r.bold ? s.bold(text) : text
  }).join('')
  return (selected ? s.mark('▎') : ' ') + body + ' '.repeat(Math.max(1, width - used))
}

export function keysFor(b: Band): string[] {
  const picked = b.tracked.find((t) => keyFor(t.repo, t.number) === b.selected)
  if (!picked) return ['↑↓ move', 'esc back']
  const item = b.lookup(picked)?.item
  const keys: string[] = []
  if (item) {
    const isOpen = item.kind === 'pr' && (item.state === 'OPEN' || item.state === 'DRAFT')
    if (isOpen && item.author !== b.viewer) keys.push(b.armed === b.selected ? 'a press again to approve' : 'a approve', 'r request changes')
    if (runIds(item).length) keys.push('f re-run failed')
    keys.push('o open', 'c copy link')
  }
  keys.push('x remove', 'esc back')
  return keys
}

export const runIds = (item: Item) => [...new Set((item.failing ?? []).flatMap((f) => /\/actions\/runs\/(\d+)/.exec(f.url ?? '')?.[1] ?? []))]

// The tracked list in groups (needs you, waiting, done), the same order the band draws it in.
export function ordered(b: Pick<Band, 'tracked' | 'lookup' | 'viewer'>): Tracked[][] {
  const groups: Tracked[][] = [[], [], []]
  for (const t of b.tracked) groups[groupOf(b.lookup(t)?.item, b.viewer)]!.push(t)
  return groups
}

// The band as lines of `width` cells: a blank row, the Tracked PRs bar, then each group's chips,
// `perRow` to a row with the group's name before its first row, then the keys when focused.
export function bandLines(b: Band, width: number, s: Style): { lines: string[]; hits: Hit[] } {
  if (!b.tracked.length) return { lines: [], hits: [] }
  const columns = Math.max(40, width) - 2
  const title = b.folded ? ` ▸ Tracked PRs · ${b.tracked.length}` : ' ▾ Tracked PRs'
  const lines = ['', '  ' + s.bar(s.bold(title.padEnd(columns)))]
  const hits: Hit[] = [{ row: 1, from: 2, to: 2 + columns, target: 'bar' }]
  if (b.folded) return { lines, hits }
  const width1 = chipWidth(columns, b.perRow)
  ordered(b).forEach((list, g) => {
    for (let i = 0; i < list.length; i += b.perRow) {
      const row = list.slice(i, i + b.perRow)
      let col = 2 + INDENT + LABEL
      for (const t of row) {
        hits.push({ row: lines.length, from: col, to: col + width1, target: keyFor(t.repo, t.number) })
        col += width1 + 1
      }
      const chips = row.map((t) => chip(t, b.lookup(t), width1, b.selected === keyFor(t.repo, t.number), s)).join(' ')
      lines.push(' '.repeat(2 + INDENT) + paint('dim', (i ? '' : GROUPS[g]!).padEnd(LABEL)) + chips)
    }
  })
  if (b.focused) lines.push('  ' + keysFor(b).map((k) => `${s.bold(k.slice(0, k.indexOf(' ')))}${paint('dim', k.slice(k.indexOf(' ')))}`).join('   '))
  return { lines, hits }
}

// The chip one step from `selected` in the band's order: ↑ and ← go back, ↓, → and Tab forward.
export function step(b: Pick<Band, 'tracked' | 'lookup' | 'viewer' | 'selected'>, by: number): string | null {
  const flat = ordered(b).flat().map((t) => keyFor(t.repo, t.number))
  if (!flat.length) return null
  const at = b.selected ? flat.indexOf(b.selected) : -1
  if (at < 0) return flat[by > 0 ? 0 : flat.length - 1]!
  return flat[Math.max(0, Math.min(flat.length - 1, at + by))]!
}

// ---------- Copying a link as rich text ----------

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// The Windows clipboard's HTML format: a header of byte offsets around the fragment.
export function cfHtml(fragment: string) {
  const pre = '<html><body><!--StartFragment-->'
  const post = '<!--EndFragment--></body></html>'
  const bytes = (x: string) => Buffer.byteLength(x, 'utf8')
  const header = (a: number, b: number, c: number, d: number) =>
    `Version:0.9\r\nStartHTML:${String(a).padStart(10, '0')}\r\nEndHTML:${String(b).padStart(10, '0')}\r\nStartFragment:${String(c).padStart(10, '0')}\r\nEndFragment:${String(d).padStart(10, '0')}\r\n`
  const startHtml = bytes(header(0, 0, 0, 0))
  const startFragment = startHtml + bytes(pre)
  const endFragment = startFragment + bytes(fragment)
  const endHtml = endFragment + bytes(post)
  return header(startHtml, endHtml, startFragment, endFragment) + pre + fragment + post
}

// `acme/shop#58` as a link, then the title: what a chat shows when it takes rich text.
export function linkFormats(item: Item) {
  const name = `${item.repo}#${item.number}`
  return { name, html: cfHtml(`<a href="${escapeHtml(item.url)}">${escapeHtml(name)}</a> ${escapeHtml(item.title)}`), text: `${name} ${item.title} ${item.url}` }
}
