// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { contrast } from '../src/contrast.ts'
import {
  applyPalette,
  derivePalette,
  mix,
  PALETTE_KEY,
  PALETTE_VARS,
  readable,
  systemVars,
  TEXT_CONTRAST,
  themeVars,
} from '../src/palette.ts'
import { themeInfo } from '../src/themes.ts'

function memoryStore() {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }
}

describe('mix', () => {
  it('moves between two colours in sRGB', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
  })
})

describe('readable', () => {
  it('keeps a colour that already reads', () => {
    expect(readable('#1b2430', ['#ffffff'], 'light')).toBe('#1b2430')
  })

  it('darkens a faint colour on a light page and lightens it on a dark one', () => {
    const light = readable('#aaaaaa', ['#ffffff'], 'light')
    expect(light).not.toBe('#aaaaaa')
    expect(contrast(light, '#ffffff')).toBeGreaterThanOrEqual(TEXT_CONTRAST)
    const dark = readable('#444444', ['#000000'], 'dark')
    expect(contrast(dark, '#000000')).toBeGreaterThanOrEqual(TEXT_CONTRAST)
  })

  it('reads on every background, including ones that depend on the colour', () => {
    const c = readable(
      '#777777',
      (x) => ['#ffffff', '#eeeeee', x === '#777777' ? '#999999' : '#ffffff'],
      'light',
    )
    expect(c).not.toBe('#777777')
    expect(contrast(c, '#eeeeee')).toBeGreaterThanOrEqual(TEXT_CONTRAST)
  })
})

describe('derivePalette', () => {
  it('uses the editor background for the panels and keeps text readable', () => {
    const p = derivePalette('light', { bg: '#fdf6e3', fg: '#657b83', accent: '#268bd2' })
    expect(p.panel).toBe('#fdf6e3')
    for (const color of [p.ink, p.muted, p.accent]) {
      expect(contrast(color, p.panel), color).toBeGreaterThanOrEqual(TEXT_CONTRAST)
    }
    expect(contrast(p.warnInk, p.warnBg)).toBeGreaterThanOrEqual(TEXT_CONTRAST)
    expect(p.codeBg).toBe(`${p.ink}1a`)
  })
})

describe('themeVars / systemVars / applyPalette', () => {
  const light = themeInfo('github-light')?.page
  const dark = themeInfo('github-dark')?.page
  if (!light || !dark) throw new Error('missing default themes')
  const names = [...Object.values(PALETTE_VARS), 'color-scheme'].sort()

  it('sets one theme and its scheme', () => {
    const vars = themeVars('dark', dark)
    expect(Object.keys(vars).sort()).toEqual(names)
    expect(vars['color-scheme']).toBe('dark')
    expect(vars['--panel']).toBe('#0d1117')
  })

  it('pairs two themes by the OS scheme', () => {
    const vars = systemVars(light, dark)
    expect(Object.keys(vars).sort()).toEqual(names)
    expect(vars['color-scheme']).toBe('light dark')
    expect(vars['--panel']).toBe('light-dark(#ffffff, #0d1117)')
    expect(vars['--code-bg']).toBe('light-dark(#afb8c133, #6e768166)')
  })

  it('sets the properties on the root and remembers them for the next first paint', () => {
    const root = document.createElement('html')
    const store = memoryStore()
    const vars = themeVars('dark', dark)
    applyPalette(vars, root, store)
    expect(root.style.getPropertyValue('--accent')).toBe('#58a6ff')
    expect(root.style.getPropertyValue('color-scheme')).toBe('dark')
    expect(JSON.parse(store.data.get(PALETTE_KEY) ?? '')).toEqual(vars)
  })

  it('still colours the page when storage throws', () => {
    const root = document.createElement('html')
    const store = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(() => applyPalette(systemVars(light, dark), root, store)).not.toThrow()
    expect(root.style.getPropertyValue('--bg')).toBe('light-dark(#f6f8fa, #010409)')
  })
})
