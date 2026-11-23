import { expect, mock, test } from 'claude-code/testing'

const PR = {
  __typename: 'PullRequest', number: 1319, title: 'fix: round VAT per line', url: 'https://github.com/acme/pos-api/pull/1319',
  state: 'OPEN', isDraft: false, author: { login: 'lgreen' }, additions: 184, deletions: 37, changedFiles: 9, reviewDecision: 'CHANGES_REQUESTED',
  createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), mergedAt: null, closedAt: null,
  statusCheckRollup: { contexts: { totalCount: 2, checkRunCountsByState: [{ state: 'SUCCESS', count: 1 }, { state: 'FAILURE', count: 1 }], statusContextCountsByState: [], nodes: [{ __typename: 'CheckRun', name: 'build', conclusion: 'SUCCESS' }, { __typename: 'CheckRun', name: 'e2e / it-receipts', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/pos-api/actions/runs/7/job/9' }] } },
  latestReviews: { nodes: [{ state: 'APPROVED', author: { login: 'mrossi' } }, { state: 'CHANGES_REQUESTED', author: { login: 'me' } }] },
  reviewThreads: { nodes: [{ isResolved: false, path: 'src/Vat.cs', line: 88 }, { isResolved: true, path: 'src/A.cs', line: 1 }] },
  files: { nodes: [{ path: 'src/Vat.cs', additions: 92, deletions: 21 }] },
}
const MERGED = { ...PR, number: 1307, title: 'feat: export (#1250, other/lib#3)', url: 'https://github.com/acme/pos-api/pull/1307', state: 'MERGED', mergedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), statusCheckRollup: null }
const ISSUE = { __typename: 'Issue', number: 1250, title: 'Till says what is missing', url: 'https://github.com/acme/pos-api/issues/1250', state: 'OPEN', stateReason: null, author: { login: 'kpark' }, comments: { totalCount: 4 }, createdAt: PR.createdAt, closedAt: null }

const message = (text: string) => ({
  plugin: 'pr-cards',
  component: 'AssistantMessage',
  requestId: 'msg-1',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40 },
  props: { text, isFirstOfReply: true },
}) as const

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

test('draws references in text and in a numbers column with a dot, a link and the mockup card', async ($, on) => {
  const clock = mock.clock(on)
  const runs: string[][] = []
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    if (e.argv[1] === 'repo') return ok('acme/pos-api\n')
    return ok(JSON.stringify({ data: { viewer: { login: 'me' }, repository: { n1319: PR, n1250: ISSUE, n1307: MERGED } } }))
  })

  const text = 'Only #1319 is **blocked** (#1250).\n\n| # | State | Title |\n|---|---|---|\n| 1307 | merged | feat: export (#1250) |\n\n```\n#42 stays\n```'
  const ui = await $.ui.mount(message(text))
  await clock.settle()
  await clock.settle()

  expect(runs.map((r) => r.slice(0, 3))).toEqual([['gh', 'repo', 'view'], ['gh', 'api', 'graphql']])
  expect(await ui.find({ type: 'Markdown', text: '[#1319](https://github.com/acme/pos-api/pull/1319)' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: '[1307](https://github.com/acme/pos-api/pull/1307)' })).toBeDefined()
  expect(await ui.findAll({ type: 'Markdown', text: '[#1250](https://github.com/acme/pos-api/issues/1250)' })).toHaveLength(2)
  expect(await ui.find({ type: 'Markdown', text: '```\n#42 stays\n```' })).toBeDefined()

  // The card, drawn hidden until hovered.
  expect(await ui.find({ type: 'Text', text: ' Open ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'fix: round VAT per line' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'e2e / it-receipts' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '● changes requested by you' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1 open review thread' })).toBeDefined()
  const links = (await ui.findAll({ type: 'Link' })).map((l) => l.props.href)
  expect(links).toContain('https://github.com/lgreen') // the author
  // No solid underline on a card link: the terminal draws its own dotted one under a hyperlink.
  expect((await ui.find({ type: 'Text', text: '@lgreen' }))?.props.underline).toBeFalsy()
  expect(links).toContain('https://github.com/mrossi') // a reviewer
  expect(links).toContain(PR.url)
  expect(links).toContain('https://github.com/acme/pos-api') // the repo in the header
  expect(links).toContain(`${PR.url}/files`)
  expect(links).toContain(`${PR.url}/checks`)
  expect(links).toContain('https://github.com/acme/pos-api/actions/runs/7/job/9') // the failing check's run
  // References inside a title are links too: same repo, then another repo.
  expect(links).toContain('https://github.com/acme/pos-api/issues/1250')
  expect(links).toContain('https://github.com/other/lib/issues/3')

  expect(await ui.find({ type: 'Text', text: 'OPEN THREADS 1' })).toBeUndefined()
  const link = await ui.find({ type: 'Markdown', text: '[#1319](https://github.com/acme/pos-api/pull/1319)' })
  await ui.press({ key: String(link?.props.key), link: { href: PR.url } })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: 'OPEN THREADS 1' })).toBeDefined()
})

