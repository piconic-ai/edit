// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  APPEARANCE_KEY,
  type Appearance,
  applyText,
  DEFAULT_APPEARANCE,
  FONT_SIZE,
  fontSizeRange,
  IOS_FONT_FLOOR,
  loadAppearance,
  pageColors,
  parseAppearance,
  resolveTheme,
  saveAppearance,
} from '../src/appearance.ts'
import { themeInfo } from '../src/themes.ts'

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

describe('loadAppearance / saveAppearance', () => {
  it('starts from the defaults', () => {
    expect(loadAppearance(memoryStore())).toEqual(DEFAULT_APPEARANCE)
    expect(loadAppearance(null)).toEqual(DEFAULT_APPEARANCE)
    expect(DEFAULT_APPEARANCE).toMatchObject({
      theme: null,
      fontSize: 15,
      lineHeight: 1.6,
      wrap: true,
    })
  })

  it('round-trips under one key', () => {
    const store = memoryStore()
    const a: Appearance = {
      theme: 'dracula',
      fontSize: 18,
      lineHeight: 1.8,
      wrap: false,
    }
    saveAppearance(a, store)
    expect([...store.data.keys()]).toEqual([APPEARANCE_KEY])
    expect(loadAppearance(store)).toEqual(a)
  })

  it('survives storage that throws or holds garbage', () => {
    expect(loadAppearance(brokenStore)).toEqual(DEFAULT_APPEARANCE)
    expect(() => saveAppearance(DEFAULT_APPEARANCE, brokenStore)).not.toThrow()
    expect(loadAppearance(memoryStore({ [APPEARANCE_KEY]: '{not json' }))).toEqual(
      DEFAULT_APPEARANCE,
    )
    expect(loadAppearance(memoryStore({ [APPEARANCE_KEY]: '42' }))).toEqual(DEFAULT_APPEARANCE)
  })
})

describe('parseAppearance', () => {
  it('clamps numbers to their ranges and steps', () => {
    expect(parseAppearance({ fontSize: 99, lineHeight: 0.5 })).toMatchObject({
      fontSize: 24,
      lineHeight: 1.2,
    })
    expect(parseAppearance({ fontSize: 13.6, lineHeight: 1.72 })).toMatchObject({
      fontSize: 14,
      lineHeight: 1.7,
    })
    expect(parseAppearance({ fontSize: 'big', lineHeight: Number.NaN })).toMatchObject({
      fontSize: 15,
      lineHeight: 1.6,
    })
  })

  it('drops unknown values and keys', () => {
    const a = parseAppearance({ theme: 'nord', wrap: 'yes', x: 1 })
    expect(a).toEqual(DEFAULT_APPEARANCE)
    expect(parseAppearance({ theme: 42 }).theme).toBeNull()
    expect(parseAppearance({ theme: 'solarized-dark' }).theme).toBe('solarized-dark')
  })
})

describe('parseAppearance with settings from earlier versions', () => {
  const legacy = { page: 'system', editor: 'page', light: 'ima-light', dark: 'ima-dark' }

  it('keeps following the OS on the defaults', () => {
    expect(parseAppearance(legacy, false).theme).toBeNull()
    expect(parseAppearance(legacy, true).theme).toBeNull()
  })

  it('keeps the theme the reader saw under the OS scheme', () => {
    const a = { ...legacy, light: 'solarized-light', dark: 'dracula' }
    expect(parseAppearance(a, false).theme).toBe('solarized-light')
    expect(parseAppearance(a, true).theme).toBe('dracula')
    expect(parseAppearance({ ...legacy, dark: 'dracula' }, false).theme).toBeNull()
  })

  it('keeps a chosen scheme or editor pin, mapping the removed ima themes to GitHub', () => {
    expect(parseAppearance({ ...legacy, page: 'dark' }, false).theme).toBe('github-dark')
    expect(parseAppearance({ ...legacy, page: 'light', dark: 'dracula' }, true).theme).toBe(
      'github-light',
    )
    expect(
      parseAppearance({ ...legacy, page: 'light', editor: 'dark', dark: 'dracula' }, false).theme,
    ).toBe('dracula')
  })

  it('ignores a pick that does not belong to its scheme', () => {
    expect(parseAppearance({ page: 'dark', dark: 'github-light' }).theme).toBeNull()
    expect(parseAppearance({ page: 'dark', dark: 'nord' }).theme).toBeNull()
  })

  it('migrates through loadAppearance with the OS scheme', () => {
    const store = memoryStore({
      [APPEARANCE_KEY]: JSON.stringify({ ...legacy, light: 'gruvbox-light', fontSize: 18 }),
    })
    expect(loadAppearance(store, false)).toMatchObject({ theme: 'gruvbox-light', fontSize: 18 })
  })
})

describe('resolveTheme', () => {
  it('shows the default theme of the OS scheme until the reader picks one', () => {
    expect(resolveTheme(DEFAULT_APPEARANCE, false)).toBe('github-light')
    expect(resolveTheme(DEFAULT_APPEARANCE, true)).toBe('github-dark')
  })

  it('shows the pick whatever the OS scheme', () => {
    const a = { ...DEFAULT_APPEARANCE, theme: 'dracula' }
    expect(resolveTheme(a, false)).toBe('dracula')
    expect(resolveTheme(a, true)).toBe('dracula')
  })
})

describe('pageColors', () => {
  const light = themeInfo('github-light')?.page
  const dark = themeInfo('github-dark')?.page

  it('follows the OS with the default themes until the reader picks one', () => {
    const vars = pageColors(DEFAULT_APPEARANCE)
    expect(vars['color-scheme']).toBe('light dark')
    expect(vars['--panel']).toBe(`light-dark(${light?.panel}, ${dark?.panel})`)
  })

  it('colours the page in the picked theme and its scheme', () => {
    const vars = pageColors({ ...DEFAULT_APPEARANCE, theme: 'dracula' })
    expect(vars['color-scheme']).toBe('dark')
    expect(vars['--accent']).toBe(themeInfo('dracula')?.page.accent)
  })

  it('follows the theme the editor fell back to rather than the pick', () => {
    const vars = pageColors({ ...DEFAULT_APPEARANCE, theme: 'dracula' }, 'github-dark')
    expect(vars['--panel']).toBe(dark?.panel)
  })
})

describe('applyText', () => {
  it('exposes the text settings as CSS variables', () => {
    const root = document.createElement('html')
    applyText({ ...DEFAULT_APPEARANCE, fontSize: 18, lineHeight: 1.4 }, root)
    expect(root.style.getPropertyValue('--editor-font-size')).toBe('18px')
    expect(root.style.getPropertyValue('--editor-line-height')).toBe('1.4')
  })
})

describe('fontSizeRange', () => {
  it('offers the full range off iOS', () => {
    expect(fontSizeRange(false)).toEqual(FONT_SIZE)
  })

  it('starts at the size iOS shows anyway, so every step changes the text', () => {
    expect(fontSizeRange(true)).toEqual({ ...FONT_SIZE, min: IOS_FONT_FLOOR })
  })
})
