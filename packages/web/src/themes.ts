import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { type Compartment, type Extension, Prec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { derivePalette, type PagePalette, type Scheme } from './palette.ts'

export type { Scheme }

export interface ThemeInfo {
  id: string
  label: string
  scheme: Scheme
  /** The editor background and text colours, for swatches and the contrast test. */
  bg: string
  fg: string
  /** The colours of the rest of the page, so it matches the editor. */
  page: PagePalette
  load(): Promise<Extension>
}

/** A third-party theme; its page palette comes from its colours and one accent of its own. */
function thirdParty(info: Omit<ThemeInfo, 'page'> & { accent: string }): ThemeInfo {
  const { accent, ...rest } = info
  return { ...rest, page: derivePalette(info.scheme, { bg: info.bg, fg: info.fg, accent }) }
}

/**
 * The page palette from style.css, spelt out because the dark ima theme must
 * also work on a light page. A test keeps the two in sync.
 */
export const IMA_PALETTE = {
  light: {
    bg: '#f6f7f9',
    panel: '#ffffff',
    ink: '#1b2430',
    muted: '#5b6675',
    line: '#d6dce3',
    accent: '#1f7a64',
    codeBg: '#afb8c133',
    warnBg: '#fdf0e3',
    warnInk: '#8a4308',
  },
  dark: {
    bg: '#12161c',
    panel: '#1a2029',
    ink: '#e6ebf1',
    muted: '#9aa5b3',
    line: '#2f3844',
    accent: '#5cc9a8',
    codeBg: '#656c7633',
    warnBg: '#33241a',
    warnInk: '#f5c08a',
  },
} as const satisfies Record<Scheme, PagePalette>

/** Extra hues for code, chosen to read on the ima panels. */
export const IMA_SYNTAX = {
  light: {
    string: '#a8540c',
    number: '#4254b5',
    type: '#b5427a',
    func: '#18708f',
    invalid: '#c0392b',
    selection: '#cfe8e0',
  },
  dark: {
    string: '#f0a868',
    number: '#9aaaff',
    type: '#f08dbd',
    func: '#6cc3e0',
    invalid: '#ff7b72',
    selection: '#2e4a44',
  },
} as const

function imaTheme(scheme: Scheme): Extension {
  const p = IMA_PALETTE[scheme]
  const s = IMA_SYNTAX[scheme]
  const theme = EditorView.theme(
    {
      '&': { backgroundColor: p.panel, color: p.ink },
      '.cm-content': { caretColor: p.ink },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: p.ink },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: s.selection },
      '.cm-gutters': { backgroundColor: p.panel, color: p.muted, borderRightColor: p.line },
      '.cm-panels': { backgroundColor: p.bg, color: p.ink },
      '.cm-tooltip': { backgroundColor: p.bg, color: p.ink, borderColor: p.line },
    },
    { dark: scheme === 'dark' },
  )
  const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: p.accent },
    { tag: [t.string, t.special(t.string), t.regexp, t.character], color: s.string },
    { tag: [t.number, t.bool, t.atom, t.null, t.unit], color: s.number },
    { tag: [t.typeName, t.className, t.namespace, t.tagName], color: s.type },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName), t.attributeName],
      color: s.func,
    },
    { tag: [t.comment, t.meta, t.processingInstruction, t.quote], color: p.muted },
    { tag: t.comment, fontStyle: 'italic' },
    { tag: t.heading, color: p.ink, fontWeight: 'bold' },
    { tag: [t.link, t.url], color: p.accent, textDecoration: 'underline' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strong, fontWeight: 'bold' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: [t.invalid, t.deleted], color: s.invalid },
    { tag: t.inserted, color: p.accent },
  ])
  return [theme, syntaxHighlighting(highlight)]
}

const imaLight = imaTheme('light')
const imaDark = imaTheme('dark')

