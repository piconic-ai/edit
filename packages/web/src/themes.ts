import type { Compartment, Extension } from '@codemirror/state'
import { Prec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { githubDark, githubLight } from '@uiw/codemirror-theme-github'
import { derivePalette, type PagePalette, type Scheme } from './palette.ts'

export type { Scheme }

export interface ThemeInfo {
  id: string
  label: string
  scheme: Scheme
  /** The editor background and text colours, for previews and the contrast test. */
  bg: string
  fg: string
  /** The colours of the rest of the page, so it matches the editor. */
  page: PagePalette
  load(): Promise<Extension>
}

/**
 * A registry entry. Its page palette comes from its colours and one accent of
 * its own, with any colours the theme's authors publish for the rest of a page.
 */
function withPage(
  info: Omit<ThemeInfo, 'page'> & { accent: string; page?: Partial<PagePalette> },
): ThemeInfo {
  const { accent, page, ...rest } = info
  const derived = derivePalette(info.scheme, { bg: info.bg, fg: info.fg, accent })
  return { ...rest, page: { ...derived, ...page } }
}

export const THEMES: readonly ThemeInfo[] = [
  withPage({
    id: 'github-light',
    label: 'GitHub Light',
    scheme: 'light',
    bg: '#ffffff',
    fg: '#24292e',
    accent: '#0969da',
    // Primer, GitHub's design system, the same source as the preview's Markdown styles.
    page: { bg: '#f6f8fa', muted: '#656d76', line: '#d0d7de', codeBg: '#afb8c133' },
    load: async () => githubLight,
  }),
  withPage({
    id: 'solarized-light',
    label: 'Solarized Light',
    scheme: 'light',
    bg: '#fdf6e3',
    fg: '#657b83',
    accent: '#268bd2',
    load: async () => (await import('@uiw/codemirror-theme-solarized')).solarizedLight,
  }),
  withPage({
    id: 'gruvbox-light',
    label: 'Gruvbox Light',
    scheme: 'light',
    bg: '#fbf1c7',
    fg: '#3c3836',
    accent: '#076678',
    load: async () => (await import('@uiw/codemirror-theme-gruvbox-dark')).gruvboxLight,
  }),
  withPage({
    id: 'catppuccin-latte',
    label: 'Catppuccin Latte',
    scheme: 'light',
    bg: '#eff1f5',
    fg: '#4c4f69',
    accent: '#8839ef',
    load: async () => (await import('@catppuccin/codemirror')).catppuccinLatte,
  }),
  withPage({
    id: 'tokyo-night-day',
    label: 'Tokyo Night Day',
    scheme: 'light',
    bg: '#e1e2e7',
    fg: '#3760bf',
    accent: '#2e7de9',
    load: async () => (await import('@uiw/codemirror-theme-tokyo-night-day')).tokyoNightDay,
  }),
  withPage({
    id: 'github-dark',
    label: 'GitHub Dark',
    scheme: 'dark',
    bg: '#0d1117',
    fg: '#c9d1d9',
    accent: '#58a6ff',
    page: { bg: '#010409', muted: '#8b949e', line: '#30363d', codeBg: '#6e768166' },
    load: async () => githubDark,
  }),
  withPage({
    id: 'solarized-dark',
    label: 'Solarized Dark',
    scheme: 'dark',
    bg: '#002b36',
    fg: '#839496',
    accent: '#268bd2',
    load: async () => (await import('@uiw/codemirror-theme-solarized')).solarizedDark,
  }),
  withPage({
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    scheme: 'dark',
    bg: '#282828',
    fg: '#ebdbb2',
    accent: '#83a598',
    load: async () => (await import('@uiw/codemirror-theme-gruvbox-dark')).gruvboxDark,
  }),
  withPage({
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    scheme: 'dark',
    bg: '#1e1e2e',
    fg: '#cdd6f4',
    accent: '#cba6f7',
    load: async () => (await import('@catppuccin/codemirror')).catppuccinMocha,
  }),
  withPage({
    id: 'tokyo-night',
    label: 'Tokyo Night',
    scheme: 'dark',
    bg: '#1a1b26',
    fg: '#787c99',
    accent: '#7aa2f7',
    load: async () => (await import('@uiw/codemirror-theme-tokyo-night')).tokyoNight,
  }),
  withPage({
    id: 'one-dark',
    label: 'One Dark',
    scheme: 'dark',
    bg: '#282c34',
    fg: '#abb2bf',
    accent: '#61afef',
    load: async () => (await import('@codemirror/theme-one-dark')).oneDark,
  }),
  withPage({
    id: 'dracula',
    label: 'Dracula',
    scheme: 'dark',
    bg: '#282a36',
    fg: '#f8f8f2',
    accent: '#bd93f9',
    load: async () => (await import('@uiw/codemirror-theme-dracula')).dracula,
  }),
]

/** Shown until the reader picks a theme, following the OS; always bundled. */
export const DEFAULT_THEME: Record<Scheme, string> = { light: 'github-light', dark: 'github-dark' }

export function themeInfo(id: string): ThemeInfo | undefined {
  return THEMES.find((theme) => theme.id === id)
}

/** Rejects for unknown ids and when the theme's chunk cannot be fetched. */
export async function loadTheme(id: string): Promise<Extension> {
  const info = themeInfo(id)
  if (!info) throw new Error(`unknown theme: ${id}`)
  return info.load()
}

/** The default theme of the same scheme, which is always bundled. */
export function fallbackTheme(id: string): { id: string; extension: Extension } {
  const scheme = themeInfo(id)?.scheme ?? 'light'
  return { id: DEFAULT_THEME[scheme], extension: scheme === 'dark' ? githubDark : githubLight }
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
   * the editor then shows the default theme of the same scheme.
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

/** The registry entry for an id, or the default of the scheme for unknown ids. */
export function themeOrDefault(id: string | null, scheme: Scheme): ThemeInfo {
  return (id && themeInfo(id)) || (themeInfo(DEFAULT_THEME[scheme]) as ThemeInfo)
}
