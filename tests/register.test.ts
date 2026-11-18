import { expect, test } from 'claude-code/testing'

test('loads and registers the AssistantMessage render hook', async ($, on) => {
  expect(typeof on).toBe('function')
})
