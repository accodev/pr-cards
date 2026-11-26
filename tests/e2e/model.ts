// A fake Anthropic Messages API with fixed replies, so a run needs no API key, costs nothing, and
// draws the same reply every time. Claude Code reaches it through ANTHROPIC_BASE_URL, Pi through a
// custom provider in models.json.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OUT } from './kit.ts'

type Block = { type?: string, text?: string }
type Message = { role?: string, content?: string | Block[] }
type Request = { model?: string, stream?: boolean, messages?: Message[] }

const textOf = (m: Message): string =>
  typeof m.content === 'string' ? m.content
    : (m.content ?? []).filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n')

function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) })
  res.end(data)
}

// Serves POST /v1/messages on 127.0.0.1. `replies` maps a word in the last user message to the reply
// text; any other request (a title, a summary) gets "ok". Resolves to the base URL.
export function startModel(replies: Record<string, string>, logName: string): Promise<string> {
  mkdirSync(OUT, { recursive: true })
  const log: string[] = []
  const flush = () => writeFileSync(join(OUT, logName), log.join(''))
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const path = (req.url ?? '').split('?')[0]
    if (req.method !== 'POST') {
      log.push(`${req.method} ${req.url}\n`); flush()
      if (req.method === 'HEAD') { res.writeHead(200); res.end(); return }
      return json(res, 200, {})
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    const body: Request = raw ? JSON.parse(raw) : {}
    log.push(`POST ${path} stream=${body.stream}\n`); flush()
    if (path.endsWith('/count_tokens')) return json(res, 200, { input_tokens: 12 })
    if (!path.endsWith('/messages')) return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: path } })
    const users = (body.messages ?? []).filter(m => m.role === 'user')
    const last = users.length ? textOf(users[users.length - 1]) : ''
    const text = Object.entries(replies).find(([word]) => last.includes(word))?.[1] ?? 'ok'
    const model = body.model ?? 'fake'
    const usage = { input_tokens: 12, output_tokens: Math.max(1, Math.floor(text.length / 4)) }
    if (!body.stream) {
      return json(res, 200, { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }],
        stop_reason: 'end_turn', stop_sequence: null, usage })
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const event = (kind: string, data: unknown) => res.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`)
    event('message_start', { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } })
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    for (let i = 0; i < text.length; i += 200) {
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 200) } })
    }
    event('content_block_stop', { type: 'content_block_stop', index: 0 })
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } })
    event('message_stop', { type: 'message_stop' })
    res.end()
  })
  return new Promise(done => server.listen(0, '127.0.0.1', () => {
    server.unref()
    const address = server.address()
    done(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`)
  }))
}
