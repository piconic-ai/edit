// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Compartment, EditorSelection, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { afterEach, describe, expect, it } from 'vitest'
import { yCollab } from 'y-codemirror.next'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { composite, contrast } from '../src/contrast.ts'
import { COLORS, selectionTint } from '../src/room.ts'
import {
  CARET_HALO,
  DEFAULT_THEME,
  fallbackTheme,
  IMA_PALETTE,
  IMA_SYNTAX,
  readerTheme,
  THEMES,
  ThemeSwitcher,
  themeInfo,
} from '../src/themes.ts'

const views: EditorView[] = []
afterEach(() => {
  for (const v of views.splice(0)) v.destroy()
})

function mount(extensions: Extension) {
  const view = new EditorView({
    parent: document.body.appendChild(document.createElement('div')),
    extensions,
  })
  views.push(view)
  return view
}

/** `rgb(1, 2, 3)` as jsdom computes it, to `#010203`. */
function hex(rgb: string): string {
  const parts = rgb.match(/\d+/g)?.slice(0, 3) ?? []
  return `#${parts.map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`
}

describe('theme registry', () => {
  it('has unique ids, a mix of light and dark, and the ima defaults', () => {
    const ids = THEMES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    const light = THEMES.filter((t) => t.scheme === 'light').length
    const dark = THEMES.filter((t) => t.scheme === 'dark').length
    expect(light).toBeGreaterThanOrEqual(5)
    expect(dark).toBeGreaterThanOrEqual(5)
    expect(themeInfo(DEFAULT_THEME.light)?.scheme).toBe('light')
    expect(themeInfo(DEFAULT_THEME.dark)?.scheme).toBe('dark')
  })

  it.each(THEMES.map((t) => [t.id, t] as const))(
    '%s loads with its declared scheme and colours',
    async (_, theme) => {
      const view = mount(await theme.load())
      expect(view.state.facet(EditorView.darkTheme)).toBe(theme.scheme === 'dark')
      const style = getComputedStyle(view.dom)
      expect(hex(style.backgroundColor)).toBe(theme.bg)
      expect(hex(style.color)).toBe(theme.fg)
    },
  )
})

