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
  expect(links).toContain('https://github.com/mrossi') // a reviewer
  expect(links).toContain(PR.url)
  expect(links).toContain('https://github.com/acme/pos-api') // the repo in the header
  expect(links).toContain(`${PR.url}/files`)
  expect(links).toContain(`${PR.url}/checks`)
  expect(links).toContain('https://github.com/acme/pos-api/actions/runs/7/job/9') // the failing check's run
  expect(await ui.find({ type: 'Text', text: 'ctrl+click opens a link' })).toBeDefined()
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

test('leaves a message without references to Claude Code', async ($, on) => {
  on('process.run', () => {
    throw new Error('gh must not run')
  })
  const ui = await $.ui.mount(message('## Heading\nNo references, only a [link](https://x.y/#3).\n\n| Count |\n|---|\n| 12 |'))
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
})
