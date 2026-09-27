import { describe, expect, it } from 'vitest'
import { embedFor, httpUrl, isAllowedFrame } from '../src/embed.ts'

describe('httpUrl', () => {
  it.each([
    ['https://example.com/a.png', true],
    ['http://example.com/a.png', true],
    ['images/a.png', false],
    ['/images/a.png', false],
    ['../a.png', false],
    ['file:///etc/passwd', false],
    ['javascript:alert(1)', false],
    ['data:image/png;base64,AAAA', false],
  ])('%s -> %s', (href, ok) => {
    expect(httpUrl(href) !== null).toBe(ok)
  })
})

describe('embedFor', () => {
  const yt = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', yt],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ&list=x', yt],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', yt],
    ['https://youtu.be/dQw4w9WgXcQ', yt],
    ['https://youtu.be/dQw4w9WgXcQ?t=90', `${yt}?start=90`],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s', `${yt}?start=90`],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', yt],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', yt],
    ['https://vimeo.com/76979871', 'https://player.vimeo.com/video/76979871'],
    ['https://vimeo.com/76979871/abc123', 'https://player.vimeo.com/video/76979871?h=abc123'],
    [
      'https://player.vimeo.com/video/76979871?h=abc123',
      'https://player.vimeo.com/video/76979871?h=abc123',
    ],
  ])('frames %s', (href, src) => {
    expect(embedFor(href)).toEqual({ kind: 'frame', src, title: expect.any(String) })
  })

  it.each([
    'https://example.com/clip.mp4',
    'https://example.com/clip.WEBM?token=1',
    'http://example.com/clip.mov',
  ])('plays video file %s', (href) => {
    expect(embedFor(href)).toEqual({ kind: 'video', src: new URL(href).href })
  })

  it.each([
    'https://example.com/',
    'https://www.youtube.com/',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ"onload="x',
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://vimeo.com/channels/staffpicks',
    'clip.mp4',
    'javascript:alert(1)//.mp4',
  ])('ignores %s', (href) => {
    expect(embedFor(href)).toBeNull()
  })
})

describe('isAllowedFrame', () => {
  it('allows only the known players', () => {
    expect(isAllowedFrame('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBe(true)
    expect(isAllowedFrame('https://player.vimeo.com/video/1')).toBe(true)
    expect(isAllowedFrame('https://evil.example/embed/')).toBe(false)
    expect(isAllowedFrame('https://player.vimeo.com.evil.example/video/1')).toBe(false)
    expect(isAllowedFrame(null)).toBe(false)
  })
})
