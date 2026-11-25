import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bandLines, cfHtml, chip, chipWidth, decorate, findRefs, groupOf, keyFor, keysFor, listName, pruned, query, sameList, step, toItem,
  withTracked, withoutTracked, TRACKED_TTL_MS, type Band, type Entry, type Item, type Raw, type Style, type Tracked,
} from './prs.ts'

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const style: Style = { bar: (s) => `[${s}]`, mark: (s) => s, bold: (s) => s }
const item = (over: Partial<Item> = {}): Item => ({
  kind: 'pr', number: 1319, repo: 'acme/pos-api', title: 'Fix the till rounding', url: 'https://github.com/acme/pos-api/pull/1319',
  state: 'OPEN', author: 'lgreen', created: new Date(Date.now() - 2 * 86_400_000).toISOString(), checks: { ok: 3, failed: 1, pending: 0, total: 4 },
  ...over,
})
const entry = (i: Item): Entry => ({ item: i, at: Date.now(), loading: false })

test('finds #N, owner/repo#N and GitHub URLs, and skips code, links and headings', () => {
  const md = 'See #12 and acme/shop#58, https://github.com/acme/pos-api/pull/1319, `#7`, [#8](https://x.y/8), a#9 and ##10'
  assert.deepEqual(findRefs(md).map((f) => [f.repo, f.number, f.url]), [[null, 12, false], ['acme/shop', 58, false], ['acme/pos-api', 1319, true]])
})