/** Light and dark pairs where they exist, so the choice per group is meaningful. */
export const THEMES: readonly ThemeInfo[] = [
  {
    id: 'ima-light',
    label: 'ima Light',
    scheme: 'light',
    bg: IMA_PALETTE.light.panel,
    fg: IMA_PALETTE.light.ink,
    page: IMA_PALETTE.light,
    load: async () => imaLight,
  },
  thirdParty({
    id: 'github-light',
    label: 'GitHub Light',
    scheme: 'light',
    bg: '#ffffff',
    fg: '#24292e',
    accent: '#0969da',
    load: async () => (await import('@uiw/codemirror-theme-github')).githubLight,
  }),
  thirdParty({
    id: 'solarized-light',
    label: 'Solarized Light',
    scheme: 'light',
    bg: '#fdf6e3',
    fg: '#657b83',
    accent: '#268bd2',
    load: async () => (await import('@uiw/codemirror-theme-solarized')).solarizedLight,
  }),
  thirdParty({
    id: 'gruvbox-light',
    label: 'Gruvbox Light',
    scheme: 'light',
    bg: '#fbf1c7',
    fg: '#3c3836',
    accent: '#076678',
    load: async () => (await import('@uiw/codemirror-theme-gruvbox-dark')).gruvboxLight,
  }),
  thirdParty({
    id: 'catppuccin-latte',
    label: 'Catppuccin Latte',
    scheme: 'light',
    bg: '#eff1f5',
    fg: '#4c4f69',
    accent: '#8839ef',
    load: async () => (await import('@catppuccin/codemirror')).catppuccinLatte,
  }),
  thirdParty({
    id: 'tokyo-night-day',
    label: 'Tokyo Night Day',
    scheme: 'light',
    bg: '#e1e2e7',
    fg: '#3760bf',
    accent: '#2e7de9',
    load: async () => (await import('@uiw/codemirror-theme-tokyo-night-day')).tokyoNightDay,
  }),
  {
    id: 'ima-dark',
    label: 'ima Dark',
    scheme: 'dark',
    bg: IMA_PALETTE.dark.panel,
    fg: IMA_PALETTE.dark.ink,
    page: IMA_PALETTE.dark,
    load: async () => imaDark,
  },
  thirdParty({
    id: 'github-dark',
    label: 'GitHub Dark',
    scheme: 'dark',
    bg: '#0d1117',
    fg: '#c9d1d9',
    accent: '#58a6ff',
    load: async () => (await import('@uiw/codemirror-theme-github')).githubDark,
  }),
  thirdParty({
    id: 'solarized-dark',
    label: 'Solarized Dark',
    scheme: 'dark',
    bg: '#002b36',
    fg: '#839496',
    accent: '#268bd2',
    load: async () => (await import('@uiw/codemirror-theme-solarized')).solarizedDark,
  }),
  thirdParty({
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    scheme: 'dark',
    bg: '#282828',
    fg: '#ebdbb2',
    accent: '#83a598',
    load: async () => (await import('@uiw/codemirror-theme-gruvbox-dark')).gruvboxDark,
  }),
  thirdParty({
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    scheme: 'dark',
    bg: '#1e1e2e',
    fg: '#cdd6f4',
    accent: '#cba6f7',
    load: async () => (await import('@catppuccin/codemirror')).catppuccinMocha,
  }),
  thirdParty({
    id: 'tokyo-night',
    label: 'Tokyo Night',
    scheme: 'dark',
    bg: '#1a1b26',
    fg: '#787c99',
    accent: '#7aa2f7',
    load: async () => (await import('@uiw/codemirror-theme-tokyo-night')).tokyoNight,
  }),
  thirdParty({
    id: 'one-dark',
    label: 'One Dark',
    scheme: 'dark',
    bg: '#282c34',
    fg: '#abb2bf',
    accent: '#61afef',
    load: async () => (await import('@codemirror/theme-one-dark')).oneDark,
  }),
  thirdParty({
    id: 'dracula',
    label: 'Dracula',
    scheme: 'dark',
    bg: '#282a36',
    fg: '#f8f8f2',
    accent: '#bd93f9',
    load: async () => (await import('@uiw/codemirror-theme-dracula')).dracula,
  }),
]

export const DEFAULT_THEME: Record<Scheme, string> = { light: 'ima-light', dark: 'ima-dark' }

export function themeInfo(id: string): ThemeInfo | undefined {
  return THEMES.find((theme) => theme.id === id)
}

/** Rejects for unknown ids and when the theme's chunk cannot be fetched. */
export async function loadTheme(id: string): Promise<Extension> {
  const info = themeInfo(id)
  if (!info) throw new Error(`unknown theme: ${id}`)
  return info.load()
}

/** The ima theme of the same scheme, which is always bundled. */
export function fallbackTheme(id: string): { id: string; extension: Extension } {
  const scheme = themeInfo(id)?.scheme ?? 'light'
  return { id: DEFAULT_THEME[scheme], extension: scheme === 'dark' ? imaDark : imaLight }
}

/** Drawn around remote carets on dark themes; every participant colour reads on it. */
export const CARET_HALO = '#ffffff'

/**
 * What the reader's own settings control: text metrics through CSS variables,
 * so changing them needs no reconfiguration, and a halo that keeps other
 * people's carets visible on dark backgrounds.
 */
export const readerTheme: Extension = [
  Prec.highest(
    EditorView.theme({
      // --editor-font-floor keeps iOS from zooming in when the editor gets focus (style.css).
      '&': { fontSize: 'max(var(--editor-font-floor, 0px), var(--editor-font-size))' },
      '.cm-scroller': {
        fontFamily: 'var(--editor-font)',
        lineHeight: 'var(--editor-line-height)',
      },
    }),
  ),
  EditorView.baseTheme({
    '&dark .cm-ySelectionCaret': { boxShadow: `0 0 0 1px ${CARET_HALO}` },
    '&light': { colorScheme: 'light' },
    '&dark': { colorScheme: 'dark' },
  }),
]

/**
 * Swaps the editor theme. Themes load lazily, so a slow load must not
 * overwrite a newer choice.
 */
export class ThemeSwitcher {
  #id: string
  #seq = 0
  #view: EditorView
  #compartment: Compartment
  #load: (id: string) => Promise<Extension>

  constructor(
    view: EditorView,
    compartment: Compartment,
    id: string,
    load: (id: string) => Promise<Extension> = loadTheme,
  ) {
    this.#view = view
    this.#compartment = compartment
    this.#id = id
    this.#load = load
  }

  /** The theme the editor shows, or is about to. */
  get id(): string {
    return this.#id
  }

  /**
   * Resolves to false if the theme could not be loaded (for example, offline);
   * the editor then shows the ima theme of the same scheme.
   */
  async set(id: string): Promise<boolean> {
    const seq = ++this.#seq
    this.#id = id
    let extension: Extension
    let loaded = true
    try {
      extension = await this.#load(id)
    } catch {
      const fallback = fallbackTheme(id)
      extension = fallback.extension
      loaded = false
      if (seq === this.#seq) this.#id = fallback.id
    }
    // A newer choice may have been made while the theme was loading.
    if (seq !== this.#seq) return loaded
    this.#view.dispatch({ effects: this.#compartment.reconfigure(extension) })
    return loaded
  }
}

/** The page palette for a theme id; unknown ids get the ima palette of the scheme. */
export function pagePalette(id: string, scheme: Scheme): PagePalette {
  const info = themeInfo(id)
  return info?.scheme === scheme ? info.page : IMA_PALETTE[scheme]
}
