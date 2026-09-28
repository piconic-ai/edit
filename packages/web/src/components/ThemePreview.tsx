'use client'

import type { ThemeInfo } from '../themes.ts'

function colors(theme: ThemeInfo): string {
  const p = theme.page
  return `--tp-bg: ${p.bg}; --tp-panel: ${p.panel}; --tp-ink: ${p.ink}; --tp-muted: ${p.muted}; --tp-line: ${p.line}; --tp-accent: ${p.accent}; --tp-code: ${p.codeBg}`
}

/**
 * A miniature of the page in a theme: a header bar, then a heading, a line of
 * text with a link and a code span, drawn from the theme's own colours so it
 * needs no theme chunk. Decorative; the card's label names the theme.
 */
export function ThemePreview(props: { theme: ThemeInfo }) {
  // Read in the JSX, so the preview follows a theme that changes (the settings row).
  return (
    <span className="theme-preview" aria-hidden="true" style={colors(props.theme)}>
      <span className="tp-header">
        <span className="tp-dot" />
        <span className="tp-dot" />
        <span className="tp-dot" />
      </span>
      <span className="tp-body">
        <span className="tp-heading">Aa</span>
        <span className="tp-line">
          <span className="tp-text" />
          <span className="tp-link" />
        </span>
        <span className="tp-line">
          <span className="tp-muted" />
          <span className="tp-code" />
        </span>
      </span>
    </span>
  )
}
