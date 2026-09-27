/** The parts of `window.visualViewport` this module reads. */
export interface VisualViewportLike extends EventTarget {
  height: number
  offsetTop: number
  scale: number
}

export interface Box {
  height: number
  top: number
}

/**
 * Where the page should sit so nothing hides behind the on-screen keyboard.
 * iOS Safari keeps the layout viewport when the keyboard opens and only
 * shrinks the visual one, so `100dvh` still reaches under the keyboard.
 * Pinch zoom also shrinks the visual viewport; then the page keeps its size
 * and the reader pans, so this returns null.
 */
export function viewportBox(
  vv: Pick<VisualViewportLike, 'height' | 'offsetTop' | 'scale'>,
): Box | null {
  if (!(vv.height > 0) || Math.abs(vv.scale - 1) > 0.01) return null
  return { height: vv.height, top: Math.max(0, vv.offsetTop) }
}

/**
 * Keeps `--app-height` and `--app-top` on the root in step with the visual
 * viewport, and calls onResize when the height changes (the keyboard opened
 * or closed) so the caller can bring the cursor back into view. Panning only
 * moves the page: iOS pans while the reader scrolls, and pulling them back to
 * the cursor then would fight them. Returns a function that stops tracking.
 */
export function trackViewport(
  root: HTMLElement,
  vv: VisualViewportLike | null | undefined,
  onResize: () => void = () => {},
): () => void {
  if (!vv) return () => {}
  // Undefined until the first update, which always applies; null while pinch-zoomed.
  let lastHeight: number | null | undefined
  let lastTop: number | null | undefined
  const update = () => {
    const box = viewportBox(vv)
    const height = box?.height ?? null
    const top = box?.top ?? null
    if (height === lastHeight && top === lastTop) return
    const resized = height !== lastHeight
    lastHeight = height
    lastTop = top
    if (box) {
      root.style.setProperty('--app-height', `${box.height}px`)
      root.style.setProperty('--app-top', `${box.top}px`)
    } else {
      root.style.removeProperty('--app-height')
      root.style.removeProperty('--app-top')
    }
    if (resized) onResize()
  }
  update()
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  return () => {
    vv.removeEventListener('resize', update)
    vv.removeEventListener('scroll', update)
  }
}
