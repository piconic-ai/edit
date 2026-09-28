// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  effectiveMode,
  loadViewMode,
  saveViewMode,
  TABLE_VIEW_KEY,
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

  it('keeps the table choice apart from the Markdown one', () => {
    const store = memoryStore()
    saveViewMode('editor', store, 'table')
    expect(store.data.get(TABLE_VIEW_KEY)).toBe('editor')
    expect(store.data.has(VIEW_KEY)).toBe(false)
    expect(loadViewMode(store, 'table')).toBe('editor')
    expect(loadViewMode(store, 'markdown')).toBeNull()
  })

  it('ignores modes that do not belong to the kind', () => {
    const store = memoryStore({ [TABLE_VIEW_KEY]: 'preview' })
    expect(loadViewMode(store, 'table')).toBeNull()
    saveViewMode('table', store, 'markdown')
    expect(store.data.has(VIEW_KEY)).toBe(false)
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

  it('opens tables as a table unless the text was chosen, on any screen', () => {
    expect(effectiveMode(null, false, 'table')).toBe('table')
    expect(effectiveMode(null, true, 'table')).toBe('table')
    expect(effectiveMode('editor', true, 'table')).toBe('editor')
  })

  it('always shows the editor for other files', () => {
    expect(effectiveMode('preview', false, 'plain')).toBe('editor')
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
      const b = view.buttons.get().find((x) => x.mode === mode)
      if (!b) throw new Error(`no ${mode} button`)
      return b
    }
    const pressed = () =>
      view.buttons
        .get()
        .filter((b) => b.pressed)
        .map((b) => b.mode)
    const allHidden = () => view.buttons.get().every((b) => b.hidden)
    return { view, store, applied, button, pressed, allHidden }
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
    view.choose('preview')
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

  it('stays on the editor and hides itself for files without another view', () => {
    const { view, applied, allHidden } = setup({ stored: 'preview' })
    view.setKind('plain')
    expect(view.mode).toBe('editor')
    expect(allHidden()).toBe(true)
    expect(applied.at(-1)).toBe('editor')

    view.setKind('markdown')
    expect(view.mode).toBe('preview')
    expect(allHidden()).toBe(false)
  })

  it('offers Text and Table for tables, remembered apart from Markdown', () => {
    const { view, store, button, pressed } = setup({ stored: 'preview' })
    view.setKind('table')
    expect(view.mode).toBe('table')
    expect(button('editor').label).toBe('Text')
    expect(button('split').hidden).toBe(true)
    expect(button('preview').hidden).toBe(true)
    expect(button('table').hidden).toBe(false)
    expect(pressed()).toEqual(['table'])

    view.choose('editor')
    expect(view.mode).toBe('editor')
    expect(store.data.get(TABLE_VIEW_KEY)).toBe('editor')
    expect(store.data.get(VIEW_KEY)).toBe('preview')

    view.setKind('markdown')
    expect(button('editor').label).toBe('Edit')
    expect(button('table').hidden).toBe(true)
    expect(view.mode).toBe('preview')
  })

  it('falls back to the text while the file does not parse, and returns after', () => {
    const { view, button, applied } = setup()
    view.setKind('table')
    view.setTableError('A quoted value is never closed (line 3)')
    expect(view.mode).toBe('editor')
    expect(applied.at(-1)).toBe('editor')
    expect(button('table').disabled).toBe(true)
    expect(button('table').title).toContain('line 3')

    view.setTableError(null)
    expect(view.mode).toBe('table')
    expect(button('table').disabled).toBe(false)
    expect(button('table').title).toBeNull()
  })

  it('ignores a mode the file kind does not have', () => {
    const { view, pressed } = setup()
    view.choose('table')
    expect(view.mode).toBe('split')
    expect(pressed()).toEqual(['split'])
  })

  it('ignores a table error for Markdown files', () => {
    const { view } = setup({ stored: 'preview' })
    view.setTableError('broken')
    expect(view.mode).toBe('preview')
  })
})
