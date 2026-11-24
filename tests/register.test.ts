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

  // A plain click on a reference tracks it (the band test covers that); the transcript opens nothing.
  const link = await ui.find({ type: 'Markdown', text: '[#1319](https://github.com/acme/pos-api/pull/1319)' })
  expect(link?.props.pressableLinks).toEqual([PR.url])
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
  expect(texts.filter((t) => t.startsWith('x'))).toHaveLength(1)
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
  expect(texts).toContain('x 1 of 2 checks')
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
  expect(texts).toContain('✓ you approved')
  expect(texts).toContain('x 1 of 2 checks') // whole, on its own row
})

test('a click tracks a PR in the band above the prompt, with actions for the selected chip', async ($, on) => {
  const clock = mock.clock(on)
  const runs: string[][] = []
  const stdins: string[] = []
  // The first powershell.exe call fails, as on a machine without Windows PowerShell.
  let powershellWorks = true
  const copies: string[] = []
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    if (e.argv[0] === 'powershell.exe') {
      stdins.push(String(e.init?.stdin ?? ''))
      return powershellWorks ? ok('') : { value: { exitCode: 1, stdout: '', stderr: 'not found', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[1] === 'repo') return ok('acme/pos-api\n')
    if (e.argv[1] === 'api') return ok(JSON.stringify({ data: { viewer: { login: 'me' }, repository: { n1319: PR } } }))
    return ok('')
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', ($, e) => (copies.push(e.text), { value: { isCopied: true } }) as never)
  const reply = await $.ui.mount(message('See #1319.'))
  await clock.settle()
  await clock.settle()
  const link = await reply.find({ type: 'Markdown', text: '[#1319](https://github.com/acme/pos-api/pull/1319)' })
  await reply.press({ key: String(link?.props.key), link: { href: PR.url } })

  const bandInput = {
    plugin: 'pr-cards', component: 'AbovePrompt', requestId: 'AbovePrompt', surface: 'terminal',
    viewport: { columns: 120, rows: 40 },
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 115 },
  } as const
  const band = await $.ui.mount(bandInput as never)
  await clock.settle()
  // The click tracked #1319 and selected it: its chip and the hotkey row show.
  expect(await band.find({ key: 'pr-cards-select-acme/pos-api#1319' })).toBeDefined()
  // Design G1: a ▎ in the theme's suggestion color marks the selected chip; the chip shows the
  // author and age dim and the checks' mark; it sits in the waiting group (not yours, no review
  // asked of you); the hint row says only "tracked". No fill or underline anywhere.
  const texts = await band.findAll({ type: 'Text' })
  const said = texts.map((t) => String(t.text))
  expect(texts.find((t) => String(t.text) === '▎')?.props.color).toBe('suggestion')
  expect(said).toContain('#1319 ')
  expect(said).toContain(' lgreen 2d')
  expect(said).toContain(' x')
  expect(said).toContain('waiting   ')
  const title = texts.find((t) => String(t.text).startsWith(' Tracked PRs'))!
  expect([title.props.color, title.props.backgroundColor, title.props.bold, String(title.text).length]).toEqual(['inverseText', 'claude', true, 113])
  expect(texts.some((t) => (t !== title && t.props.backgroundColor) || t.props.underline)).toBe(false)
  // 115 body columns: three chips of 33 cells beside the 10-cell label.
  const at = said.indexOf('▎') // then the dot, number, title, author and age, checks, and the space to the chip's end
  expect(said.slice(at, at + 7).join('')).toHaveLength(33)
  const hotkeys = (await band.findAll({ type: 'Button' })).flatMap((b) => (b.props.hotkey ? [`${b.props.hotkey}: ${b.props.label}`] : []))
  expect(hotkeys).toEqual(['a: approve', 'r: request changes', 'f: re-run failed', 'o: open', 'c: copy link', 'x: remove'])

  // c: the link as rich text (the clipboard's HTML format) and as plain text, through Windows PowerShell.
  await band.press({ key: 'pr-cards-c' })
  await clock.settle()
  const sent = JSON.parse(stdins[0]!) as { html: string; text: string }
  expect(sent.text).toBe(`acme/pos-api#1319 fix: round VAT per line ${PR.url}`)
  const fragment = `<a href="${PR.url}">acme/pos-api#1319</a> fix: round VAT per line`
  expect(sent.html).toContain(`<!--StartFragment-->${fragment}<!--EndFragment-->`)
  // The header's offsets point at the fragment (all ASCII here, so bytes are characters).
  const start = Number(/StartFragment:(\d+)/.exec(sent.html)![1])
  const end = Number(/EndFragment:(\d+)/.exec(sent.html)![1])
  expect(sent.html.slice(start, end)).toBe(fragment)
  expect(copies).toEqual([])
  // Without Windows PowerShell it falls back to Claude Code's own copy, plain text.
  powershellWorks = false
  await band.press({ key: 'pr-cards-c' })
  await clock.settle()
  expect(copies).toEqual([`acme/pos-api#1319 fix: round VAT per line ${PR.url}`])

  // f: the failing check's run (…/actions/runs/7) is re-run, failed jobs only.
  await band.press({ key: 'pr-cards-f' })
  await clock.settle()
  expect(runs).toContainEqual(['gh', 'run', 'rerun', '7', '--failed', '--repo', 'acme/pos-api'])

  // a: approving takes two presses; only the second runs gh.
  await band.press({ key: 'pr-cards-a' })
  expect(runs.some((r) => r[1] === 'pr' && r[2] === 'review')).toBe(false)
  expect((await band.find({ key: 'pr-cards-a' }))?.props.label).toBe('press a again to approve')
  await band.press({ key: 'pr-cards-a' })
  await clock.settle()
  expect(runs).toContainEqual(['gh', 'pr', 'review', '1319', '--repo', 'acme/pos-api', '--approve'])

  // o opens it in the browser through gh.
  await band.press({ key: 'pr-cards-o' })
  await clock.settle()
  expect(runs).toContainEqual(['gh', 'pr', 'view', '1319', '--repo', 'acme/pos-api', '--web'])

  // x removes it, and the band goes away with the last chip.
  await band.press({ key: 'pr-cards-x' })
  await clock.settle()
  expect(await band.find({ key: 'pr-cards-select-acme/pos-api#1319' })).toBeUndefined()
})

test('keeps tracked PRs per session when shareTracked is off', { options: { shareTracked: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const day = 86_400_000
  // The store as a plain object, so the test can read back what the mod wrote.
  const store: Record<string, unknown> = {
    tracked: [{ repo: 'acme/pos-api', number: 1 }], // the one list 0.4 and 0.5 shared
    'tracked.other': { at: Date.now() - day, items: [{ repo: 'acme/pos-api', number: 1250 }] },
    'tracked.old': { at: Date.now() - 30 * day, items: [{ repo: 'acme/pos-api', number: 2 }] },
  }
  on('store.get', ($, e) => ({ value: store[e.key] }) as never)
  on('store.set', ($, e) => ((store[e.key] = e.value), { value: undefined }) as never)
  on('store.delete', ($, e) => (delete store[e.key], { value: undefined }) as never)
  on('store.keys', () => ({ value: Object.keys(store) }) as never)
  on('session.id', () => ({ value: 'session-a' }))
  on('process.run', ($, e) => (e.argv[1] === 'repo' ? ok('acme/pos-api\n') : ok(JSON.stringify({ data: { viewer: { login: 'me' }, repository: { n1319: PR, n1250: ISSUE } } }))))
  const bandInput = {
    plugin: 'pr-cards', component: 'AbovePrompt', requestId: 'AbovePrompt', surface: 'terminal',
    viewport: { columns: 120, rows: 40 },
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 115 },
  } as const
  const band = await $.ui.mount(bandInput as never)
  await clock.settle()
  // Nothing of the other session, nor of the old shared list.
  expect(await band.find({ key: 'pr-cards-select-acme/pos-api#1250' })).toBeUndefined()
  expect(await band.find({ key: 'pr-cards-select-acme/pos-api#1' })).toBeUndefined()

  const reply = await $.ui.mount(message('See #1319.'))
  await clock.settle()
  await clock.settle()
  const link = await reply.find({ type: 'Markdown', text: '[#1319](https://github.com/acme/pos-api/pull/1319)' })
  await reply.press({ key: String(link?.props.key), link: { href: PR.url } })
  await clock.settle()
  expect(await band.find({ key: 'pr-cards-select-acme/pos-api#1319' })).toBeDefined()
  expect(await band.find({ key: 'pr-cards-select-acme/pos-api#1250' })).toBeUndefined()

  // Saved under this session; the shared list and the idle session's list are gone, the recent one stays.
  expect((store['tracked.session-a'] as { items: unknown[] }).items).toEqual([{ repo: 'acme/pos-api', number: 1319 }])
  expect(store.tracked).toBeUndefined()
  expect(store['tracked.old']).toBeUndefined()
  expect(store['tracked.other']).toBeDefined()
})

test('shares tracked PRs per repo and groups them: needs you, waiting, done', async ($, on) => {
  const clock = mock.clock(on)
  const MINE = { ...PR, number: 1400, title: 'feat: export the day', url: 'https://github.com/acme/pos-api/pull/1400', author: { login: 'me' }, reviewDecision: null, latestReviews: { nodes: [] } }
  const ASKED = { ...PR, reviewRequests: { nodes: [{ requestedReviewer: { login: 'me' } }] } }
  const store: Record<string, unknown> = {
    // Tracked in another session of this repo: this one shows it.
    'tracked.repo.acme/pos-api': { at: Date.now(), items: [1250, 1307, 1319, 1400].map((number) => ({ repo: 'acme/pos-api', number })) },
    'tracked.repo.acme/other': { at: Date.now(), items: [{ repo: 'acme/other', number: 5 }] },
  }
  on('store.get', ($, e) => ({ value: store[e.key] }) as never)
  on('store.set', ($, e) => ((store[e.key] = e.value), { value: undefined }) as never)
  on('store.delete', ($, e) => (delete store[e.key], { value: undefined }) as never)
  on('store.keys', () => ({ value: Object.keys(store) }) as never)
  on('session.id', () => ({ value: 'session-b' }))
  on('process.run', ($, e) => (e.argv[1] === 'repo' ? ok('acme/pos-api\n') : ok(JSON.stringify({ data: { viewer: { login: 'me' }, repository: { n1319: ASKED, n1250: ISSUE, n1307: MERGED, n1400: MINE } } }))))
  const band = await $.ui.mount({
    plugin: 'pr-cards', component: 'AbovePrompt', requestId: 'AbovePrompt', surface: 'terminal',
    viewport: { columns: 120, rows: 40 },
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 115 },
  } as never)
  await clock.settle()
  await clock.settle()
  expect(await band.find({ key: 'pr-cards-select-acme/other#5' })).toBeUndefined()
  // #1319 asks for your review and #1400 is yours with a failing check: they need you. The open
  // issue waits. #1307 is merged. Each group's first row carries its label.
  const said = (await band.findAll({ type: 'Text' })).map((t) => String(t.text))
  const at = (s: string) => said.indexOf(s)
  expect(at('needs you ')).toBeGreaterThanOrEqual(0)
  expect(at('needs you ')).toBeLessThan(at('#1319 '))
  expect(at('#1319 ')).toBeLessThan(at('#1400 '))
  expect(at('#1400 ')).toBeLessThan(at('waiting   '))
  expect(at('waiting   ')).toBeLessThan(at('#1250 '))
  expect(at('#1250 ')).toBeLessThan(at('done      '))
  expect(at('done      ')).toBeLessThan(at('#1307 '))

  // x removes the selected chip from the repo's list, which every session of the repo reads.
  await band.press({ key: 'pr-cards-select-acme/pos-api#1250' })
  await band.press({ key: 'pr-cards-x' })
  await clock.settle()
  expect((store['tracked.repo.acme/pos-api'] as { items: { number: number }[] }).items.map((t) => t.number)).toEqual([1307, 1319, 1400])
  expect(store['tracked.session-b']).toBeUndefined()
})

