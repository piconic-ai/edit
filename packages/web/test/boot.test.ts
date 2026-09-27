// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import html from '../index.html?raw'
import { APPEARANCE_KEY } from '../src/appearance.ts'

// The classic inline script that applies the stored appearance before the first paint.
const boot = (() => {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const script = [...doc.head.querySelectorAll('script')].find((s) => !s.type && !s.src)
  if (!script?.textContent) throw new Error('no boot script in index.html')
  return script.textContent
})()

function run(stored: string | null) {
  const root = document.documentElement
  root.removeAttribute('data-scheme')
  root.removeAttribute('style')
  const data = new Map(stored === null ? [] : [[APPEARANCE_KEY, stored]])
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null })
  new Function(boot)()
  return root
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('index.html boot script', () => {
  it('applies the stored scheme and text settings', () => {
    const root = run(JSON.stringify({ page: 'dark', fontSize: 18, font: 'sans', lineHeight: 1.8 }))
    expect(root.dataset.scheme).toBe('dark')
    expect(root.style.getPropertyValue('--editor-font-size')).toBe('18px')
    expect(root.style.getPropertyValue('--editor-font')).toBe('var(--sans)')
    expect(root.style.getPropertyValue('--editor-line-height')).toBe('1.8')
  })

  it('leaves the defaults from style.css alone when nothing is stored', () => {
    const root = run(null)
    expect(root.hasAttribute('data-scheme')).toBe(false)
    expect(root.getAttribute('style')).toBeNull()
  })

  it.each([
    ['garbage', '{not json'],
    ['a number', '42'],
    ['null', 'null'],
    ['wrong types', JSON.stringify({ page: 'sepia', fontSize: '99', lineHeight: 9, font: 1 })],
  ])('ignores %s', (_, stored) => {
    const root = run(stored)
    expect(root.hasAttribute('data-scheme')).toBe(false)
    expect(root.getAttribute('style')).toBeNull()
  })

  it('does not throw when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
    })
    expect(() => new Function(boot)()).not.toThrow()
  })

  it('does not throw where touching localStorage throws', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError')
      },
    })
    try {
      expect(() => new Function(boot)()).not.toThrow()
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage
    }
  })
})

describe('index.html viewport', () => {
  const meta = new DOMParser()
    .parseFromString(html, 'text/html')
    .querySelector<HTMLMetaElement>('meta[name="viewport"]')
  const content = meta?.content.split(',').map((s) => s.trim()) ?? []

  it('shrinks the layout for the on-screen keyboard on Android', () => {
    expect(content).toContain('interactive-widget=resizes-content')
  })

  it('reaches under the notch, which style.css pads with safe-area insets', () => {
    expect(content).toContain('viewport-fit=cover')
  })

  it('never stops the reader from zooming', () => {
    expect(content.some((c) => /^(maximum-scale|user-scalable)=/.test(c))).toBe(false)
  })
})
