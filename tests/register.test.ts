import { expect, mock, test } from 'claude-code/testing'

const PR = {
  number: 1319, title: 'fix: round VAT per line', url: 'https://github.com/acme/pos-api/pull/1319',
  state: 'OPEN', isDraft: false, author: { login: 'lgreen' }, additions: 184, deletions: 37, changedFiles: 9,
  reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }],
}

const message = (text: string) => ({
  plugin: 'pr-cards',
  component: 'AssistantMessage',
  requestId: 'msg-1',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40 },
  props: { text, isFirstOfReply: true },
}) as const

test('turns #1319 into a link, a chip with a hover card, and a panel on click', async ($, on) => {
  const clock = mock.clock(on)
  const runs: string[][] = []
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: JSON.stringify(PR), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  const ui = await $.ui.mount(message('Only #1319 is blocked. See `#42` in code.'))
  await clock.settle()

  expect(runs).toEqual([['gh', 'pr', 'view', '1319', '--json', expect.any(String)]])
  const md = await ui.find({ key: 'pr-msg-1' })
  expect(md?.props.text).toBe('Only [#1319 ✖ fix: round VAT per line](https://github.com/acme/pos-api/pull/1319) is blocked. See `#42` in code.')
  expect(await ui.find({ type: 'Text', text: ' #1319 ✖ ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'checks 1/2 · 1 failing' })).toBeDefined()

  expect(await ui.find({ type: 'Text', text: /^author @lgreen/ })).toBeUndefined()
  await ui.press({ key: 'pr-msg-1', link: { href: PR.url } })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^author @lgreen/ })).toBeDefined()
})

test('leaves a message without PR references to Claude Code', async ($, on) => {
  on('process.run', () => {
    throw new Error('gh must not run')
  })
  const ui = await $.ui.mount(message('## Heading\nNo references, only a [link](https://x.y/#3).'))
  expect(await ui.find({ key: 'pr-msg-1' })).toBeUndefined()
})
