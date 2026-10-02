import { describe, expect, it } from 'vitest'
import { TITLE, typingScript, WORD_AFTER, WORD_BEFORE } from '../src/landing.ts'

describe('typingScript', () => {
  const frames = typingScript()
  const changes = <K extends 'title' | 'word' | 'selected' | 'done'>(key: K) =>
    frames.map((f) => f[key]).filter((v, i, all) => v !== all[i - 1])

  it('starts blank and with the wrong word, and ends with both done', () => {
    expect(frames[0]).toEqual({ at: 0, title: '', word: WORD_BEFORE, selected: false, done: false })
    expect(frames.at(-1)).toMatchObject({
      title: TITLE,
      word: WORD_AFTER,
      selected: false,
      done: true,
    })
  })

  it('is over, carets faded, within five seconds and in time order', () => {
    const at = frames.map((f) => f.at)
    expect(at).toEqual([...at].sort((a, b) => a - b))
    // The carets take 0.6s to fade once done (style.css).
    expect((at.at(-1) ?? 0) + 600).toBeLessThanOrEqual(5000)
  })

  it('types the name a letter at a time', () => {
    expect(changes('title')).toEqual(['', 'p', 'pe', 'ped', 'pedi', 'pedit'])
  })

  it('selects the wrong word, then types the right one over it', () => {
    expect(changes('word')).toEqual(['remote', 'l', 'lo', 'loc', 'loca', 'local'])
    expect(changes('selected')).toEqual([false, true, false])
    const selected = frames.filter((f) => f.selected)
    expect(selected.every((f) => f.word === WORD_BEFORE)).toBe(true)
  })

  it('has the two peers at it at the same time', () => {
    const typingName = frames.filter((f) => f.title !== '' && f.title !== TITLE)
    expect(typingName.some((f) => f.selected || f.word !== WORD_BEFORE)).toBe(true)
  })

  it('fades the carets only after both have finished', () => {
    const done = frames.findIndex((f) => f.done)
    expect(
      frames.slice(0, done).every((f) => f.title !== TITLE || f.word !== WORD_AFTER || !f.done),
    ).toBe(true)
    expect(frames[done]).toMatchObject({ title: TITLE, word: WORD_AFTER })
  })
})