test('wraps a card row whose word fills the row exactly', async ($, on) => {
  const clock = mock.clock(on)
  // 62 letters fill a card row; the space after them once looped forever and crashed the hooks worker.
  const title = `${'a'.repeat(62)} b ${'c'.repeat(70)}`
  on('process.run', ($, e) => (e.argv[1] === 'repo' ? ok('acme/pos-api\n') : ok(JSON.stringify({ data: { viewer: { login: 'me' }, repository: { n1319: { ...PR, title } } } }))))
  const ui = await $.ui.mount(message('See #1319.'))
  await clock.settle()
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: 'a'.repeat(62) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'b' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'c'.repeat(62) })).toBeDefined()
})

test('keeps bold, italic and code around a reference inside them', async ($, on) => {
  const clock = mock.clock(on)
  on('process.run', ($, e) => (e.argv[1] === 'repo' ? ok('acme/pos-api\n') : ok(JSON.stringify({ data: { viewer: { login: 'me' }, repository: { n1319: PR } } }))))
  const text = '- **`AGENTS.md`**: the section\n- **PR #1319, now 3 files:** market_it_work, `validate/stage.md` and *also #1319 here*'
  const ui = await $.ui.mount(message(text))
  await clock.settle()
  await clock.settle()

  const texts = await ui.findAll({ type: 'Text' })
  // No marker is left as text: the reported bug drew `**PR`.
  expect(texts.filter((t) => /\*\*|(^|\s)\*\w/.test(String(t.text)))).toEqual([])
  const style = (word: string) => texts.find((t) => t.text === word)?.props
  expect(style('PR ')).toMatchObject({ bold: true })
  expect(style('files:')).toMatchObject({ bold: true })
  expect(style('market_it_work, ')?.bold).toBeFalsy() // snake_case is no italic marker
  expect(style('AGENTS.md')).toMatchObject({ bold: true, color: 'ansi256(6)' }) // code inside bold
  expect(style('validate/stage.md')).toMatchObject({ color: 'ansi256(6)' })
  expect(style('also ')).toMatchObject({ italic: true })
  expect(await ui.findAll({ type: 'Markdown', text: '[#1319](https://github.com/acme/pos-api/pull/1319)' })).toHaveLength(2)
})

test('draws a table with references inside Claude Code borders, wrapping long cells', async ($, on) => {
  const clock = mock.clock(on)
  on('process.run', ($, e) => (e.argv[1] === 'repo' ? ok('acme/pos-api\n') : ok(JSON.stringify({ data: { viewer: { login: 'me' }, repository: { n1319: PR, n1250: ISSUE } } }))))
  const long = 'a title long enough to wrap over several lines in a narrow terminal for sure (#1250)'
  const ui = await $.ui.mount({ ...message(`| # | Title |\n|---|---|\n| 1319 | ${long} |`), viewport: { columns: 40, rows: 40 } })
  await clock.settle()
  await clock.settle()
  const texts = (await ui.findAll({ type: 'Text' })).map((t) => String(t.text))
  expect(texts.filter((t) => t.startsWith('┌'))).toHaveLength(1)
  expect(texts.filter((t) => t.startsWith('├'))).toHaveLength(1)
  expect(texts.filter((t) => t.startsWith('└'))).toHaveLength(1)
  expect(texts.find((t) => t.startsWith('┌'))!.length).toBeLessThanOrEqual(38) // 40 columns less the reply's indent
  // The title wraps: one left bar per drawn line, the header line and at least three title lines.
  expect(texts.filter((t) => t === '│ ').length).toBeGreaterThanOrEqual(4)
  expect(await ui.find({ type: 'Markdown', text: '[#1250](https://github.com/acme/pos-api/issues/1250)' })).toBeDefined()
  expect(texts.some((t) => t.includes('ctrl+click'))).toBe(false) // the card has no hint row
})

test('treats a markdown link to a PR or issue as a reference, in text and in a table', async ($, on) => {
  const clock = mock.clock(on)
  on('process.run', ($, e) => (e.argv[1] === 'repo' ? ok('acme/pos-api\n') : ok(JSON.stringify({ data: { viewer: { login: 'me' }, repository: { n1319: PR, n1250: ISSUE } } }))))
  const text = 'See [PR 1319](https://github.com/acme/pos-api/pull/1319).\n\n| Issue | PR | Notes |\n|---|---|---|\n| #1250 a till | [#1319](https://github.com/acme/pos-api/pull/1319) | [docs](https://example.com/x) |'
  const ui = await $.ui.mount(message(text))
  await clock.settle()
  await clock.settle()
  // Each PR link is drawn as a reference: the state dot, then its own label as the link.
  const textLink = await ui.find({ type: 'Markdown', text: '[PR 1319](https://github.com/acme/pos-api/pull/1319)' })
  expect(String(textLink?.props.key)).toMatch(/-link-/) // a reference's link, with its click handler
  expect(await ui.findAll({ type: 'Markdown', text: '[#1319](https://github.com/acme/pos-api/pull/1319)' })).toHaveLength(1)
  const dots = (await ui.findAll({ type: 'Text', text: '⬤ ' })).length
  expect(dots).toBe(3) // PR 1319 in the text, #1250 and #1319 in the table
  // Any other link stays a plain link.
  expect(await ui.find({ type: 'Markdown', text: '[docs](https://example.com/x)' })).toBeDefined()
})

