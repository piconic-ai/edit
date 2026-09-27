// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  effectiveMode,
  loadViewMode,
  saveViewMode,
  VIEW_KEY,
  type ViewMode,
  ViewSwitch,
} from '../src/view.ts'

function memoryStore(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }
}

const brokenStore = {
  getItem: (): string | null => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
}

describe('loadViewMode / saveViewMode', () => {
  it('has no choice by default and ignores unknown values', () => {
    expect(loadViewMode(memoryStore())).toBeNull()
    expect(loadViewMode(memoryStore({ [VIEW_KEY]: 'sideways' }))).toBeNull()
    expect(loadViewMode(null)).toBeNull()
  })

  it('remembers the choice', () => {
    const store = memoryStore()
    saveViewMode('preview', store)
    expect(store.data.get(VIEW_KEY)).toBe('preview')
    expect(loadViewMode(store)).toBe('preview')
  })

  it('survives storage that throws', () => {
    expect(loadViewMode(brokenStore)).toBeNull()
    expect(() => saveViewMode('editor', brokenStore)).not.toThrow()
  })
})

describe('effectiveMode', () => {
  it.each<[ViewMode | null, boolean, ViewMode]>([
    [null, false, 'split'],
    [null, true, 'preview'],
    ['split', true, 'preview'],
    ['editor', true, 'editor'],
    ['editor', false, 'editor'],
    ['preview', false, 'preview'],
  ])('%s on narrow=%s -> %s', (chosen, narrow, expected) => {
    expect(effectiveMode(chosen, narrow)).toBe(expected)
  })
})

describe('ViewSwitch', () => {
  function setup(options: { narrow?: boolean; stored?: ViewMode } = {}) {
    const store = memoryStore(options.stored ? { [VIEW_KEY]: options.stored } : {})
    const applied: ViewMode[] = []
    const view = new ViewSwitch({
      narrow: options.narrow ?? false,
      onApply: (mode) => applied.push(mode),
      store,
    })
    const button = (mode: ViewMode) => {
      const b = view.element.querySelector<HTMLButtonElement>(`[data-mode="${mode}"]`)
      if (!b) throw new Error(`no ${mode} button`)
      return b
    }
    const pressed = () =>
      [...view.element.querySelectorAll('[aria-pressed="true"]')].map(
        (b) => (b as HTMLElement).dataset.mode,
      )
    return { view, store, applied, button, pressed }
  }

  it('starts in the stored mode', () => {
    const { view, applied, pressed } = setup({ stored: 'editor' })
    expect(view.mode).toBe('editor')
    expect(applied).toEqual(['editor'])
    expect(pressed()).toEqual(['editor'])
  })

  it('switches and remembers on click', () => {
    const { view, store, applied, button, pressed } = setup()
    expect(view.mode).toBe('split')
    button('preview').click()
    expect(view.mode).toBe('preview')
    expect(store.data.get(VIEW_KEY)).toBe('preview')
    expect(applied.at(-1)).toBe('preview')
    expect(pressed()).toEqual(['preview'])
  })

  it('hides Split on narrow screens and shows the preview instead', () => {
    const { view, button, pressed } = setup({ stored: 'split', narrow: true })
    expect(view.mode).toBe('preview')
    expect(button('split').hidden).toBe(true)
    expect(pressed()).toEqual(['preview'])

    view.setNarrow(false)
    expect(view.mode).toBe('split')
    expect(button('split').hidden).toBe(false)
  })

  it('stays on the editor and hides itself for files without a preview', () => {
    const { view, applied } = setup({ stored: 'preview' })
    view.setEnabled(false)
    expect(view.mode).toBe('editor')
    expect(view.element.hidden).toBe(true)
    expect(applied.at(-1)).toBe('editor')

    view.setEnabled(true)
    expect(view.mode).toBe('preview')
    expect(view.element.hidden).toBe(false)
  })
})
