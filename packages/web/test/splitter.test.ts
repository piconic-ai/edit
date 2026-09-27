// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  clampRatio,
  loadSplitRatio,
  ratioAt,
  SPLIT_KEY,
  Splitter,
  saveSplitRatio,
} from '../src/splitter.ts'

function memoryStore(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }
}

describe('ratios', () => {
  it('keeps both panes usable', () => {
    expect(clampRatio(0.05)).toBe(0.2)
    expect(clampRatio(0.95)).toBe(0.8)
    expect(clampRatio(0.3)).toBe(0.3)
    expect(clampRatio(Number.NaN)).toBe(0.5)
  })

  it('reads the pointer position against the container', () => {
    expect(ratioAt(400, { left: 100, width: 1000 })).toBe(0.3)
    expect(ratioAt(0, { left: 100, width: 1000 })).toBe(0.2)
    expect(ratioAt(400, { left: 0, width: 0 })).toBe(0.5)
  })

  it('remembers the width and ignores junk', () => {
    const store = memoryStore()
    expect(loadSplitRatio(store)).toBe(0.5)
    saveSplitRatio(0.4123, store)
    expect(store.data.get(SPLIT_KEY)).toBe('0.412')
    expect(loadSplitRatio(store)).toBe(0.412)
    expect(loadSplitRatio(memoryStore({ [SPLIT_KEY]: 'wide' }))).toBe(0.5)
    expect(loadSplitRatio(memoryStore({ [SPLIT_KEY]: '3' }))).toBe(0.8)
  })
})

describe('Splitter', () => {
  function setup(stored?: string) {
    const store = memoryStore(stored ? { [SPLIT_KEY]: stored } : {})
    const container = document.createElement('main')
    container.getBoundingClientRect = () => ({ left: 0, width: 1000 }) as DOMRect
    const onResize = vi.fn()
    const splitter = new Splitter(container, { store, onResize })
    container.append(splitter.element)
    return { store, container, splitter, onResize }
  }

  const pointer = (type: string, clientX: number) =>
    Object.assign(new MouseEvent(type, { clientX, button: 0, bubbles: true }), { pointerId: 1 })

  it('starts at the stored width', () => {
    const { container, splitter } = setup('0.3')
    expect(container.style.getPropertyValue('--split')).toBe('30%')
    expect(splitter.element.getAttribute('aria-valuenow')).toBe('30')
  })

  it('resizes while dragging and saves on release', () => {
    const { store, container, splitter, onResize } = setup()
    splitter.element.dispatchEvent(pointer('pointerdown', 500))
    splitter.element.dispatchEvent(pointer('pointermove', 350))
    expect(container.style.getPropertyValue('--split')).toBe('35%')
    expect(store.data.has(SPLIT_KEY)).toBe(false)
    splitter.element.dispatchEvent(pointer('pointerup', 350))
    expect(store.data.get(SPLIT_KEY)).toBe('0.35')
    expect(onResize).toHaveBeenCalled()
    expect('resizing' in container.dataset).toBe(false)

    splitter.element.dispatchEvent(pointer('pointermove', 700))
    expect(splitter.ratio).toBe(0.35)
  })

  it('moves with the keyboard and resets on double-click', () => {
    const { store, splitter } = setup('0.5')
    const key = (k: string) =>
      splitter.element.dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true }))
    key('ArrowLeft')
    expect(splitter.ratio).toBeCloseTo(0.45)
    key('End')
    expect(splitter.ratio).toBe(0.8)
    expect(store.data.get(SPLIT_KEY)).toBe('0.8')
    splitter.element.dispatchEvent(new MouseEvent('dblclick'))
    expect(splitter.ratio).toBe(0.5)
    expect(store.data.get(SPLIT_KEY)).toBe('0.5')
  })
})
