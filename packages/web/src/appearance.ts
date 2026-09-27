import { defaultStore, type Store } from './storage.ts'
import { DEFAULT_THEME, type Scheme, themeInfo } from './themes.ts'

/**
 * Stored as JSON under one key. index.html reads the same key before the first
 * paint, so keep its boot script in step with the shape and ranges here.
 */
export const APPEARANCE_KEY = 'ima:appearance'

export type Font = 'mono' | 'sans'

export interface Appearance {
  /** The page chrome. */
  page: 'system' | Scheme
  /** Which group of themes the editor shows; 'page' follows the chrome. */
  editor: 'page' | Scheme
  /** The last theme picked in each group. */
  light: string
  dark: string
  fontSize: number
  font: Font
  lineHeight: number
  wrap: boolean
}

export const FONT_SIZE = { min: 12, max: 24, step: 1 } as const
/** iOS zooms in on focused text under 16px; style.css keeps the editor at this size or more there. */
export const IOS_FONT_FLOOR = 16

/** The font sizes worth offering: on iOS, smaller ones would show at the floor anyway. */
export function fontSizeRange(ios: boolean): { min: number; max: number; step: number } {
  return { ...FONT_SIZE, min: ios ? IOS_FONT_FLOOR : FONT_SIZE.min }
}
export const LINE_HEIGHT = { min: 1.2, max: 2, step: 0.1 } as const

export const DEFAULT_APPEARANCE: Appearance = {
  page: 'system',
  editor: 'page',
  light: DEFAULT_THEME.light,
  dark: DEFAULT_THEME.dark,
  fontSize: 15,
  font: 'mono',
  lineHeight: 1.6,
  wrap: true,
}

function clamp(
  value: unknown,
  range: { min: number; max: number; step: number },
  fallback: number,
) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const stepped = Math.round(value / range.step) * range.step
  // Rounding to the step leaves float noise such as 1.7000000000000002.
  return Number(Math.min(range.max, Math.max(range.min, stepped)).toFixed(2))
}

function themeIn(scheme: Scheme, value: unknown): string {
  return typeof value === 'string' && themeInfo(value)?.scheme === scheme
    ? value
    : DEFAULT_THEME[scheme]
}

/** Keeps what is valid from stored JSON and fills in the rest. */
export function parseAppearance(raw: unknown): Appearance {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const d = DEFAULT_APPEARANCE
  return {
    page: a.page === 'light' || a.page === 'dark' ? a.page : d.page,
    editor: a.editor === 'light' || a.editor === 'dark' ? a.editor : d.editor,
    light: themeIn('light', a.light),
    dark: themeIn('dark', a.dark),
    fontSize: clamp(a.fontSize, FONT_SIZE, d.fontSize),
    font: a.font === 'sans' ? 'sans' : d.font,
    lineHeight: clamp(a.lineHeight, LINE_HEIGHT, d.lineHeight),
    wrap: typeof a.wrap === 'boolean' ? a.wrap : d.wrap,
  }
}

export function loadAppearance(store: Store | null = defaultStore()): Appearance {
  try {
    const raw = store?.getItem(APPEARANCE_KEY)
    return parseAppearance(raw ? JSON.parse(raw) : null)
  } catch {
    return { ...DEFAULT_APPEARANCE }
  }
}

export function saveAppearance(a: Appearance, store: Store | null = defaultStore()): void {
  try {
    store?.setItem(APPEARANCE_KEY, JSON.stringify(a))
  } catch {
    // Private mode or storage disabled: the choice lasts for this page only.
  }
}

export interface Resolved {
  page: Scheme
  editorScheme: Scheme
  editorTheme: string
}

export function resolveAppearance(a: Appearance, prefersDark: boolean): Resolved {
  const page = a.page === 'system' ? (prefersDark ? 'dark' : 'light') : a.page
  const editorScheme = a.editor === 'page' ? page : a.editor
  return { page, editorScheme, editorTheme: a[editorScheme] }
}

/**
 * Remembers a theme in its group. A theme of the page's scheme follows the
 * page from then on; one of the other scheme pins the editor to it, so what
 * was clicked is always what is shown.
 */
export function pickTheme(a: Appearance, id: string, prefersDark: boolean): Appearance {
  const scheme = themeInfo(id)?.scheme
  if (!scheme) return a
  const { page } = resolveAppearance(a, prefersDark)
  return { ...a, [scheme]: id, editor: scheme === page ? 'page' : scheme }
}

/** The page scheme is left to the OS unless the reader chose one. */
export function applyPage(a: Appearance, root: HTMLElement = document.documentElement): void {
  if (a.page === 'system') delete root.dataset.scheme
  else root.dataset.scheme = a.page
}

export function applyText(a: Appearance, root: HTMLElement = document.documentElement): void {
  root.style.setProperty('--editor-font-size', `${a.fontSize}px`)
  root.style.setProperty('--editor-font', a.font === 'sans' ? 'var(--sans)' : 'var(--mono)')
  root.style.setProperty('--editor-line-height', String(a.lineHeight))
}
