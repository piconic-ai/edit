// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  APPEARANCE_KEY,
  type Appearance,
  applyPage,
  applyText,
  DEFAULT_APPEARANCE,
  FONT_SIZE,
  fontSizeRange,
  IOS_FONT_FLOOR,
  loadAppearance,
  parseAppearance,
  pickTheme,
  resolveAppearance,
  saveAppearance,
} from '../src/appearance.ts'

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
      page: 'system',
      editor: 'page',
      light: 'ima-light',
      dark: 'ima-dark',
      fontSize: 15,
      font: 'mono',
      lineHeight: 1.6,
      wrap: true,
    })
  })

  it('round-trips under one key', () => {
    const store = memoryStore()
    const a: Appearance = {
      page: 'dark',
      editor: 'light',
      light: 'solarized-light',
      dark: 'dracula',
      fontSize: 18,
      font: 'sans',
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
    const a = parseAppearance({ page: 'sepia', editor: 'auto', font: 'comic', wrap: 'yes', x: 1 })
    expect(a).toEqual(DEFAULT_APPEARANCE)
  })

  it('falls back to the ima theme for unknown ids or ids of the other scheme', () => {
    expect(parseAppearance({ light: 'nord', dark: 'github-light' })).toMatchObject({
      light: 'ima-light',
      dark: 'ima-dark',
    })
  })
})

describe('resolveAppearance', () => {
  const pages = ['system', 'light', 'dark'] as const
  const editors = ['page', 'light', 'dark'] as const
  const cases = pages.flatMap((page) =>
    editors.flatMap((editor) =>
      [false, true].map((prefersDark) => ({ page, editor, prefersDark })),
    ),
  )

  it.each(cases)(
    'page=$page editor=$editor prefersDark=$prefersDark',
    ({ page, editor, prefersDark }) => {
      const a = { ...DEFAULT_APPEARANCE, page, editor, light: 'github-light', dark: 'dracula' }
      const r = resolveAppearance(a, prefersDark)
      const expectedPage = page === 'system' ? (prefersDark ? 'dark' : 'light') : page
      const expectedEditor = editor === 'page' ? expectedPage : editor
      expect(r).toEqual({
        page: expectedPage,
        editorScheme: expectedEditor,
        editorTheme: expectedEditor === 'dark' ? 'dracula' : 'github-light',
      })
    },
  )
})

describe('pickTheme', () => {
  it('follows the page when the theme matches its scheme', () => {
    const a = pickTheme({ ...DEFAULT_APPEARANCE, editor: 'dark' }, 'github-light', false)
    expect(a).toMatchObject({ light: 'github-light', editor: 'page' })
    expect(resolveAppearance(a, false).editorTheme).toBe('github-light')
  })

  it('pins the editor to the other scheme, keeping each group in memory', () => {
    const a = pickTheme(DEFAULT_APPEARANCE, 'dracula', false)
    expect(a).toMatchObject({ dark: 'dracula', light: 'ima-light', editor: 'dark' })
    expect(resolveAppearance(a, false).editorTheme).toBe('dracula')
  })

  it('moves a page-following editor to the remembered theme when the OS switches', () => {
    let a = pickTheme(DEFAULT_APPEARANCE, 'solarized-dark', true)
    a = pickTheme(a, 'gruvbox-light', false)
    expect(resolveAppearance(a, true).editorTheme).toBe('solarized-dark')
    expect(resolveAppearance(a, false).editorTheme).toBe('gruvbox-light')
  })

  it('ignores unknown themes', () => {
    expect(pickTheme(DEFAULT_APPEARANCE, 'nord', false)).toBe(DEFAULT_APPEARANCE)
  })
})

describe('applyPage / applyText', () => {
  it('sets the scheme only when the reader chose one', () => {
    const root = document.createElement('html')
    applyPage({ ...DEFAULT_APPEARANCE, page: 'dark' }, root)
    expect(root.dataset.scheme).toBe('dark')
    applyPage(DEFAULT_APPEARANCE, root)
    expect(root.hasAttribute('data-scheme')).toBe(false)
  })

  it('exposes the text settings as CSS variables', () => {
    const root = document.createElement('html')
    applyText({ ...DEFAULT_APPEARANCE, fontSize: 18, font: 'sans', lineHeight: 1.4 }, root)
    expect(root.style.getPropertyValue('--editor-font-size')).toBe('18px')
    expect(root.style.getPropertyValue('--editor-font')).toBe('var(--sans)')
    expect(root.style.getPropertyValue('--editor-line-height')).toBe('1.4')
    applyText(DEFAULT_APPEARANCE, root)
    expect(root.style.getPropertyValue('--editor-font')).toBe('var(--mono)')
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
