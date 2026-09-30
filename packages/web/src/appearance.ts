import { systemVars, themeVars } from './palette.ts'
import { defaultStore, type Store } from './storage.ts'
import { DEFAULT_THEME, type Scheme, themeInfo, themeOrDefault } from './themes.ts'

/**
 * Stored as JSON under one key. index.html reads the same key before the first
 * paint, so keep its boot script in step with the shape and ranges here.
 */
export const APPEARANCE_KEY = 'pedit:appearance'

export interface Appearance {
  /**
   * The theme of the page and the editor. Null until the reader picks one:
   * the default theme of the OS scheme then shows, following the OS. Picking
   * is one-way by design; the settings offer themes only, not "follow the OS".
   */
  theme: string | null
  fontSize: number
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
  theme: null,
  fontSize: 15,
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

const isScheme = (v: unknown): v is Scheme => v === 'light' || v === 'dark'

/** Themes that were removed, and what readers who picked them see now. */
const RENAMED: Record<string, string> = {
  'pedit-light': 'github-light',
  'pedit-dark': 'github-dark',
}

/**
 * Earlier versions stored a scheme ('system', 'light' or 'dark'), an optional
 * editor pin and a theme per scheme. Readers keep seeing the theme they saw;
 * the defaults under 'system' keep following the OS.
 */
function legacyTheme(a: Record<string, unknown>, prefersDark: boolean): string | null {
  const pinned = isScheme(a.editor) ? a.editor : isScheme(a.page) ? a.page : null
  const scheme = pinned ?? (prefersDark ? 'dark' : 'light')
  const raw = a[scheme]
  const id = typeof raw === 'string' ? (RENAMED[raw] ?? raw) : null
  if (!id || themeInfo(id)?.scheme !== scheme) return null
  return pinned || id !== DEFAULT_THEME[scheme] ? id : null
}

/** Keeps what is valid from stored JSON and fills in the rest. */
export function parseAppearance(raw: unknown, prefersDark = false): Appearance {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const d = DEFAULT_APPEARANCE
  const theme =
    'theme' in a
      ? typeof a.theme === 'string' && themeInfo(a.theme)
        ? a.theme
        : null
      : legacyTheme(a, prefersDark)
  return {
    theme,
    fontSize: clamp(a.fontSize, FONT_SIZE, d.fontSize),
    lineHeight: clamp(a.lineHeight, LINE_HEIGHT, d.lineHeight),
    wrap: typeof a.wrap === 'boolean' ? a.wrap : d.wrap,
  }
}

export function loadAppearance(
  store: Store | null = defaultStore(),
  prefersDark = false,
): Appearance {
  try {
    const raw = store?.getItem(APPEARANCE_KEY)
    return parseAppearance(raw ? JSON.parse(raw) : null, prefersDark)
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

/** The theme to show: the reader's pick, or the default of the OS scheme. */
export function resolveTheme(a: Appearance, prefersDark: boolean): string {
  return a.theme ?? DEFAULT_THEME[prefersDark ? 'dark' : 'light']
}

export function applyText(a: Appearance, root: HTMLElement = document.documentElement): void {
  root.style.setProperty('--editor-font-size', `${a.fontSize}px`)
  root.style.setProperty('--editor-line-height', String(a.lineHeight))
}

/**
 * The root properties that colour the page. `shown` is the theme the editor
 * ended up with; it differs from the pick when that could not load, and the
 * page then matches the fallback rather than the pick.
 */
export function pageColors(a: Appearance, shown?: string): Record<string, string> {
  if (a.theme === null) {
    return systemVars(themeOrDefault(null, 'light').page, themeOrDefault(null, 'dark').page)
  }
  const theme = themeOrDefault(shown ?? a.theme, 'light')
  return themeVars(theme.scheme, theme.page)
}