test('a folder outside git keeps one tracked list for its sessions', async ($, on) => {
  const clock = mock.clock(on)
  const store: Record<string, unknown> = { 'tracked.dir./work/notes': { at: Date.now(), items: [{ repo: 'acme/pos-api', number: 1319 }] } }
  on('store.get', ($, e) => ({ value: store[e.key] }) as never)
  on('store.set', ($, e) => ((store[e.key] = e.value), { value: undefined }) as never)
  on('store.delete', ($, e) => (delete store[e.key], { value: undefined }) as never)
  on('store.keys', () => ({ value: Object.keys(store) }) as never)
  on('session.id', () => ({ value: 'session-c' }))
  on('session.cwd', () => ({ value: '/work/notes' }))
  // gh finds no repo here.
  on('process.run', ($, e) => (e.argv[1] === 'repo' ? { value: { exitCode: 1, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } } : ok(JSON.stringify({ data: { viewer: { login: 'me' }, repository: { n1319: PR } } }))))
  const band = await $.ui.mount({
    plugin: 'pr-cards', component: 'AbovePrompt', requestId: 'AbovePrompt', surface: 'terminal',
    viewport: { columns: 120, rows: 40 },
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 115 },
  } as never)
  await clock.settle()
  await clock.settle()
  expect(await band.find({ key: 'pr-cards-select-acme/pos-api#1319' })).toBeDefined()
})

