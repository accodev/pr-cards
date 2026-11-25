// The pointer on references in replies. Pi's fullscreen mode takes every mouse report before an
// extension's input listener, and its transcript has no mouse hook. The reports still arrive on
// stdin: read them there, beside Pi's own reader, as @narumitw/pi-inline does for its link previews.
// A hover on a reference opens its card, a plain click tracks it, and Ctrl+click opens it on GitHub.
import { StdinBuffer, TuiAltScreen, type OverlayHandle, type TUI } from '@earendil-works/pi-tui'
import { label, refAt, type Ref } from './prs.ts'

// The pointer has to rest this long on a reference before its card opens.
const HOVER_DELAY_MS = 250

export type PointerActions = {
  // The card's lines, or nothing while the reference is still loading.
  cardFor: (ref: Ref) => string[] | undefined
  width: number
  want: (ref: Ref) => void
  track: (ref: Ref) => void
  open: (ref: Ref) => void
}

type Target = { row: number; col: number; key: string; ref: Ref }
type Rect = { top: number; bottom: number; left: number; right: number }

// What one SGR mouse report means: a move with no button held (35, plus 4, 8 or 16 for Shift, Alt
// or Ctrl), a drag (32 set), or the left button (0, plus 16 for Ctrl) going down or up.
export function readReport(data: string) {
  const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data)
  if (!m) return null
  const button = Number(m[1])
  const at = { col: Number(m[2]) - 1, row: Number(m[3]) - 1 }
  if ((button & 35) === 35) return { kind: 'move' as const, ...at }
  if (button & 32) return { kind: 'drag' as const, ...at }
  if ((button & ~16) !== 0) return { kind: 'other' as const, ...at }
  return { kind: m[4] === 'm' ? ('up' as const) : ('down' as const), ctrl: (button & 16) !== 0, ...at }
}

// Starts reading the pointer for `t`; the returned function stops it.
export function watchPointer(t: TUI, act: PointerActions): () => void {
  let hover: Target | undefined
  let timer: NodeJS.Timeout | undefined
  let overlay: OverlayHandle | undefined
  let card: Rect | undefined
  let press: { row: number; col: number } | undefined
  const screenLine = (row: number) => (t instanceof TuiAltScreen ? t.getScreenLines()[row] ?? '' : '')
  const onCard = (row: number, col: number) => card !== undefined && row >= card.top && row < card.bottom && col >= card.left && col < card.right

  const hide = () => {
    clearTimeout(timer)
    hover = undefined
    overlay?.hide()
    overlay = undefined
    card = undefined
  }

  const show = (target: Target) => {
    if (hover !== target || t.hasOverlay()) return
    const lines = act.cardFor(target.ref)
    // Not loaded yet: look again shortly, while the pointer stays.
    if (!lines) {
      timer = setTimeout(() => show(target), HOVER_DELAY_MS)
      return
    }
    if (!refAt(screenLine(target.row), target.col)) return hide()
    const { columns, rows } = t.terminal
    const width = Math.min(act.width, columns)
    const col = Math.max(0, Math.min(target.col, columns - width))
    // It opens upward, as in Claude Code, unless the rows above are too few.
    const up = target.row >= lines.length
    const top = up ? target.row - lines.length : target.row + 1
    card = { top, bottom: top + lines.length, left: col, right: col + width }
    const place = up ? { anchor: 'bottom-left' as const, margin: { bottom: rows - target.row } } : { row: target.row + 1 }
    overlay = t.showOverlay({ render: () => lines, invalidate: () => undefined }, {
      nonCapturing: true, width, col, ...place,
      visible: (w, h) => w === columns && h === rows,
    })
  }

  const observe = (data: string) => {
    const r = readReport(data)
    if (!r) {
      if (hover) hide()
      return
    }
    if (r.kind === 'move') {
      if (onCard(r.row, r.col)) return
      const ref = refAt(screenLine(r.row), r.col)
      const key = ref ? label(ref) : ''
      if (hover && hover.key === key && hover.row === r.row) return
      hide()
      if (!ref) return
      act.want(ref)
      const target = { row: r.row, col: r.col, key, ref }
      hover = target
      timer = setTimeout(() => show(target), HOVER_DELAY_MS)
      return
    }
    // A drag selects text: no click follows.
    if (r.kind === 'drag') press = undefined
    if (r.kind !== 'down' && r.kind !== 'up') return
    if (r.kind === 'down') {
      // A click on the card is Pi's: it opens the link there.
      if (!onCard(r.row, r.col)) hide()
      press = { row: r.row, col: r.col }
      return
    }
    const clicked = press !== undefined && press.row === r.row && press.col === r.col
    press = undefined
    if (!clicked || onCard(r.row, r.col)) return
    const ref = refAt(screenLine(r.row), r.col)
    if (!ref) return
    if (r.ctrl) act.open(ref)
    else act.track(ref)
  }

  const input = new StdinBuffer()
  input.on('data', observe)
  input.on('paste', hide)
  const onData = (data: string | Buffer) => {
    if (process.stdin.isRaw && t instanceof TuiAltScreen) input.process(data)
  }
  process.stdin.on('data', onData)
  return () => {
    process.stdin.off('data', onData)
    input.destroy()
    hide()
  }
}
