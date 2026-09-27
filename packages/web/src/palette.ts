import { composite, contrast, parseHex, type RGB } from './contrast.ts'
import { defaultStore, type Store } from './storage.ts'

export type Scheme = 'light' | 'dark'

/** The page colours style.css reads, one set per theme. */
export interface PagePalette {
  /** Behind the panels. */
  bg: string
  /** Header, preview, settings and cards; the same as the editor background. */
  panel: string
  ink: string
  muted: string
  line: string
  accent: string
  codeBg: string
  warnBg: string
  warnInk: string
}

/** The CSS custom property each palette entry sets. */
export const PALETTE_VARS: Record<keyof PagePalette, string> = {
  bg: '--bg',
  panel: '--panel',
  ink: '--ink',
  muted: '--muted',
  line: '--line',
  accent: '--accent',
  codeBg: '--code-bg',
  warnBg: '--warn-bg',
  warnInk: '--warn-ink',
}

/** Text on the page, including links and the text on accent buttons, needs 4.5:1 (WCAG 1.4.3). */
export const TEXT_CONTRAST = 4.5

const EXTREME: Record<Scheme, string> = { light: '#000000', dark: '#ffffff' }
const WARN = { hue: '#d9822b', ink: { light: '#8a4308', dark: '#f5c08a' } } as const

function toHex(rgb: number[]): string {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`
}

/** `a` moved towards `b` by `t` (0 to 1), in sRGB. */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a).rgb
  const y = parseHex(b).rgb
  return toHex(x.map((c, i) => c + ((y[i] ?? 0) - c) * t))
}

/**
 * `color` itself if it reads on every background, otherwise the least change
 * towards black or white that does. Backgrounds may depend on the colour, as
 * a tint of the text does.
 */
export function readable(
  color: string,
  backgrounds: (string | RGB)[] | ((c: string) => (string | RGB)[]),
  scheme: Scheme,
): string {
  for (let t = 0; t <= 1; t += 0.05) {
    const c = mix(color, EXTREME[scheme], t)
    const on = typeof backgrounds === 'function' ? backgrounds(c) : backgrounds
    if (on.every((bg) => contrast(c, bg) >= TEXT_CONTRAST)) return c
  }
  return EXTREME[scheme]
}

/** Inline code: the text colour at 10%. */
function codeBg(ink: string): string {
  return `${ink}1a`
}

/** The faintest step from ink towards the panel, up to 40%, that still reads. */
function mutedFor(ink: string, panel: string): string {
  for (let t = 0.4; t > 0; t -= 0.05) {
    const c = mix(ink, panel, t)
    if (contrast(c, panel) >= TEXT_CONTRAST) return c
  }
  return ink
}

/**
 * The page palette for an editor theme, built from its background, text and
 * one accent colour so the chrome and the preview match the editor. Text that
 * the theme draws too faint for the page is darkened or lightened until it reads.
 */
export function derivePalette(
  scheme: Scheme,
  colors: { bg: string; fg: string; accent: string },
): PagePalette {
  const panel = colors.bg
  const bg = mix(panel, '#000000', scheme === 'light' ? 0.035 : 0.3)
  // Text sits on the panels, on the page (inputs) and on its own tint (inline code).
  const ink = readable(colors.fg, (c) => [panel, bg, composite(codeBg(c), panel)], scheme)
  const warnBg = mix(panel, WARN.hue, 0.15)
  return {
    bg,
    panel,
    ink,
    muted: mutedFor(ink, panel),
    line: mix(panel, ink, 0.2),
    accent: readable(colors.accent, [panel], scheme),
    codeBg: codeBg(ink),
    warnBg,
    warnInk: readable(WARN.ink[scheme], [warnBg], scheme),
  }
}

/**
 * The root properties for one theme: its palette, and its scheme so form
 * controls and scrollbars match.
 */
export function themeVars(scheme: Scheme, page: PagePalette): Record<string, string> {
  const vars: Record<string, string> = { 'color-scheme': scheme }
  for (const [key, name] of Object.entries(PALETTE_VARS))
    vars[name] = page[key as keyof PagePalette]
  return vars
}

/**
 * The root properties while the page follows the OS: `light-dark()` picks the
 * palette by the OS scheme, so switching it needs no script.
 */
export function systemVars(light: PagePalette, dark: PagePalette): Record<string, string> {
  const vars: Record<string, string> = { 'color-scheme': 'light dark' }
  for (const [key, name] of Object.entries(PALETTE_VARS)) {
    const k = key as keyof PagePalette
    vars[name] = `light-dark(${light[k]}, ${dark[k]})`
  }
  return vars
}

/**
 * Stored next to the appearance so index.html can paint the page in these
 * colours before the theme registry has loaded. Keep its boot script in step
 * with the names and value forms here.
 */
export const PALETTE_KEY = 'ima:palette'

export function applyPalette(
  vars: Record<string, string>,
  root: HTMLElement = document.documentElement,
  store: Store | null = defaultStore(),
): void {
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value)
  try {
    store?.setItem(PALETTE_KEY, JSON.stringify(vars))
  } catch {
    // Private mode or storage disabled: the next visit starts in the default colours.
  }
}
