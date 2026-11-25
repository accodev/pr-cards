// The hover card, as lines of text with SGR colors and OSC 8 links. It needs no Pi host.
import { DOT, SGR, day, findRefs, toneOf, type Item, type Tone } from './prs.ts'

export const CARD_WIDTH = 66
const INNER = CARD_WIDTH - 4 // two border cells and one blank cell on each side
// A fixed dark gray (#303030), as the Claude Code card: palette black is the terminal background in
// most dark schemes, so a card filled with it shows no edge.
const BG = '\x1b[48;5;236m'
const PILL: Record<string, number> = { OPEN: 42, DRAFT: 100, MERGED: 45, CLOSED: 41, COMPLETED: 45, NOT_PLANNED: 100 }
const STATE_WORD: Record<string, string> = { OPEN: 'Open', DRAFT: 'Draft', MERGED: 'Merged', CLOSED: 'Closed', COMPLETED: 'Closed', NOT_PLANNED: 'Not planned' }
const REVIEW_WORD: Record<string, string> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'review required' }

// A run of the card: its color, and the page a click on it opens.
type Seg = { text: string; tone?: Tone; bold?: boolean; pill?: number; href?: string }
const seg = (text: string, tone?: Tone, extra: Omit<Seg, 'text' | 'tone'> = {}): Seg => ({ text, tone, ...extra })
const linked = (text: string, href: string | undefined, tone?: Tone): Seg => (href ? { text, tone, href } : { text, tone })

const ESC = '\x1b'
const OSC8 = (href: string, text: string) => `${ESC}]8;;${href}${ESC}\\${text}${ESC}]8;;${ESC}\\`

function drawSeg(s: Seg): string {
  let out = s.text
  if (s.tone) out = `${ESC}[${SGR[s.tone]}m${out}${ESC}[39m`
  if (s.bold) out = `${ESC}[1m${out}${ESC}[22m`
  if (s.pill) out = `${ESC}[${s.pill}m${out}${BG}`
  // Pi opens an OSC 8 link on a click.
  return s.href ? OSC8(s.href, out) : out
}

// The runs of one card row, wrapped at word ends to the card's inner width, each row on the fill.
function fill(segs: Seg[]): string[] {
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
  return rows.map((row) => {
    const width = row.reduce((n, s) => n + s.text.length, 0)
    return BG + '  ' + row.map(drawSeg).join('') + ' '.repeat(Math.max(0, INNER - width) + 2) + `${ESC}[0m`
  })
}

