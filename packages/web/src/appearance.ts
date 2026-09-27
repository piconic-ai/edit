import { paletteVars } from './palette.ts'
import { defaultStore, type Store } from './storage.ts'
import { DEFAULT_THEME, pagePalette, type Scheme, themeInfo } from './themes.ts'

/**
 * Stored as JSON under one key. index.html reads the same key before the first
 * paint, so keep its boot script in step with the shape and ranges here.
 */
export const APPEARANCE_KEY = 'ima:appearance'

export type Font = 'mono' | 'sans'

export interface Appearance {
  /** Which group of themes the page and the editor show. */
  page: 'system' | Scheme
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
  const isScheme = (v: unknown): v is Scheme => v === 'light' || v === 'dark'
  return {
    // Earlier versions could pin the editor to the other scheme; the page now shows what it showed.
    page: isScheme(a.editor) ? a.editor : isScheme(a.page) ? a.page : d.page,
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
  scheme: Scheme
  theme: string
}

export function resolveAppearance(a: Appearance, prefersDark: boolean): Resolved {
  const scheme = a.page === 'system' ? (prefersDark ? 'dark' : 'light') : a.page
  return { scheme, theme: a[scheme] }
}

/**
 * Remembers a theme in its group. Picking one of the other scheme switches the
 * page to that scheme, so what was clicked is always what is shown; one of the
 * current scheme leaves the page setting, and so following the OS, alone.
 */
export function pickTheme(a: Appearance, id: string, prefersDark: boolean): Appearance {
  const scheme = themeInfo(id)?.scheme
  if (!scheme) return a
  const current = resolveAppearance(a, prefersDark).scheme
  return { ...a, [scheme]: id, page: scheme === current ? a.page : scheme }
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

/**
 * The page colours for the theme of each group. `shown` is the theme the
 * editor ended up with; it differs from the pick when that could not load, and
 * the page then matches the fallback rather than the pick.
 */
export function pageColors(a: Appearance, shown?: string): Record<string, string> {
  const ids: Record<Scheme, string> = { light: a.light, dark: a.dark }
  const scheme = shown ? themeInfo(shown)?.scheme : undefined
  if (shown && scheme) ids[scheme] = shown
  return paletteVars(pagePalette(ids.light, 'light'), pagePalette(ids.dark, 'dark'))
}
