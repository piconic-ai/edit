// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import html from '../index.html?raw'

function favicon(): Document {
  const page = new DOMParser().parseFromString(html, 'text/html')
  const href = page.querySelector('link[rel="icon"]')?.getAttribute('href') ?? ''
  const prefix = 'data:image/svg+xml,'
  expect(href.startsWith(prefix)).toBe(true)
  return new DOMParser().parseFromString(decodeURIComponent(href.slice(prefix.length)), 'image/svg+xml')
}

describe('favicon', () => {
  it('is a well-formed inline SVG', () => {
    const svg = favicon()
    expect(svg.querySelector('parsererror')).toBeNull()
    expect(svg.documentElement.tagName).toBe('svg')
  })

  it('draws two carets in piconic green, like the other piconic products', () => {
    const svg = favicon()
    expect(svg.querySelector('g')?.getAttribute('fill')).toBe('#00b769')
    expect(svg.querySelectorAll('circle')).toHaveLength(2)
    expect(svg.querySelectorAll('rect')).toHaveLength(2)
    expect(svg.querySelector('text')).toBeNull()
  })
})
