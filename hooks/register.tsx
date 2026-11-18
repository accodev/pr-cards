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
  additions?: number
  deletions?: number
  changedFiles?: number
  review?: string
  checks?: Checks
  comments?: number
}
type Entry = { item?: Item; error?: string; at: number; loading: boolean }
type Ref = { match: string; index: number; repo: string | null; number: number; replace: (item: Item) => string }

const TTL_MS = 60_000
const BATCH = 40
// `#1234`, `owner/repo#1234` or a GitHub pull or issue URL; a `#` after a word character, `[`, `#` or `/` is a heading, an anchor or a link label.
const REF = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)|(?<![\w[#/])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g
// A table column of bare numbers is a list of PRs or issues when its header says so.
const NUMBER_HEADER = /^(#|pr|prs|pull|issue|issues|number|no\.?)$/i
const C = { open: 'ansi256(2)', merged: 'ansi256(5)', closed: 'ansi256(1)', draft: 'ansi256(8)', warn: 'ansi256(3)', link: 'ansi256(4)', dim: 'ansi256(8)' }
// Nerd Font octicons: the same marks GitHub draws next to a PR or an issue.
const ICON = {
  pr: { OPEN: '', DRAFT: '', MERGED: '', CLOSED: '' },
  issue: { OPEN: '', COMPLETED: '', NOT_PLANNED: '' },
} as const
const STATE_COLOR: Record<string, string> = { OPEN: C.open, DRAFT: C.draft, MERGED: C.merged, CLOSED: C.closed, COMPLETED: C.merged, NOT_PLANNED: C.draft }
const STATE_WORD: Record<string, string> = { OPEN: 'Open', DRAFT: 'Draft', MERGED: 'Merged', CLOSED: 'Closed', COMPLETED: 'Closed', NOT_PLANNED: 'Not planned' }
const REVIEW_WORD: Record<string, string> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'review required' }

const cache = new Map<string, Entry>()
const expanded = new Set<string>()
// The session folder's GitHub repo: undefined until asked, null when it has none.
let cwdRepo: string | null | undefined
let cwdRepoAsked = false
const queue = new Map<string, Set<number>>()
let flushQueued = false

const keyFor = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`
const repoOf = (r: Ref) => r.repo ?? cwdRepo

function findRefs(text: string): Ref[] {
  const masked = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => ' '.repeat(m.length))
  const refs: Ref[] = []
  for (const m of masked.matchAll(REF)) {
    const isUrl = m[1] !== undefined
    refs.push({
      match: m[0], index: m.index!, repo: m[1] ?? m[3] ?? null, number: Number(m[2] ?? m[4]),
      replace: (item) => `[${icon(item)} #${item.number}${isUrl ? ` ${clean(item.title)}` : ''}](${item.url})`,
    })
  }
  return [...refs, ...tableRefs(masked)].sort((a, b) => a.index - b.index)
}

// Bare numbers in a markdown table column headed `#`, `PR`, `Issue`...
function tableRefs(text: string): Ref[] {
  const refs: Ref[] = []
  let columns: boolean[] = []
  let offset = 0
  let previous = ''
  for (const line of text.split('\n')) {
    const isRow = /^\s*\|.*\|\s*$/.test(line)
    if (!isRow) columns = []
    else if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) columns = cells(previous).map((c) => NUMBER_HEADER.test(c.text.trim()))
    else if (columns.length) {
      cells(line).forEach((c, i) => {
        const m = /^(\s*)(\d{1,7})\s*$/.exec(c.text)
        if (columns[i] && m) refs.push({ match: m[2]!, index: offset + c.start + m[1]!.length, repo: null, number: Number(m[2]), replace: (item) => `[${icon(item)} ${item.number}](${item.url})` })
      })
    }
    previous = line
    offset += line.length + 1
  }
  return refs
}

function cells(line: string) {
  const out: { text: string; start: number }[] = []
  let start = line.indexOf('|') + 1
  for (let i = start; i < line.length; i++) {
    if (line[i] === '|' && line[i - 1] !== '\\') {
      out.push({ text: line.slice(start, i), start })
      start = i + 1
    }
  }
  return out
}

const clean = (title: string) => title.replace(/[[\]]/g, '')
const icon = (item: Item) => (ICON[item.kind] as Record<string, string>)[item.state] ?? '#'
const color = (item: Item) => STATE_COLOR[item.state] ?? C.dim

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
  ... on PullRequest { number title url state isDraft author { login } additions deletions changedFiles reviewDecision
    statusCheckRollup { contexts(first: 1) { totalCount checkRunCountsByState { state count } statusContextCountsByState { state count } } } }
  ... on Issue { number title url state stateReason author { login } comments { totalCount } }`

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
  const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${numbers.map((n) => `n${n}: issueOrPullRequest(number: ${n}) { ${FIELDS} }`).join('\n')} } }`
  const fail = (error: string) => numbers.forEach((n) => cache.set(keyFor(repo, n), { at: Date.now(), loading: false, error }))
  try {
    const out = await $.process.run(['gh', 'api', 'graphql', '-f', `query=${query}`], { timeoutMs: 20_000 })
    const body = JSON.parse(out.stdout || '{}') as { data?: { repository?: Record<string, Raw | null> | null }; errors?: { message: string }[] }
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
  statusCheckRollup?: { contexts: { totalCount: number; checkRunCountsByState?: Count[]; statusContextCountsByState?: Count[] } } | null
  comments?: { totalCount: number }
}

const OK = ['SUCCESS', 'NEUTRAL', 'SKIPPED']
const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']

