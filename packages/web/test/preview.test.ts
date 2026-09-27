// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { patch, render, sanitize } from '../src/preview.ts'

function html(source: string): string {
  const div = document.createElement('div')
  div.append(render(source))
  return div.innerHTML
}

function dom(source: string): HTMLElement {
  const div = document.createElement('div')
  div.append(render(source))
  return div
}

describe('sanitize', () => {
  it('strips scripts and event handlers', () => {
    const div = document.createElement('div')
    div.append(
      sanitize(
        '<p onclick="alert(1)">hi</p><script>alert(1)</script><img src="https://x.test/a.png" onerror="alert(1)">' +
          '<a href="javascript:alert(1)">x</a><svg onload="alert(1)"></svg><style>*{}</style>',
      ),
    )
    const out = div.innerHTML
    expect(out).not.toMatch(/script|onclick|onerror|onload|javascript:|<style/i)
    expect(div.querySelector('p')?.textContent).toBe('hi')
    expect(div.querySelector('img')?.getAttribute('src')).toBe('https://x.test/a.png')
  })

  it('drops iframes that are not a known player', () => {
    const div = document.createElement('div')
    div.append(
      sanitize(
        '<iframe src="https://evil.example/"></iframe>' +
          '<iframe srcdoc="<script>alert(1)</script>"></iframe>' +
          '<iframe src="https://player.vimeo.com/video/1"></iframe>',
      ),
    )
    const frames = [...div.querySelectorAll('iframe')]
    expect(frames.map((f) => f.getAttribute('src'))).toEqual(['https://player.vimeo.com/video/1'])
    expect(frames[0]?.hasAttribute('srcdoc')).toBe(false)
  })

  it('drops media that does not come from an absolute http(s) URL', () => {
    const div = document.createElement('div')
    div.append(sanitize('<img src="data:image/png;base64,AAAA"><video src="clip.mp4"></video>'))
    expect(div.innerHTML).toBe('')
  })
})

describe('render', () => {
  it('shows raw HTML in the document as text', () => {
    const out = dom('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
    expect(out.querySelector('script, img')).toBeNull()
    expect(out.textContent).toContain('<script>alert(1)</script>')
  })

  it('renders absolute images and falls back to the alt text for relative ones', () => {
    const out = dom('![cat](https://example.com/cat.png) ![dog](images/dog.png) ![](../x.png)')
    const img = out.querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://example.com/cat.png')
    expect(img?.getAttribute('alt')).toBe('cat')
    expect(img?.getAttribute('loading')).toBe('lazy')
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer')
    const missing = [...out.querySelectorAll('.missing-image')].map((m) => m.textContent)
    expect(missing).toEqual(['dog', '../x.png'])
  })

  it('plays video files from images and bare URLs', () => {
    const out = dom('![demo](https://example.com/demo.mp4)\n\nhttps://example.com/other.webm')
    const videos = [...out.querySelectorAll('video')]
    expect(videos.map((v) => v.getAttribute('src'))).toEqual([
      'https://example.com/demo.mp4',
      'https://example.com/other.webm',
    ])
    expect(videos[0]?.hasAttribute('controls')).toBe(true)
    expect(videos[0]?.getAttribute('aria-label')).toBe('demo')
  })

  it('embeds bare YouTube and Vimeo URLs', () => {
    const out = dom(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ\n\n<https://vimeo.com/76979871>\n\n- https://youtu.be/dQw4w9WgXcQ',
    )
    const frames = [...out.querySelectorAll('.embed iframe')]
    expect(frames.map((f) => f.getAttribute('src'))).toEqual([
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      'https://player.vimeo.com/video/76979871',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ])
    expect(frames[0]?.getAttribute('sandbox')).toContain('allow-scripts')
    expect(out.querySelector('p')).toBeNull()
  })

  it('keeps video URLs inside a sentence or with link text as links', () => {
    const out = dom(
      'Watch https://youtu.be/dQw4w9WgXcQ now\n\n[the talk](https://youtu.be/dQw4w9WgXcQ)',
    )
    expect(out.querySelector('iframe')).toBeNull()
    expect(out.querySelectorAll('a[href]')).toHaveLength(2)
  })

  it('opens absolute links in a new tab and disarms the rest', () => {
    const out = dom(
      '[web](https://example.com) [mail](mailto:a@example.com) [file](other.md) [top](#top) [js](javascript:alert(1))',
    )
    const links = [...out.querySelectorAll('a')]
    expect(
      links.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target')]),
    ).toEqual([
      ['web', 'https://example.com', '_blank'],
      ['mail', 'mailto:a@example.com', '_blank'],
      ['file', null, null],
      ['top', null, null],
    ])
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(out.textContent).toContain('[js](javascript:alert(1))')
  })

  it('tags blocks with their source line', () => {
    const out = dom(
      '# Title\n\ntext\n\n- a\n- b\n\n```\ncode\n```\n\nhttps://youtu.be/dQw4w9WgXcQ\n',
    )
    const lines = [...out.querySelectorAll('[data-line]')].map((el) => [
      el.tagName,
      el.getAttribute('data-line'),
    ])
    expect(lines).toEqual([
      ['H1', '0'],
      ['P', '2'],
      ['UL', '4'],
      ['LI', '4'],
      ['LI', '5'],
      ['CODE', '7'],
      ['DIV', '11'],
    ])
  })
})

describe('patch', () => {
  it('keeps unchanged blocks in place and updates their lines', () => {
    const container = document.createElement('div')
    patch(container, render('# A\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nold\n\nend\n'))
    const [title, embed] = [container.querySelector('h1'), container.querySelector('.embed')]
    const end = container.lastElementChild

    patch(container, render('# A\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nnew\nlines\n\nend\n'))
    expect(container.querySelector('h1')).toBe(title)
    expect(container.querySelector('.embed')).toBe(embed)
    expect(container.lastElementChild).toBe(end)
    expect(end?.getAttribute('data-line')).toBe('7')
    expect(container.textContent).toContain('new\nlines')
    expect(container.textContent).not.toContain('old')
    expect(html('# A\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nnew\nlines\n\nend\n')).toBe(
      container.innerHTML,
    )
  })

  it('handles inserting at the start and removing everything', () => {
    const container = document.createElement('div')
    patch(container, render('a\n\nb\n'))
    const b = container.lastElementChild
    patch(container, render('z\n\na\n\nb\n'))
    expect(container.lastElementChild).toBe(b)
    expect(container.innerHTML).toBe(html('z\n\na\n\nb\n'))
    patch(container, render(''))
    expect(container.innerHTML).toBe('')
  })
})