test('sends the query on stdin, so 40 references fit past the Windows command-line limit', async ($, on) => {
  const clock = mock.clock(on)
  const calls: { argv: string[]; stdin: string }[] = []
  on('process.run', ($, e) => {
    calls.push({ argv: [...e.argv], stdin: String(e.init?.stdin ?? '') })
    return e.argv[1] === 'repo' ? ok('acme/pos-api\n') : ok(JSON.stringify({ data: { viewer: { login: 'me' }, repository: { n1319: PR } } }))
  })
  const numbers = Array.from({ length: 40 }, (_, i) => 1300 + i)
  await $.ui.mount(message(numbers.map((n) => `#${n}`).join(', ')))
  await clock.settle()
  await clock.settle()
  const graphql = calls.filter((c) => c.argv[1] === 'api')
  expect(graphql).toHaveLength(1)
  expect(graphql[0]!.argv).toEqual(['gh', 'api', 'graphql', '--input', '-'])
  const query = (JSON.parse(graphql[0]!.stdin) as { query: string }).query
  expect(query.length).toBeGreaterThan(32_767)
  expect(numbers.every((n) => query.includes(`n${n}: issueOrPullRequest(number: ${n})`))).toBe(true)
})

test('leaves a message without references to Claude Code', async ($, on) => {
  on('process.run', () => {
    throw new Error('gh must not run')
  })
  const ui = await $.ui.mount(message('## Heading\nNo references, only a [link](https://x.y/#3).\n\n| Count |\n|---|\n| 12 |'))
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
})
