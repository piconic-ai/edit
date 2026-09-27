// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { trackViewport, viewportBox } from '../src/viewport.ts'

class FakeViewport extends EventTarget {
  height = 800
  offsetTop = 0
  scale = 1

  move(next: Partial<Pick<FakeViewport, 'height' | 'offsetTop' | 'scale'>>, type = 'resize') {
    Object.assign(this, next)
    this.dispatchEvent(new Event(type))
  }
}

function vars(root: HTMLElement) {
  return {
    height: root.style.getPropertyValue('--app-height'),
    top: root.style.getPropertyValue('--app-top'),
  }
}

describe('viewportBox', () => {
  it('follows the visual viewport at normal zoom', () => {
    expect(viewportBox({ height: 420, offsetTop: 280, scale: 1 })).toEqual({
      height: 420,
      top: 280,
    })
  })

  it('leaves the page alone while the reader has pinch-zoomed', () => {
    expect(viewportBox({ height: 300, offsetTop: 120, scale: 2 })).toBeNull()
  })

  it('ignores an empty viewport and a negative offset from rubber-band scrolling', () => {
    expect(viewportBox({ height: 0, offsetTop: 0, scale: 1 })).toBeNull()
    expect(viewportBox({ height: 500, offsetTop: -12, scale: 1 })).toEqual({ height: 500, top: 0 })
  })
})

describe('trackViewport', () => {
  it('sets the page box at once and whenever the keyboard opens or closes', () => {
    const root = document.createElement('div')
    const vv = new FakeViewport()
    const onResize = vi.fn()
    trackViewport(root, vv, onResize)
    expect(vars(root)).toEqual({ height: '800px', top: '0px' })

    vv.move({ height: 440, offsetTop: 300 })
    expect(vars(root)).toEqual({ height: '440px', top: '300px' })
    vv.move({ offsetTop: 250 }, 'scroll')
    expect(vars(root)).toEqual({ height: '440px', top: '250px' })
    vv.move({ height: 800, offsetTop: 0 })
    expect(vars(root)).toEqual({ height: '800px', top: '0px' })
    // Once at start, then when the keyboard opened and closed; not for the pan.
    expect(onResize).toHaveBeenCalledTimes(3)
  })

  it('moves the page but leaves the cursor alone while the reader pans', () => {
    const root = document.createElement('div')
    const vv = new FakeViewport()
    vv.move({ height: 440, offsetTop: 300 })
    const onResize = vi.fn()
    trackViewport(root, vv, onResize)
    onResize.mockClear()
    for (const offsetTop of [280, 200, 120]) vv.move({ offsetTop }, 'scroll')
    expect(vars(root).top).toBe('120px')
    expect(onResize).not.toHaveBeenCalled()
  })

  it('does not call back when nothing moved', () => {
    const root = document.createElement('div')
    const vv = new FakeViewport()
    const onResize = vi.fn()
    trackViewport(root, vv, onResize)
    vv.move({}, 'scroll')
    vv.move({})
    expect(onResize).toHaveBeenCalledTimes(1)
  })

  it('falls back to the CSS default during pinch zoom', () => {
    const root = document.createElement('div')
    const vv = new FakeViewport()
    trackViewport(root, vv)
    vv.move({ height: 400, scale: 2 })
    expect(vars(root)).toEqual({ height: '', top: '' })
    vv.move({ height: 800, scale: 1 })
    expect(vars(root)).toEqual({ height: '800px', top: '0px' })
  })

  it('stops when disposed, and does nothing without a visual viewport', () => {
    const root = document.createElement('div')
    const vv = new FakeViewport()
    const stop = trackViewport(root, vv)
    stop()
    vv.move({ height: 300 })
    expect(vars(root).height).toBe('800px')
    expect(() => trackViewport(root, null)()).not.toThrow()
  })
})
