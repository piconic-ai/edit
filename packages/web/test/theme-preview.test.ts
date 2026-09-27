// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { themePreview } from '../src/theme-preview.ts'
import { THEMES, themeInfo } from '../src/themes.ts'

describe('themePreview', () => {
  it('draws a miniature page in the colours of the theme', () => {
    const dracula = themeInfo('dracula')
    if (!dracula) throw new Error('missing theme')
    const el = themePreview(dracula)
    expect(el.getAttribute('aria-hidden')).toBe('true')
    expect(el.style.getPropertyValue('--tp-panel')).toBe(dracula.page.panel)
    expect(el.style.getPropertyValue('--tp-ink')).toBe(dracula.page.ink)
    expect(el.style.getPropertyValue('--tp-accent')).toBe(dracula.page.accent)
    expect(el.querySelector('.tp-heading')?.textContent).toBe('Aa')
    expect(el.querySelector('.tp-link')).not.toBeNull()
    expect(el.querySelector('.tp-code')).not.toBeNull()
  })

  it('tells every theme apart', () => {
    const looks = THEMES.map((t) => {
      const style = themePreview(t).style
      return ['--tp-panel', '--tp-ink', '--tp-accent'].map((n) => style.getPropertyValue(n)).join()
    })
    expect(new Set(looks).size).toBe(THEMES.length)
  })
})