test('leaves row numbers and numbers GitHub does not know as plain text', async ($, on) => {
  const clock = mock.clock(on)
  // GitHub answers null for #999: no such PR or issue.
  on('process.run', ($, e) => (e.argv[1] === 'repo' ? ok('acme/pos-api\n') : ok(JSON.stringify({ data: { viewer: { login: 'me' }, repository: { n1319: PR, n999: null } } }))))
  const rows = '| # | Card |\n|---|---|\n| 7 | One row |\n| 8 | Two rows |\n| 9 | GitHub card |'
  const ui = await $.ui.mount(message(`${rows}\n\nSee #1319 and #999.`))
  await clock.settle()
  await clock.settle()
  // The numbered column counts 7, 8, 9: row numbers, so the table stays Claude Code's own.
  expect(await ui.find({ type: 'Markdown', text: rows })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: '[#1319](https://github.com/acme/pos-api/pull/1319)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '#999' })).toBeDefined()
  const texts = (await ui.findAll({ type: 'Text' })).map((t) => String(t.text))
  expect(texts.filter((t) => t.startsWith('⬤'))).toHaveLength(1) // only #1319
  // One cross only: #1319's card lists its failing check; #999 gets no failed-lookup cross.
  expect(texts.filter((t) => t.startsWith('✖'))).toHaveLength(1)
})

test('draws the GitHub-style card when cardStyle is github', { options: { cardStyle: 'github' } }, async ($, on) => {
  const clock = mock.clock(on)
  const pr = { ...PR, headRefName: 'fix/vat', baseRefName: 'main' }
  on('process.run', ($, e) => (e.argv[1] === 'repo' ? ok('acme/pos-api\n') : ok(JSON.stringify({ data: { viewer: { login: 'me' }, repository: { n1319: pr } } }))))
  const ui = await $.ui.mount(message('See #1319.'))
  await clock.settle()
  await clock.settle()
  const texts = (await ui.findAll({ type: 'Text' })).map((t) => String(t.text))
  // The repo and the day it was opened, the title and number, the branches, then the review and checks.
  expect(texts).toContain('acme/pos-api')
  expect(texts.some((t) => /^ on [A-Z][a-z]{2} \d{1,2}$/.test(t))).toBe(true)
  expect(texts).toContain('fix: round VAT per line')
  expect(texts).toContain('#1319')
  expect(texts).toContain('fix/vat')
  expect(texts).toContain('main')
  expect(texts).toContain('opened by ') // the footer opens with the author, as design 9c
  expect(texts).toContain('@lgreen')
  expect(texts).toContain('● you requested changes')
  expect(texts).toContain('✖ 1 of 2 checks')
  // None of the full card's badge, size or thread rows.
  expect(texts.some((t) => t === ' Open ' || t.includes('open review thread') || t.includes('files'))).toBe(false)
  const links = (await ui.findAll({ type: 'Link' })).map((l) => l.props.href)
  expect(links).toEqual(expect.arrayContaining(['https://github.com/acme/pos-api', PR.url, 'https://github.com/acme/pos-api/tree/fix/vat', `${PR.url}/checks`, 'https://github.com/lgreen']))
})

test('moves the checks to their own row when a long login fills the GitHub-style footer', { options: { cardStyle: 'github' } }, async ($, on) => {
  const clock = mock.clock(on)
  const pr = { ...PR, author: { login: 'danielscainifiskaltrust-long' }, latestReviews: { nodes: [{ state: 'APPROVED', author: { login: 'me' } }] } }
  on('process.run', ($, e) => (e.argv[1] === 'repo' ? ok('acme/pos-api\n') : ok(JSON.stringify({ data: { viewer: { login: 'me' }, repository: { n1319: pr } } }))))
  const ui = await $.ui.mount(message('See #1319.'))
  await clock.settle()
  await clock.settle()
  const texts = (await ui.findAll({ type: 'Text' })).map((t) => String(t.text))
  expect(texts).toContain('✔ you approved')
  expect(texts).toContain('✖ 1 of 2 checks') // whole, on its own row
})

test('leaves a message without references to Claude Code', async ($, on) => {
  on('process.run', () => {
    throw new Error('gh must not run')
  })
  const ui = await $.ui.mount(message('## Heading\nNo references, only a [link](https://x.y/#3).\n\n| Count |\n|---|\n| 12 |'))
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
})
