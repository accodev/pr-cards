import type { EngineInterface, Register, RenderElement } from 'claude-code'

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
  additions?: number
  deletions?: number
  changedFiles?: number
  review?: string
  checks?: Checks
  // The failing checks, each with the page of its run.
  failing?: { name: string; url?: string }[]
  approvedBy?: string[]
  changesBy?: string[]
  threads?: { path: string; line: number | null }[]
  files?: { path: string; additions: number; deletions: number }[]
  comments?: number
}
type Entry = { item?: Item; error?: string; at: number; loading: boolean }
type Ref = { repo: string | null; number: number; label: string }

const TTL_MS = 60_000
const BATCH = 40
// `#1234`, `owner/repo#1234` or a GitHub pull or issue URL; a `#` after a word character, `[`, `#` or `/` is a heading, an anchor or a link label.
const REF = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)|(?<![\w[#/])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g
// A table column of bare numbers is a list of PRs or issues when its header says so.
const NUMBER_HEADER = /^(#|pr|prs|pull|issue|issues|number|no\.?)$/i
const C = { open: 'ansi256(2)', merged: 'ansi256(5)', closed: 'ansi256(1)', draft: 'ansi256(8)', warn: 'ansi256(3)', link: 'ansi256(4)', dim: 'ansi256(8)', code: 'ansi256(6)' }
const STATE_COLOR: Record<string, string> = { OPEN: C.open, DRAFT: C.draft, MERGED: C.merged, CLOSED: C.closed, COMPLETED: C.merged, NOT_PLANNED: C.draft }
const STATE_WORD: Record<string, string> = { OPEN: 'Open', DRAFT: 'Draft', MERGED: 'Merged', CLOSED: 'Closed', COMPLETED: 'Closed', NOT_PLANNED: 'Not planned' }
const REVIEW_WORD: Record<string, string> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'review required' }
const DOT = '⬤'
const CARD_WIDTH = 66

const cache = new Map<string, Entry>()
const expanded = new Set<string>()
// The session folder's GitHub repo: undefined until asked, null when it has none.
let cwdRepo: string | null | undefined
let cwdRepoAsked = false
const queue = new Map<string, Set<number>>()
let flushQueued = false
// The signed-in GitHub user: their own reviews read "you", as in the mockup.
let viewer = ''

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
  | { kind: 'table'; header: string[]; rows: string[][]; numbered: boolean[] }

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line)
const isRule = (line: string) => /^\s*\|[\s:|-]+\|\s*$/.test(line)
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/

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
      i += 2
      while (i < lines.length && isTableRow(lines[i]!)) rows.push(cells(lines[i++]!))
      out.push({ kind: 'table', header, rows, numbered: header.map((h) => NUMBER_HEADER.test(h)) })
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
          : [b.header, b.header.map(() => '---'), ...b.rows].map((r) => `| ${r.join(' | ')} |`).join('\n')

function blockRefs(b: Block): Ref[] {
  if (b.kind === 'markdown') return []
  if (b.kind !== 'table') return refsIn(blockText(b))
  return b.rows.flatMap((row) => row.flatMap((cell, c) => (b.numbered[c] && /^\d{1,7}$/.test(cell) ? [{ repo: null, number: Number(cell), label: cell }] : refsIn(cell))))
}

// ---------- Loading from GitHub ----------

function askCwdRepo($: EngineInterface) {
  if (cwdRepoAsked) return
  cwdRepoAsked = true
  void $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { timeoutMs: 15_000 })
    .then((out) => { cwdRepo = out.exitCode === 0 && out.stdout.trim() ? out.stdout.trim() : null })
    .catch(() => { cwdRepo = null })
    .finally(() => $.ui.invalidate('ui.render'))
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
  ... on PullRequest { number title url state isDraft author { login } additions deletions changedFiles reviewDecision createdAt mergedAt closedAt
    statusCheckRollup { contexts(first: 100) { totalCount checkRunCountsByState { state count } statusContextCountsByState { state count }
      nodes { __typename ... on CheckRun { name conclusion detailsUrl } ... on StatusContext { context state targetUrl } } } }
    latestReviews(first: 20) { nodes { state author { login } } }
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
    const out = await $.process.run(['gh', 'api', 'graphql', '-f', `query=${query}`], { timeoutMs: 20_000 })
    const body = JSON.parse(out.stdout || '{}') as { data?: { viewer?: { login: string }; repository?: Record<string, Raw | null> | null }; errors?: { message: string }[] }
    viewer = body.data?.viewer?.login ?? viewer
    const found = body.data?.repository
    if (!found) return fail(body.errors?.[0]?.message ?? (out.stderr.trim().split('\n')[0] || `gh exited ${out.exitCode}`))
    for (const n of numbers) {
      const raw = found[`n${n}`]
      cache.set(keyFor(repo, n), raw ? { at: Date.now(), loading: false, item: toItem(repo, raw) } : { at: Date.now(), loading: false, error: `no PR or issue #${n} in ${repo}` })
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
  createdAt?: string; mergedAt?: string | null; closedAt?: string | null
  statusCheckRollup?: {
    contexts: {
      totalCount: number; checkRunCountsByState?: Count[]; statusContextCountsByState?: Count[]
      nodes?: { __typename: string; name?: string; conclusion?: string | null; detailsUrl?: string | null; context?: string; state?: string; targetUrl?: string | null }[]
    }
  } | null
  latestReviews?: { nodes: { state: string; author?: { login: string } | null }[] }
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
    return { kind: 'issue', number: raw.number, repo, title: raw.title, url: raw.url, state, author, when, comments: raw.comments?.totalCount ?? 0 }
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
    additions: raw.additions, deletions: raw.deletions, changedFiles: raw.changedFiles,
    review: raw.reviewDecision ?? undefined, checks: { ok, failed, pending: Math.max(0, total - ok - failed), total }, failing,
    approvedBy: by('APPROVED'), changesBy: by('CHANGES_REQUESTED'),
    threads: (raw.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved).map((t) => ({ path: t.path, line: t.line })),
    files: raw.files?.nodes ?? [],
  }
}

const color = (item: Item) => STATE_COLOR[item.state] ?? C.dim
const who = (login: string) => (login === viewer ? 'you' : `@${login}`)
const short = (url: string) => url.replace(/^https:\/\//, '')

// ---------- Drawing ----------

export const register: Register = (on) => {
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const parsed = blocks(e.props.text)
    const refs = parsed.flatMap(blockRefs)
    if (!refs.length) return next(e)
    for (const r of refs) want($, r)

    const { Box, Text, Markdown, Link } = $.ui.resolve(e)
    const id = `pr-${e.requestId}`
    const columns = Math.max(40, (e.viewport?.columns ?? 100) - 2)
    let serial = 0

    type Part = string | RenderElement
    const line = (children: Part[], c?: string) => Text({ color: c, children })
    const span = (text: string, c?: string, extra: { bold?: boolean; italic?: boolean; underline?: boolean; backgroundColor?: string } = {}) => Text({ color: c, ...extra, children: [text] })
    const badge = (item: Item) => span(` ${STATE_WORD[item.state] ?? item.state} `, 'ansi256(0)', { backgroundColor: color(item), bold: true })

    // A card is drawn as text rows padded to its full width: a Box background paints only the cells
    // that hold text, so the transcript under a short row would show through.
    // `href` draws the run as a Link: an OSC 8 hyperlink that ctrl+click opens, inside the filled row.
    type Seg = { text: string; color?: string; bold?: boolean; underline?: boolean; backgroundColor?: string; href?: string }
    const profile = (login: string) => `https://github.com/${login}`
    // `@login` linked to the profile; the signed-in user reads "you", unlinked.
    const person = (login: string, c?: string): Seg => (login === viewer ? { text: 'you', color: c } : { text: `@${login}`, color: c ?? C.link, underline: true, href: profile(login) })
    // A run that ctrl+click opens: underlined in its own color, plain text when there is no target.
    const linked = (text: string, href: string | undefined, c?: string): Seg => (href ? { text, color: c, underline: true, href } : { text, color: c })
    // The title with its `#123`, `owner/repo#123` and GitHub URLs as links; GitHub sends an issue URL of a PR to the PR.
    const titleSegs = (item: Item): Seg[] =>
      pieces(item.title).map((p) =>
        'ref' in p
          ? { text: p.ref.label, color: C.link, bold: true, underline: true, href: `https://github.com/${p.ref.repo ?? item.repo}/issues/${p.ref.number}` }
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
        return Text({
          backgroundColor: BG,
          children: [
            '  ',
            ...row.map((s) => {
              const run = Text({ color: s.color, bold: s.bold, underline: s.underline, backgroundColor: s.backgroundColor ?? BG, children: [s.text] })
              return s.href ? Link({ href: s.href, children: [run] }) : run
            }),
            ' '.repeat(Math.max(0, INNER - width) + 2),
          ],
        })
      })
    }
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
          seg('✔', C.open), seg(' '), linked(`${c.ok} of ${c.total} checks`, `${item.url}/checks`),
          ...(item.failing?.length
            ? [seg(' · '), seg('✖ ', C.closed), linked(item.failing[0]!.name, item.failing[0]!.url, C.closed), ...(item.failing.length > 1 ? [seg(` +${item.failing.length - 1}`, C.closed)] : [])]
            : []),
          ...(c.pending ? [seg(' · '), seg(`● ${c.pending} running`, C.warn)] : []),
        ])
      }
      const reviews: Seg[] = []
      if (item.approvedBy?.length) reviews.push(seg('✔', C.open), seg(' approved by '), ...people(item.approvedBy))
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
        [seg(short(item.url), C.link, { underline: true, href: item.url })],
        [seg('─'.repeat(INNER), C.dim)],
        [seg('ctrl+click opens a link', C.dim)],
      ])

    // A reference where the text has it: the state dot, the number as a link, the card on hover.
    const reference = (ref: Ref) => {
      const entry = entryOf(ref)
      const item = entry?.item
      // A gray filled dot is a draft; loading is hollow and a failed lookup a cross, so neither reads as a state.
      const dot = item ? span(`${DOT} `, color(item)) : entry?.error ? span('✖ ', C.closed) : span('○ ', C.dim)
      const label = item
        ? Markdown({ key: `${id}-link-${serial}`, text: `[${ref.label}](${item.url})`, pressableLinks: [item.url], onLinkPress: (link) => toggle(link.href) })
        : span(ref.label, C.link, { underline: true })
      const pop = item ? [card(item)] : entry?.error ? [popup([[seg(entry.error, C.closed)]])] : []
      return Box({ key: `${id}-ref-${serial++}`, flexShrink: 0, children: [dot, label, ...pop] })
    }

    const toggle = (href: string) => {
      const k = `${id}:${href}`
      if (expanded.has(k)) expanded.delete(k)
      else expanded.add(k)
      $.ui.invalidate('ui.render')
    }

    type Style = { bold?: boolean; italic?: boolean }

    // Plain words that wrap one by one, with the references among them drawn in place.
    const words = (text: string, style: Style): RenderElement[] =>
      pieces(text).flatMap((p) =>
        'ref' in p ? [reference(p.ref)] : p.text.split(/(?<=\s)/).filter(Boolean).map((w) => span(w.replace(/\s+$/, ' '), undefined, { ...style })))

    // Inline markdown over the whole line first, references second: a reference can sit inside a bold
    // or italic span, and splitting at it first would leave the span's markers unmatched, drawn as `**`.
    const flow = (text: string, base: Style = {}): RenderElement[] => {
      const out: RenderElement[] = []
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
          out.push(span(text.slice(i + 1, code), C.code, { bold: style.bold }))
          i = code + 1
        } else if (link) {
          flush()
          out.push(Markdown({ text: link[0] }))
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

    const width = (cell: string, numbered: boolean) =>
      numbered && /^\d{1,7}$/.test(cell)
        ? cell.length + 2
        : pieces(cell).reduce((n, p) => n + ('ref' in p ? p.ref.label.length + 2 : p.text.replace(/\*\*|`/g, '').length), 0)

    const table = (b: Extract<Block, { kind: 'table' }>) => {
      const count = b.header.length
      const natural = b.header.map((h, c) => Math.max(h.length, ...b.rows.map((r) => width(r[c] ?? '', b.numbered[c]!))))
      const room = columns - 2 * (count - 1)
      const widths = [...natural]
      // Shrink the widest column until the table fits; its cells wrap.
      while (widths.reduce((a, w) => a + w, 0) > room) {
        const widest = widths.indexOf(Math.max(...widths))
        if (widths[widest]! <= 8) break
        widths[widest]!--
      }
      const cell = (text: string, c: number, header: boolean) =>
        Box({
          width: widths[c], flexShrink: 0, flexDirection: 'row', flexWrap: 'wrap',
          children: header ? [span(text, undefined, { bold: true })]
            : b.numbered[c] && /^\d{1,7}$/.test(text) ? [reference({ repo: null, number: Number(text), label: text })]
              : flow(text),
        })
      const total = widths.reduce((a, w) => a + w, 0) + 2 * (count - 1)
      return Box({
        flexDirection: 'column',
        children: [
          Box({ flexDirection: 'row', columnGap: 2, children: b.header.map((h, c) => cell(h, c, true)) }),
          span('─'.repeat(total), C.dim),
          ...b.rows.map((r) => Box({ flexDirection: 'row', columnGap: 2, children: b.header.map((_, c) => cell(r[c] ?? '', c, false)) })),
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

    // The mockup's expanded panel: checks, reviews and threads, files.
    const column = (title: string, rows: RenderElement[]) => Box({ flexDirection: 'column', flexGrow: 1, width: 0, children: [span(title, C.dim), ...rows] })
    const panel = (item: Item) => {
      const c = item.checks
      const parts =
        item.kind === 'pr' && c
          ? [
              column(`CHECKS ${c.ok}/${c.total}`, [
                ...(item.failing ?? []).slice(0, 4).map((f) => line([span('✖', C.closed), ' ', f.url ? Link({ href: f.url, children: [span(f.name, undefined, { underline: true })] }) : f.name])),
                ...(c.pending ? [line([span('●', C.warn), ` ${c.pending} running`])] : []),
                line([span('✔', C.open), ` ${c.ok} passed`]),
              ]),
              column('REVIEWS', [
                ...(item.approvedBy ?? []).map((l) => line([span('✔', C.open), ` ${who(l)} approved`])),
                ...(item.changesBy ?? []).map((l) => line([span('●', C.warn), ` ${who(l)}: changes requested`])),
                ...(!item.approvedBy?.length && !item.changesBy?.length ? [span('none yet', C.dim)] : []),
                ...(item.threads?.length ? [span(`OPEN THREADS ${item.threads.length}`, C.dim), ...item.threads.slice(0, 3).map((t) => line([`${t.path.split('/').pop()}${t.line ? `:${t.line}` : ''}`]))] : []),
              ]),
              column(`FILES ${item.changedFiles}`, [
                ...(item.files ?? []).map((f) => line([`${f.path.split('/').pop()} `, span(`+${f.additions}`, C.open), ' ', span(`−${f.deletions}`, C.closed)])),
                ...((item.changedFiles ?? 0) > (item.files?.length ?? 0) ? [span(`+ ${(item.changedFiles ?? 0) - (item.files?.length ?? 0)} more files`, C.dim)] : []),
              ]),
            ]
          : [column('ISSUE', [line([`@${item.author} · ${item.when} · ${item.comments} comments`], C.dim)])]
      return Box({
        flexDirection: 'column', borderStyle: 'round', borderColor: C.dim, paddingX: 1, rowGap: 1,
        children: [
          line([badge(item), '  ', span(`#${item.number} ${item.title}`, undefined, { bold: true })]),
          Box({ flexDirection: 'row', columnGap: 3, children: parts }),
          Markdown({ text: `[Open ${short(item.url)}](${item.url})` }),
        ],
      })
    }

    const drawn = parsed.map(draw)
    const open = [...new Map(refs.flatMap((r) => {
      const item = entryOf(r)?.item
      return item && expanded.has(`${id}:${item.url}`) ? [[item.url, item] as const] : []
    })).values()]
    return Box({ flexDirection: 'column', rowGap: 1, children: [...drawn, ...open.map(panel)] })
  })
}
