import type { EngineInterface, Register, RenderElement } from 'claude-code'

type Check = { conclusion?: string; status?: string; state?: string }
type Pr = {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  author: { login: string }
  additions: number
  deletions: number
  changedFiles: number
  reviewDecision: string
  statusCheckRollup: Check[]
}
type Entry = { pr?: Pr; error?: string; at: number; loading: boolean }
type Ref = { match: string; index: number; repo: string | null; number: number }

const TTL_MS = 60_000
const FIELDS = 'number,title,url,state,isDraft,author,additions,deletions,changedFiles,reviewDecision,statusCheckRollup'
// `#1234`, `owner/repo#1234` or a pull URL; a `#` after a word character or `[` is a heading, an anchor or a link label.
const REF = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)|(?<![\w[#/])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g
const C = { open: 'ansi256(2)', merged: 'ansi256(5)', closed: 'ansi256(1)', draft: 'ansi256(8)', warn: 'ansi256(3)', link: 'ansi256(4)', dim: 'ansi256(8)' }

const cache = new Map<string, Entry>()
// Keys of the PRs whose details panel is open, per drawn message.
const expanded = new Set<string>()

const keyOf = (r: { repo: string | null; number: number }) => `${r.repo ?? ''}#${r.number}`

function findRefs(text: string): Ref[] {
  // Fenced and inline code keep their `#123` as written.
  const masked = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => ' '.repeat(m.length))
  const refs: Ref[] = []
  for (const m of masked.matchAll(REF)) {
    const repo = m[1] ?? m[3] ?? null
    const number = Number(m[2] ?? m[4])
    refs.push({ match: m[0], index: m.index!, repo, number })
  }
  return refs
}

function load($: EngineInterface, ref: Ref) {
  const key = keyOf(ref)
  const hit = cache.get(key)
  if (hit && (hit.loading || Date.now() - hit.at < TTL_MS)) return
  cache.set(key, { ...hit, at: Date.now(), loading: true })
  const argv = ['gh', 'pr', 'view', String(ref.number), '--json', FIELDS, ...(ref.repo ? ['--repo', ref.repo] : [])]
  void $.process.run(argv, { timeoutMs: 15_000 })
    .then((out) => {
      if (out.exitCode !== 0) cache.set(key, { at: Date.now(), loading: false, error: out.stderr.trim().split('\n')[0] || `gh exited ${out.exitCode}` })
      else cache.set(key, { at: Date.now(), loading: false, pr: JSON.parse(out.stdout) as Pr })
    })
    .catch((err: unknown) => cache.set(key, { at: Date.now(), loading: false, error: String(err) }))
    .finally(() => $.ui.invalidate('ui.render'))
}

const stateColor = (pr: Pr) => (pr.isDraft ? C.draft : pr.state === 'MERGED' ? C.merged : pr.state === 'CLOSED' ? C.closed : C.open)
const stateWord = (pr: Pr) => (pr.isDraft ? 'Draft' : pr.state[0] + pr.state.slice(1).toLowerCase())
const repoOf = (pr: Pr) => pr.url.replace(/^https:\/\/github\.com\//, '').replace(/\/pull\/\d+$/, '')

function checks(pr: Pr) {
  const all = pr.statusCheckRollup ?? []
  const ok = all.filter((c) => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion ?? c.state ?? '')).length
  const failed = all.filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(c.conclusion ?? c.state ?? '')).length
  return { ok, failed, pending: all.length - ok - failed, total: all.length }
}

function checkGlyph(pr: Pr) {
  const c = checks(pr)
  return c.failed ? '✖' : c.pending ? '●' : c.total ? '✔' : ''
}

const reviewWords: Record<string, string> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'review required' }