describe('ima themes', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../src/style.css'), 'utf8')
  // `--panel: light-dark(#ffffff, #1a2029);` and so on.
  const fromCss = (name: string) => {
    const m = new RegExp(`--${name}:\\s*light-dark\\((#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`).exec(
      css,
    )
    if (!m) throw new Error(`--${name} not found in style.css`)
    return { light: m[1], dark: m[2] }
  }

  it.each(Object.keys(IMA_PALETTE.light))('uses the page palette for --%s', (name) => {
    const key = name as keyof typeof IMA_PALETTE.light
    expect(fromCss(name)).toEqual({ light: IMA_PALETTE.light[key], dark: IMA_PALETTE.dark[key] })
  })

  it.each(['light', 'dark'] as const)('keeps %s syntax colours readable on the panel', (scheme) => {
    const { panel, ink, muted, accent } = IMA_PALETTE[scheme]
    const { selection, ...syntax } = IMA_SYNTAX[scheme]
    for (const color of [ink, muted, accent, ...Object.values(syntax)]) {
      expect(contrast(color, panel), color).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(ink, selection)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('remote cursors and selections', () => {
  it('prints caret labels (white text) readably on every participant colour', () => {
    for (const color of COLORS) {
      expect(contrast('#ffffff', color), color).toBeGreaterThanOrEqual(4.5)
    }
  })

  // WCAG 1.4.11: carets are UI components and need 3:1 against what is around them.
  it.each(THEMES.map((t) => [t.id, t] as const))(
    'are visible and keep text readable on %s',
    (_, theme) => {
      for (const color of COLORS) {
        if (theme.scheme === 'dark') {
          // The halo sits between the caret and the background.
          expect(contrast(color, CARET_HALO), color).toBeGreaterThanOrEqual(3)
          expect(contrast(CARET_HALO, theme.bg)).toBeGreaterThanOrEqual(3)
        } else {
          expect(contrast(color, theme.bg), color).toBeGreaterThanOrEqual(3)
        }

        const tinted = composite(selectionTint(color), theme.bg)
        // Some themes ship text below 4.5:1 themselves; the tint may not push it under 3:1.
        expect(contrast(theme.fg, tinted), `text over ${color}`).toBeGreaterThanOrEqual(3)
        // Still distinguishable from the background.
        expect(contrast(tinted, theme.bg), `tint of ${color}`).toBeGreaterThanOrEqual(1.1)
      }
    },
  )

  it.each(['light', 'dark'] as const)(
    'draws the caret halo only on %s themes that need it',
    (scheme) => {
      const view = mount([fallbackTheme(DEFAULT_THEME[scheme]).extension, readerTheme])
      const caret = view.contentDOM.appendChild(document.createElement('span'))
      caret.className = 'cm-ySelectionCaret'
      const shadow = getComputedStyle(caret).boxShadow
      if (scheme === 'dark') expect(shadow).toContain('#ffffff')
      else expect(shadow).toBe('')
    },
  )
})

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** A theme extension that tags the editor, so tests can tell which one is active. */
function marker(name: string): Extension {
  return EditorView.editorAttributes.of({ 'data-theme': name })
}

function setup() {
  const doc = new Y.Doc()
  const text = doc.getText('content')
  const theme = new Compartment()
  const view = mount([
    basicSetup,
    theme.of(marker('start')),
    readerTheme,
    yCollab(text, new Awareness(doc)),
  ])
  doc.transact(() => text.insert(0, 'shared text'), 'remote')
  return { doc, text, theme, view }
}

describe('ThemeSwitcher', () => {
  it('reconfigures the real themes keeping the document, selection and Yjs binding', async () => {
    const { doc, text, theme, view } = setup()
    view.dispatch({ selection: EditorSelection.single(2, 6) })
    const switcher = new ThemeSwitcher(view, theme, 'ima-light')

    for (const id of ['dracula', 'solarized-light', 'ima-dark']) {
      expect(await switcher.set(id)).toBe(true)
      expect(switcher.id).toBe(id)
      expect(view.state.facet(EditorView.darkTheme)).toBe(themeInfo(id)?.scheme === 'dark')
    }
    expect(view.state.doc.toString()).toBe('shared text')
    expect(view.state.selection.main).toMatchObject({ from: 2, to: 6 })

    // A remote edit still arrives through the same binding.
    const remote = new Y.Doc()
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc))
    remote.getText('content').insert(0, '> ')
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)), 'remote')
    expect(view.state.doc.toString()).toBe('> shared text')
    expect(text.toString()).toBe('> shared text')
  })

  it('ends on the latest choice when an earlier one loads slowly', async () => {
    const { theme, view } = setup()
    const slow = deferred<Extension>()
    const switcher = new ThemeSwitcher(view, theme, 'ima-light', (id) =>
      id === 'dracula' ? slow.promise : Promise.resolve(marker(id)),
    )

    const first = switcher.set('dracula')
    await switcher.set('github-light')
    slow.resolve(marker('dracula'))
    await first
    expect(switcher.id).toBe('github-light')
    expect(view.dom.dataset.theme).toBe('github-light')
  })

  it('falls back to the ima theme of the same scheme when a theme cannot load', async () => {
    const { theme, view } = setup()
    const switcher = new ThemeSwitcher(view, theme, 'ima-light', () =>
      Promise.reject(new Error('offline')),
    )

    expect(await switcher.set('dracula')).toBe(false)
    expect(switcher.id).toBe('ima-dark')
    expect(view.state.facet(EditorView.darkTheme)).toBe(true)
    expect(view.dom.dataset.theme).toBeUndefined()
  })
})
