/** WCAG relative luminance and contrast, for checking theme colours in tests. */

export type RGB = [number, number, number]

/** Parses `#rgb`, `#rrggbb` or `#rrggbbaa`. */
export function parseHex(hex: string): { rgb: RGB; alpha: number } {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex)
  if (!m?.[1]) throw new Error(`not a hex colour: ${hex}`)
  const digits = m[1].length === 3 ? [...m[1]].map((d) => d + d).join('') : m[1]
  const n = (i: number) => Number.parseInt(digits.slice(i, i + 2), 16)
  return { rgb: [n(0), n(2), n(4)], alpha: digits.length === 8 ? n(6) / 255 : 1 }
}

/** The colour seen when `top` (possibly translucent) is painted over opaque `bottom`. */
export function composite(top: string, bottom: string): RGB {
  const { rgb, alpha } = parseHex(top)
  const under = parseHex(bottom).rgb
  return rgb.map((c, i) => c * alpha + (under[i] ?? 0) * (1 - alpha)) as RGB
}

export function luminance([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrast(a: RGB | string, b: RGB | string): number {
  const la = luminance(typeof a === 'string' ? parseHex(a).rgb : a)
  const lb = luminance(typeof b === 'string' ? parseHex(b).rgb : b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
