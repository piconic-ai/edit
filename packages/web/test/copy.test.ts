// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyButton, copyText } from '../src/copy.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('copyText', () => {
  it('writes the text to the clipboard', async () => {
    const writeText = vi.fn(async () => {})
    expect(await copyText('hello', { writeText })).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('reports failure when the clipboard refuses or is missing', async () => {
    const writeText = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError')
    })
    expect(await copyText('hello', { writeText })).toBe(false)
    expect(await copyText('hello', undefined)).toBe(false)
  })
})

describe('copyButton', () => {
  it('copies the whole current text and says so, then resets its label', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async () => {})
    let text = 'first'
    const button = copyButton(() => text, { clipboard: { writeText }, resetMs: 1000 })
    expect(button.textContent).toBe('Copy text')

    text = 'line 1\nline 2'
    button.click()
    await vi.waitFor(() => expect(button.textContent).toBe('Copied'))
    expect(writeText).toHaveBeenCalledWith('line 1\nline 2')
    vi.advanceTimersByTime(1000)
    expect(button.textContent).toBe('Copy text')
  })

  it('tells the reader when copying failed', async () => {
    const button = copyButton(() => 'x', { clipboard: undefined })
    button.click()
    await vi.waitFor(() => expect(button.textContent).toBe('Could not copy'))
  })
})