test('decorates known references with a state dot and a link, and leaves the rest as written', () => {
  const known = entry(item())
  const md = 'Merge #1319 after #5, see https://github.com/acme/pos-api/pull/1319.'
  const out = decorate(md, (r) => (r.number === 1319 ? known : undefined))
  assert.equal(plain(out), 'Merge ● [#1319](https://github.com/acme/pos-api/pull/1319) after #5, see ● [acme/pos-api#1319](https://github.com/acme/pos-api/pull/1319).')
  assert.match(out, /\x1b\[32m●\x1b\[39m/)
})

test('queries every number of a repo in one request, with the review requests', () => {
  const q = query('acme/pos-api', [1, 2])
  assert.match(q, /repository\(owner: "acme", name: "pos-api"\)/)
  assert.match(q, /n1: issueOrPullRequest\(number: 1\)/)
  assert.match(q, /n2: issueOrPullRequest\(number: 2\)/)
  assert.match(q, /reviewRequests/)
})

test('reads a PR: draft state, check counts, failing runs and requested reviewers', () => {
  const raw: Raw = {
    __typename: 'PullRequest', number: 7, title: 't', url: 'u', state: 'OPEN', isDraft: true, author: { login: 'me' },
    statusCheckRollup: { contexts: { totalCount: 3, checkRunCountsByState: [{ state: 'SUCCESS', count: 1 }, { state: 'FAILURE', count: 1 }],
      nodes: [{ __typename: 'CheckRun', name: 'build', conclusion: 'FAILURE', detailsUrl: 'https://github.com/a/b/actions/runs/99/job/1' }] } },
    reviewRequests: { nodes: [{ requestedReviewer: { login: 'you' } }, { requestedReviewer: {} }] },
  }
  const i = toItem('a/b', raw)
  assert.equal(i.state, 'DRAFT')
  assert.deepEqual(i.checks, { ok: 1, failed: 1, pending: 1, total: 3 })
  assert.deepEqual(i.failing, [{ name: 'build', url: 'https://github.com/a/b/actions/runs/99/job/1' }])
  assert.deepEqual(i.requested, ['you'])
  assert.equal(toItem('a/b', { __typename: 'Issue', number: 1, title: 't', url: 'u', state: 'CLOSED', stateReason: 'NOT_PLANNED' }).state, 'NOT_PLANNED')
})

test('groups: needs you, waiting, done', () => {
  assert.equal(groupOf(item({ requested: ['me'] }), 'me'), 0)
  assert.equal(groupOf(item({ author: 'me' }), 'me'), 0) // its checks fail
  assert.equal(groupOf(item({ author: 'me', checks: { ok: 1, failed: 0, pending: 0, total: 1 } }), 'me'), 1)
  assert.equal(groupOf(item(), 'me'), 1)
  assert.equal(groupOf(item({ state: 'MERGED' }), 'me'), 2)
  assert.equal(groupOf(undefined, 'me'), 1)
})

test('a chip fills its width: marker, dot, number, title, author, age and the red x', () => {
  const width = chipWidth(118, 3)
  assert.equal(width, 33)
  const c = plain(chip({ repo: 'acme/pos-api', number: 1319 }, entry(item()), width, true, style))
  assert.equal(c.length, width)
  assert.match(c, /^▎⬤ #1319 Fix the ti… lgreen 2d x +$/)
  assert.match(chip({ repo: 'a/b', number: 1 }, entry(item()), width, false, style), /\x1b\[31m x\x1b\[39m/)
  assert.equal(plain(chip({ repo: 'a/b', number: 4 }, { at: 0, loading: false, error: 'boom' }, width, false, style)).trim(), 'x #4')
})

const tracked: Tracked[] = [{ repo: 'acme/pos-api', number: 1319 }, { repo: 'acme/pos-api', number: 1400 }, { repo: 'acme/pos-api', number: 1500 }]
const items: Record<number, Item> = {
  1319: item(),
  1400: item({ number: 1400, requested: ['me'] }),
  1500: item({ number: 1500, state: 'MERGED' }),
}
const band = (over: Partial<Band> = {}): Band => ({
  tracked, lookup: (t) => entry(items[t.number]!), viewer: 'me', selected: null, armed: null, folded: false, perRow: 3, focused: false, ...over,
})

test('the band: a blank row, the full-width bar, then the groups indented under it', () => {
  const { lines, hits } = bandLines(band(), 120, style)
  assert.equal(lines[0], '')
  assert.equal(lines[1], `  [ ▾ Tracked PRs${' '.repeat(118 - 14)}]`)
  assert.deepEqual(lines.slice(2).map((l) => plain(l).slice(0, 16)), ['      needs you ', '      waiting   ', '      done      '])
  assert.deepEqual(hits.map((h) => h.target), ['bar', keyFor('acme/pos-api', 1400), keyFor('acme/pos-api', 1319), keyFor('acme/pos-api', 1500)])
  assert.deepEqual(hits[1], { row: 2, from: 16, to: 49, target: keyFor('acme/pos-api', 1400) })
})

test('folded, the band is the bar with the count; focused, it lists the keys for the selected PR', () => {
  assert.deepEqual(bandLines(band({ folded: true }), 120, style).lines.map(plain).map((l) => l.replace(/ *]$/, "")), ['', '  [ ▸ Tracked PRs · 3'])
  const keys = keysFor(band({ selected: keyFor('acme/pos-api', 1319), focused: true }))
  assert.deepEqual(keys, ['a approve', 'r request changes', 'o open', 'c copy link', 'x remove', 'esc back'])
  assert.deepEqual(keysFor(band({ selected: keyFor('acme/pos-api', 1319), armed: keyFor('acme/pos-api', 1319) }))[0], 'a press again to approve')
  assert.equal(plain(bandLines(band({ focused: true, selected: keyFor('acme/pos-api', 1500) }), 120, style).lines.at(-1)!).trim(), 'o open   c copy link   x remove   esc back')
})

test('arrows step through the chips in the order the band draws them', () => {
  const b = band()
  assert.equal(step(b, 1), keyFor('acme/pos-api', 1400))
  assert.equal(step({ ...b, selected: keyFor('acme/pos-api', 1400) }, 1), keyFor('acme/pos-api', 1319))
  assert.equal(step({ ...b, selected: keyFor('acme/pos-api', 1500) }, 1), keyFor('acme/pos-api', 1500))
  assert.equal(step({ ...b, tracked: [] }, 1), null)
})

test('one list per repo, per folder outside git, or per session with sharing off; idle lists go', () => {
  assert.equal(listName(true, 's1', 'acme/pos-api', 'C:/x'), 'repo.acme/pos-api')
  assert.equal(listName(true, 's1', null, 'C:/x'), 'dir.C:/x')
  assert.equal(listName(false, 's1', 'acme/pos-api', 'C:/x'), 'session.s1')
  const now = Date.now()
  const lists = { a: { at: now, items: [] }, b: { at: now - TRACKED_TTL_MS - 1, items: [] }, c: { at: 0, items: [] } }
  assert.deepEqual(Object.keys(pruned(lists, 'c', now)), ['a', 'c'])
})

test('a change applies to the list as stored, so another session\'s removal stays removed', () => {
  // This session still holds 1319, which another session removed: tracking 1500 keeps it removed.
  const stored = [{ repo: 'acme/pos-api', number: 1400 }]
  assert.deepEqual(withTracked(stored, { repo: 'acme/pos-api', number: 1500 }).map((t) => t.number), [1400, 1500])
  assert.deepEqual(withTracked(stored, { repo: 'ACME/pos-api', number: 1400 }), stored)
  assert.deepEqual(withoutTracked(tracked, keyFor('acme/pos-api', 1400)).map((t) => t.number), [1319, 1500])
  assert.equal(sameList(tracked, [...tracked]), true)
})

test('CF_HTML offsets count UTF-8 bytes', () => {
  const html = cfHtml('<a href="u">ä</a>')
  const at = (name: string) => Number(new RegExp(`${name}:(\\d+)`).exec(html)![1])
  const bytes = Buffer.from(html, 'utf8')
  assert.equal(bytes.subarray(at('StartFragment'), at('EndFragment')).toString('utf8'), '<a href="u">ä</a>')
  assert.equal(at('EndHTML'), bytes.length)
})