function toItem(repo: string, raw: Raw): Item {
  const author = raw.author?.login ?? 'ghost'
  if (raw.__typename === 'Issue') {
    const state = raw.state === 'OPEN' ? 'OPEN' : raw.stateReason === 'NOT_PLANNED' ? 'NOT_PLANNED' : 'COMPLETED'
    return { kind: 'issue', number: raw.number, repo, title: raw.title, url: raw.url, state, author, comments: raw.comments?.totalCount ?? 0 }
  }
  const counts = [...(raw.statusCheckRollup?.contexts.checkRunCountsByState ?? []), ...(raw.statusCheckRollup?.contexts.statusContextCountsByState ?? [])]
  const sum = (states: string[]) => counts.filter((c) => states.includes(c.state)).reduce((a, c) => a + c.count, 0)
  const total = raw.statusCheckRollup?.contexts.totalCount ?? 0
  const ok = sum(OK)
  const failed = sum(FAILED)
  return {
    kind: 'pr', number: raw.number, repo, title: raw.title, url: raw.url,
    state: raw.state === 'OPEN' && raw.isDraft ? 'DRAFT' : raw.state, author,
    additions: raw.additions, deletions: raw.deletions, changedFiles: raw.changedFiles,
    review: raw.reviewDecision ?? undefined, checks: { ok, failed, pending: Math.max(0, total - ok - failed), total },
  }
}

const checkGlyph = (c?: Checks) => (!c || !c.total ? '' : c.failed ? '✖' : c.pending ? '●' : '✔')

function rewrite(text: string, refs: Ref[]) {
  let out = ''
  let at = 0
  for (const r of refs) {
    if (r.index < at) continue
    const repo = repoOf(r)
    const item = repo ? cache.get(keyFor(repo, r.number))?.item : undefined
    out += text.slice(at, r.index) + (item ? r.replace(item) : r.match)
    at = r.index + r.match.length
  }
  return out + text.slice(at)
}

export const register: Register = (on) => {
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const refs = findRefs(e.props.text)
    if (!refs.length) return next(e)
    for (const r of refs) want($, r)

    const { Box, Text, Markdown } = $.ui.resolve(e)
    const id = `pr-${e.requestId}`
    const unique = [...new Map(refs.map((r) => [`${r.repo ?? ''}#${r.number}`, r])).values()]
    const entries = unique.map((ref) => {
      const repo = repoOf(ref)
      return { ref, entry: repo ? cache.get(keyFor(repo, ref.number)) : undefined }
    })
    const items = entries.flatMap((p) => (p.entry?.item ? [p.entry.item] : []))

    const line = (children: (string | RenderElement)[], c?: string) => Text({ color: c, children })
    const head = (item: Item) => line([`${icon(item)} ${STATE_WORD[item.state] ?? item.state}  ${item.repo} #${item.number}`], color(item))
    const facts = (item: Item) =>
      item.kind === 'pr'
        ? [
            line([`@${item.author} · +${item.additions} −${item.deletions} · ${item.changedFiles} files`], C.dim),
            line([`checks ${item.checks!.ok}/${item.checks!.total}${item.checks!.failed ? ` · ${item.checks!.failed} failing` : ''}${item.checks!.pending ? ` · ${item.checks!.pending} running` : ''}`],
              item.checks!.failed ? C.closed : item.checks!.pending ? C.warn : C.open),
            line([`review: ${REVIEW_WORD[item.review ?? ''] ?? 'none'}`]),
          ]
        : [line([`issue · @${item.author} · ${item.comments} comments`], C.dim)]

    const card = (item: Item) =>
      Box({
        position: 'absolute', bottom: 1, left: 0, display: 'none', hover: { display: 'flex' },
        flexDirection: 'column', width: 64, borderStyle: 'round', borderColor: color(item), paddingX: 1,
        children: [head(item), Text({ bold: true, children: [item.title] }), ...facts(item), line([item.url], C.link), line(['click the link to expand · ctrl+click opens'], C.dim)],
      })

    const errorCard = (error: string) =>
      Box({ position: 'absolute', bottom: 1, left: 0, display: 'none', hover: { display: 'flex' }, width: 64, borderStyle: 'round', borderColor: C.closed, paddingX: 1, children: [line([error], C.closed)] })

    const chip = ({ ref, entry }: (typeof entries)[number]) => {
      const item = entry?.item
      const label = item ? ` ${icon(item)} #${item.number} ${checkGlyph(item.checks)} ` : ` #${ref.number} ${entry?.error ? '?' : '…'} `
      const pop = item ? [card(item)] : entry?.error ? [errorCard(entry.error)] : []
      return Box({ key: `${id}-${ref.repo ?? ''}-${ref.number}`, children: [Text({ color: item ? color(item) : C.dim, hover: { inverse: true }, children: [label] }), ...pop] })
    }

    const panel = (item: Item) =>
      Box({
        flexDirection: 'column', borderStyle: 'round', borderColor: color(item), paddingX: 1, marginTop: 1,
        children: [head(item), Text({ bold: true, children: [item.title] }), ...facts(item), line([item.url], C.link)],
      })

    const open = items.filter((item) => expanded.has(`${id}:${item.url}`))
    return Box({
      flexDirection: 'column',
      children: [
        Markdown({
          key: id,
          text: rewrite(e.props.text, refs),
          pressableLinks: items.map((item) => item.url),
          onLinkPress: (link) => {
            const k = `${id}:${link.href}`
            if (expanded.has(k)) expanded.delete(k)
            else expanded.add(k)
            $.ui.invalidate('ui.render')
          },
        }),
        Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, children: entries.map(chip) }),
        ...open.map(panel),
      ],
    })
  })
}
