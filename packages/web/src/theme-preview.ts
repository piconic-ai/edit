import { h } from './dom.ts'
import type { ThemeInfo } from './themes.ts'

/**
 * A miniature of the page in a theme: a header bar, then a heading, a line of
 * text with a link and a code span, drawn from the theme's own colours so it
 * needs no theme chunk. Decorative; the card's label names the theme.
 */
export function themePreview(theme: ThemeInfo): HTMLElement {
  const bar = (className: string) => h('span', { className })
  const el = h('span', { className: 'theme-preview' }, [
    h('span', { className: 'tp-header' }, [bar('tp-dot'), bar('tp-dot'), bar('tp-dot')]),
    h('span', { className: 'tp-body' }, [
      h('span', { className: 'tp-heading', textContent: 'Aa' }),
      h('span', { className: 'tp-line' }, [bar('tp-text'), bar('tp-link')]),
      h('span', { className: 'tp-line' }, [bar('tp-muted'), bar('tp-code')]),
    ]),
  ])
  el.setAttribute('aria-hidden', 'true')
  const p = theme.page
  for (const [name, value] of Object.entries({
    '--tp-bg': p.bg,
    '--tp-panel': p.panel,
    '--tp-ink': p.ink,
    '--tp-muted': p.muted,
    '--tp-line': p.line,
    '--tp-accent': p.accent,
    '--tp-code': p.codeBg,
  })) {
    el.style.setProperty(name, value)
  }
  return el
}