// The reply's markdown with each loaded reference turned into a link that names the PR.
function rewrite(text: string, refs: Ref[]) {
  let out = ''
  let at = 0
  for (const r of refs) {
    const pr = cache.get(keyOf(r))?.pr
    out += text.slice(at, r.index)
    out += pr ? `[#${pr.number} ${checkGlyph(pr)} ${pr.title.replace(/[[\]]/g, '')}](${pr.url})` : r.match
    at = r.index + r.match.length
  }
  return out + text.slice(at)
}

export const register: Register = (on) => {
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const refs = findRefs(e.props.text)
    if (!refs.length) return next(e)
    for (const r of refs) load($, r)

    const { Box, Text, Markdown } = $.ui.resolve(e)
    const id = `pr-${e.requestId}`
    const unique = [...new Map(refs.map((r) => [keyOf(r), r])).values()]
    const prs = unique.map((r) => ({ ref: r, entry: cache.get(keyOf(r)) }))
    const loaded = prs.flatMap((p) => (p.entry?.pr ? [p.entry.pr] : []))
    const byUrl = new Map(loaded.map((pr) => [pr.url, pr]))

    const line = (children: (string | RenderElement)[], color?: string) => Text({ color, children })

    const card = (pr: Pr) => {
      const c = checks(pr)
      return Box({
        position: 'absolute', top: 1, left: 0, display: 'none', hover: { display: 'flex' },
        flexDirection: 'column', width: 64, borderStyle: 'round', borderColor: stateColor(pr), paddingX: 1,
        children: [
          line([`${stateWord(pr)}  ${repoOf(pr)} #${pr.number}`], stateColor(pr)),
          Text({ bold: true, children: [pr.title] }),
          line([`@${pr.author.login} · +${pr.additions} −${pr.deletions} · ${pr.changedFiles} files`], C.dim),
          line([`checks ${c.ok}/${c.total}${c.failed ? ` · ${c.failed} failing` : ''}${c.pending ? ` · ${c.pending} running` : ''}`], c.failed ? C.closed : c.pending ? C.warn : C.open),
          line([`review: ${reviewWords[pr.reviewDecision] ?? 'none'}`]),
          line([pr.url], C.link),
          line(['click the link above to expand · ctrl+click opens'], C.dim),
        ],
      })
    }

    const chip = (p: (typeof prs)[number]) => {
      const pr = p.entry?.pr
      const label = pr ? ` #${pr.number} ${checkGlyph(pr)} ` : p.entry?.error ? ` #${p.ref.number} ? ` : ` #${p.ref.number} … `
      return Box({
        key: `${id}-${keyOf(p.ref)}`,
        children: [Text({ color: pr ? stateColor(pr) : C.dim, hover: { inverse: true }, children: [label] }), ...(pr ? [card(pr)] : [])],
      })
    }

    const panel = (pr: Pr) => {
      const c = checks(pr)
      return Box({
        flexDirection: 'column', borderStyle: 'round', borderColor: stateColor(pr), paddingX: 1, marginTop: 1,
        children: [
          line([`${stateWord(pr)}  ${repoOf(pr)} #${pr.number}  ${pr.title}`], stateColor(pr)),
          line([`author @${pr.author.login} · +${pr.additions} −${pr.deletions} in ${pr.changedFiles} files`]),
          line([`checks: ${c.ok} passed, ${c.failed} failed, ${c.pending} running`]),
          line([`review: ${reviewWords[pr.reviewDecision] ?? 'none'}`]),
          line([pr.url], C.link),
        ],
      })
    }

    const open = loaded.filter((pr) => expanded.has(`${id}:${pr.url}`))
    return Box({
      flexDirection: 'column',
      children: [
        Markdown({
          key: id,
          text: rewrite(e.props.text, refs),
          pressableLinks: [...byUrl.keys()],
          onLinkPress: (link) => {
            const k = `${id}:${link.href}`
            if (expanded.has(k)) expanded.delete(k)
            else expanded.add(k)
            $.ui.invalidate('ui.render')
          },
        }),
        Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, children: prs.map(chip) }),
        ...open.map(panel),
      ],
    })
  })
}
