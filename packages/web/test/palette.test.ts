// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { contrast } from '../src/contrast.ts'
import {
  applyPalette,
  derivePalette,
  mix,
  PALETTE_KEY,
  PALETTE_VARS,
  paletteVars,
  readable,
  TEXT_CONTRAST,
} from '../src/palette.ts'
import { IMA_PALETTE } from '../src/themes.ts'

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

describe('paletteVars / applyPalette', () => {
  const vars = paletteVars(IMA_PALETTE.light, IMA_PALETTE.dark)

  it('pairs the light and dark palettes for every page variable', () => {
    expect(Object.keys(vars).sort()).toEqual(Object.values(PALETTE_VARS).sort())
    expect(vars['--panel']).toBe('light-dark(#ffffff, #1a2029)')
    expect(vars['--code-bg']).toBe('light-dark(#afb8c133, #656c7633)')
  })

  it('sets the variables on the root and remembers them for the next first paint', () => {
    const root = document.createElement('html')
    const store = memoryStore()
    applyPalette(vars, root, store)
    expect(root.style.getPropertyValue('--accent')).toBe('light-dark(#1f7a64, #5cc9a8)')
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
    expect(() => applyPalette(vars, root, store)).not.toThrow()
    expect(root.style.getPropertyValue('--bg')).toBe('light-dark(#f6f7f9, #12161c)')
  })
})
