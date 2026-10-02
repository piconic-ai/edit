/**
 * The landing page's little scene: two peers edit it at once. One types the
 * name; the other selects "remote" in the tagline and types "local" over it.
 * Then both carets fade away. It is over well inside five seconds, so it
 * needs no pause control (WCAG 2.2.2).
 */

export const TITLE = 'pedit'
export const WORD_BEFORE = 'remote'
export const WORD_AFTER = 'local'

/** What the page shows from `at` ms on. */
export interface TypingFrame {
  at: number
  title: string
  word: string
  /** The second peer has the word selected. */
  selected: boolean
  /** Both peers are done and their carets fade. */
  done: boolean
}

/**
 * Keystroke times in ms. A hand starts after a beat, runs through the middle
 * of a word and hangs a moment before its last letter.
 */
const TITLE_START = 600
const TITLE_KEYS = [0, 110, 210, 330, 560]
const SELECT_AT = 800
const TYPE_START = 1250
const WORD_KEYS = [0, 120, 230, 350, 560]
/** How long the finished page holds the carets before they fade. */
const LINGER = 800

/** Every change of the scene, in order. */
export function typingScript(): TypingFrame[] {
  type Change = Partial<TypingFrame> & { at: number }
  const changes: Change[] = [{ at: SELECT_AT, selected: true }]
  TITLE_KEYS.forEach((t, i) => {
    changes.push({ at: TITLE_START + t, title: TITLE.slice(0, i + 1) })
  })
  // Typing over a selection replaces it with the first letter.
  WORD_KEYS.forEach((t, i) => {
    changes.push({ at: TYPE_START + t, word: WORD_AFTER.slice(0, i + 1), selected: false })
  })
  const typed = Math.max(...changes.map((c) => c.at))
  changes.push({ at: typed + LINGER, done: true })
  changes.sort((a, b) => a.at - b.at)

  let frame: TypingFrame = { at: 0, title: '', word: WORD_BEFORE, selected: false, done: false }
  const frames = [frame]
  for (const c of changes) {
    frame = { ...frame, ...c }
    frames.push(frame)
  }
  return frames
}

/** Whether to show the scene's last frame at once instead of playing it. */
export function prefersStill(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}