const edge = () => BG + ' '.repeat(CARD_WIDTH) + `${ESC}[0m`
const popup = (rows: Seg[][]) => [edge(), ...rows.flatMap(fill), edge()]
const short = (url: string) => url.replace(/^https:\/\//, '')

function parts(item: Item, viewer: string) {
  const person = (login: string, tone?: Tone): Seg => (login === viewer ? { text: 'you', tone } : { text: '@' + login, tone: tone ?? 'link', href: 'https://github.com/' + login })
  const people = (logins: string[], tone?: Tone): Seg[] => logins.flatMap((l, i) => [...(i ? [seg(', ', tone)] : []), person(l, tone)])
  // The title with its references as links; GitHub sends an issue URL of a PR to the PR.
  const title: Seg[] = []
  let at = 0
  for (const f of findRefs(item.title)) {
    if (f.start > at) title.push(seg(item.title.slice(at, f.start), undefined, { bold: true }))
    title.push(seg(item.title.slice(f.start, f.end), 'link', { bold: true, href: `https://github.com/${f.repo ?? item.repo}/issues/${f.number}` }))
    at = f.end
  }
  if (at < item.title.length) title.push(seg(item.title.slice(at), undefined, { bold: true }))
  return { person, people, title }
}

// The card a hover on a reference opens, as the Claude Code mod's: `card` (state, title, who and
// when, size, checks, reviews, threads) or `github`, laid out as GitHub's own hover card.
export function cardLines(item: Item, style: 'card' | 'github', viewer: string): string[] {
  const { person, people, title } = parts(item, viewer)
  if (style === 'github') {
    const repoUrl = 'https://github.com/' + item.repo
    const rows: Seg[][] = [
      [linked(item.repo, repoUrl, 'link'), seg(' on ' + day(item.created), 'dim')],
      [],
      [seg(DOT + ' ', toneOf(item)), ...title, seg(' '), linked('#' + item.number, item.url, 'dim')],
    ]
    if (item.head && item.base) rows.push([linked(item.head, `${repoUrl}/tree/${item.head}`, 'code'), seg(' → ', 'dim'), linked(item.base, `${repoUrl}/tree/${item.base}`, 'code')])
    const foot: Seg[] = [seg('opened by ', 'dim'), person(item.author), seg(' · ', 'dim')]
    if (item.kind === 'issue') foot.push(linked(`${item.comments} comments`, item.url, 'dim'))
    else if (item.changesBy?.length === 1 && item.changesBy[0] === viewer) foot.push(seg('● you requested changes', 'warn'))
    else if (item.changesBy?.length) foot.push(seg('● changes requested by ', 'warn'), ...people(item.changesBy, 'warn'))
    else if (item.approvedBy?.length === 1 && item.approvedBy[0] === viewer) foot.push(seg('✓ you approved', 'open'))
    else if (item.approvedBy?.length) foot.push(seg('✓ approved by ', 'open'), ...people(item.approvedBy, 'open'))
    else foot.push(seg(REVIEW_WORD[item.review ?? ''] ?? 'no reviews yet', 'dim'))
    const c = item.checks
    if (!c?.total) return popup([...rows, [], foot])
    const checks = linked(`${c.failed ? 'x' : '✓'} ${c.ok} of ${c.total} checks`, item.url + '/checks', c.failed ? 'closed' : 'open')
    // A long login would wrap the checks in the middle: then they take a row of their own.
    const fits = foot.reduce((n, s) => n + s.text.length, 0) + 3 + checks.text.length <= INNER
    return popup([...rows, [], ...(fits ? [[...foot, seg(' · ', 'dim'), checks]] : [foot, [checks]])])
  }
  const facts: Seg[][] = []
  if (item.kind === 'issue') facts.push([person(item.author), seg(` · ${item.when} · `, 'dim'), linked(`${item.comments} comments`, item.url, 'dim')])
  else {
    const c = item.checks!
    facts.push([person(item.author), seg(` · ${item.when} · `, 'dim'), seg('+' + item.additions, 'open'), seg(' '), seg('−' + item.deletions, 'closed'), seg(' · ', 'dim'), linked(`${item.changedFiles} files`, item.url + '/files', 'dim')])
    if (c.total) {
      const failing = item.failing ?? []
      facts.push([
        seg('✓', 'open'), seg(' '), linked(`${c.ok} of ${c.total} checks`, item.url + '/checks'),
        ...(failing.length ? [seg(' · '), seg('x ', 'closed'), linked(failing[0]!.name, failing[0]!.url, 'closed'), ...(failing.length > 1 ? [seg(` +${failing.length - 1}`, 'closed')] : [])] : []),
        ...(c.pending ? [seg(' · '), seg(`● ${c.pending} running`, 'warn')] : []),
      ])
    }
    const reviews: Seg[] = []
    if (item.approvedBy?.length) reviews.push(seg('✓', 'open'), seg(' approved by '), ...people(item.approvedBy))
    if (item.changesBy?.length) reviews.push(...(reviews.length ? [seg(' · ')] : []), seg('● changes requested by ', 'warn'), ...people(item.changesBy, 'warn'))
    facts.push(reviews.length ? reviews : [seg(REVIEW_WORD[item.review ?? ''] ?? 'no reviews yet', 'dim')])
    const threads = item.threads?.length ?? 0
    if (threads) facts.push([linked(`${threads} open review thread${threads === 1 ? '' : 's'}`, item.url)])
  }
  return popup([
    [seg(` ${STATE_WORD[item.state] ?? item.state} `, 'black', { pill: PILL[item.state] ?? 100, bold: true }), seg('  '), linked(item.repo, 'https://github.com/' + item.repo, 'dim'), seg(' '), linked('#' + item.number, item.url, 'dim')],
    title,
    ...facts,
    [seg(short(item.url), 'link', { href: item.url })],
  ])
}

// The card of a lookup that failed: its error, in red.
export const errorCard = (error: string) => popup([[seg(error, 'closed')]])
