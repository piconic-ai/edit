'use client'

import { MAX_RATIO, MIN_RATIO, type Splitter } from '../splitter.ts'

/**
 * The divider between the editor and the preview in Split. Drag it, use the
 * arrow keys, or double-click to go back to half and half (splitter.ts).
 */
export function SplitterBar(props: { splitter: Splitter }) {
  const s = props.splitter
  const percent = () => s.percent.get()

  return (
    <div
      className="splitter"
      role="separator"
      tabindex={0}
      aria-orientation="vertical"
      aria-label="Resize the editor and preview"
      aria-valuemin={String(MIN_RATIO * 100)}
      aria-valuemax={String(MAX_RATIO * 100)}
      aria-valuenow={String(percent())}
      onPointerDown={(e) => s.onPointerDown(e)}
      onPointerMove={(e) => s.onPointerMove(e)}
      onPointerUp={() => s.onPointerEnd()}
      onDoubleClick={() => s.reset()}
      onKeyDown={(e) => s.onKey(e)}
      // onPointerCancel is not in @barefootjs/jsx's types.
      ref={(el) => el.addEventListener('pointercancel', () => s.onPointerEnd())}
    />
  )
}
