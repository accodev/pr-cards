import { expect, mock, test } from 'claude-code/testing'

const PR = {
  __typename: 'PullRequest', number: 1319, title: 'fix: round VAT per line', url: 'https://github.com/acme/pos-api/pull/1319',
  state: 'OPEN', isDraft: false, author: { login: 'lgreen' }, additions: 184, deletions: 37, changedFiles: 9, reviewDecision: 'CHANGES_REQUESTED',
  statusCheckRollup: { contexts: { totalCount: 2, checkRunCountsByState: [{ state: 'SUCCESS', count: 1 }, { state: 'FAILURE', count: 1 }], statusContextCountsByState: [] } },
}
const MERGED = { ...PR, number: 1307, url: 'https://github.com/acme/pos-api/pull/1307', state: 'MERGED', statusCheckRollup: null }
const ISSUE = { __typename: 'Issue', number: 1250, title: 'Till says what is missing', url: 'https://github.com/acme/pos-api/issues/1250', state: 'OPEN', stateReason: null, author: { login: 'kpark' }, comments: { totalCount: 4 } }

const message = (text: string) => ({
  plugin: 'pr-cards',
  component: 'AssistantMessage',
  requestId: 'msg-1',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40 },
  props: { text, isFirstOfReply: true },
}) as const

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

test('links PRs and issues with their state icon, in text and in a numbers column, in one query', async ($, on) => {
  const clock = mock.clock(on)
  const runs: string[][] = []
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    if (e.argv[1] === 'repo') return ok('acme/pos-api\n')
    return ok(JSON.stringify({ data: { repository: { n1319: PR, n1250: ISSUE, n1307: MERGED } } }))
  })

  const text = 'Only #1319 is blocked (#1250).\n\n| # | State |\n|---|---|\n| 1307 | merged |\n\nSee `#42`.'
  const ui = await $.ui.mount(message(text))
  await clock.settle()
  await clock.settle()

  expect(runs.map((r) => r.slice(0, 3))).toEqual([['gh', 'repo', 'view'], ['gh', 'api', 'graphql']])
  const md = await ui.find({ key: 'pr-msg-1' })
  expect(md?.props.text).toBe(
    'Only [ #1319](https://github.com/acme/pos-api/pull/1319) is blocked ([ #1250](https://github.com/acme/pos-api/issues/1250)).\n\n' +
      '| # | State |\n|---|---|\n| [ 1307](https://github.com/acme/pos-api/pull/1307) | merged |\n\nSee `#42`.',
  )
  expect(await ui.find({ type: 'Text', text: '  #1319 ✖ ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  #1250  ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'checks 1/2 · 1 failing' })).toBeDefined()

  expect(await ui.find({ type: 'Text', text: /^@lgreen/ })).toBeDefined() // the hover card, drawn hidden
  const before = (await ui.findAll({ type: 'Text', text: /^@lgreen/ })).length
  await ui.press({ key: 'pr-msg-1', link: { href: PR.url } })
  await clock.settle()
  expect((await ui.findAll({ type: 'Text', text: /^@lgreen/ })).length).toBe(before + 1) // plus the panel
})

test('leaves a message without references to Claude Code', async ($, on) => {
  on('process.run', () => {
    throw new Error('gh must not run')
  })
  const ui = await $.ui.mount(message('## Heading\nNo references, only a [link](https://x.y/#3).\n\n| Count |\n|---|\n| 12 |'))
  expect(await ui.find({ key: 'pr-msg-1' })).toBeUndefined()
})
