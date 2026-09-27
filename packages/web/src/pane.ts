import type { EditorView } from '@codemirror/view'
import type * as Y from 'yjs'
import { h } from './dom.ts'

type Renderer = Pick<typeof import('./preview.ts'), 'render' | 'patch'>

/** A source line and where its block starts in the preview's scroll area. */
export interface Anchor {
  line: number
  top: number
}

/**
 * Where to scroll the preview so it shows the same place as the editor,
 * given anchors sorted by line and by position. Between two anchors the
 * position is interpolated, so long paragraphs scroll smoothly.
 */
export function scrollTarget(anchors: readonly Anchor[], line: number): number {
  let prev: Anchor = { line: 0, top: 0 }
  for (const next of anchors) {
    if (next.line > line) {
      if (next.line === prev.line) return prev.top
      return prev.top + ((next.top - prev.top) * (line - prev.line)) / (next.line - prev.line)
    }
    prev = next
  }
  return prev.top
}

/** Keeps anchors whose line and position both move forward, e.g. a list but not its first item. */
export function monotonic(anchors: readonly Anchor[]): Anchor[] {
  const out: Anchor[] = []
  for (const a of anchors) {
    const last = out.at(-1)
    if (!last || (a.line > last.line && a.top >= last.top)) out.push(a)
  }
  return out
}

/** The editor's first visible line, 0-based, with the fraction of it scrolled past. */
export function topLine(view: EditorView): number {
  const height = Math.max(0, view.scrollDOM.scrollTop - view.documentPadding.top)
  const block = view.lineBlockAtHeight(height)
  const line = view.state.doc.lineAt(block.from).number - 1
  const fraction = block.height > 0 ? (height - block.top) / block.height : 0
  return line + Math.min(1, Math.max(0, fraction))
}

/**
 * The rendered Markdown next to the editor. It loads the renderer on first
 * use and redraws at most once a frame, only while it is on screen.
 */
export class PreviewPane {
  readonly element: HTMLElement
  #text: Y.Text
  #load: () => Promise<Renderer>
  #renderer: Renderer | null = null
  #loading: Promise<Renderer> | null = null
  #active = false
  #dirty = true
  #frame = 0
  #onRender: () => void

  constructor(
    text: Y.Text,
    options: { load?: () => Promise<Renderer>; onRender?: () => void } = {},
  ) {
    this.#text = text
    this.#load = options.load ?? (() => import('./preview.ts'))
    this.#onRender = options.onRender ?? (() => {})
    this.element = h('article', { className: 'preview', ariaLabel: 'Preview' })
    text.observe(() => {
      this.#dirty = true
      this.#schedule()
    })
  }

  get active(): boolean {
    return this.#active
  }

  set active(on: boolean) {
    this.#active = on
    this.#schedule()
  }

  /** Scrolls to the place the editor shows. */
  follow(view: EditorView): void {
    const pane = this.element
    const scroller = view.scrollDOM
    // A document that fits the editor leaves the preview for the reader to scroll.
    if (scroller.scrollHeight <= scroller.clientHeight) return
    const max = pane.scrollHeight - pane.clientHeight
    if (
      scroller.scrollTop > 0 &&
      scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1
    ) {
      pane.scrollTop = max
      return
    }
    const origin = pane.getBoundingClientRect().top - pane.scrollTop
    const anchors = [...pane.querySelectorAll<HTMLElement>('[data-line]')].map((el) => ({
      line: Number(el.dataset.line),
      top: el.getBoundingClientRect().top - origin,
    }))
    anchors.push({ line: view.state.doc.lines, top: pane.scrollHeight })
    pane.scrollTop = Math.min(max, scrollTarget(monotonic(anchors), topLine(view)))
  }

  #schedule(): void {
    if (!this.#active || !this.#dirty || this.#frame) return
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0
      void this.#render()
    })
  }

  async #render(): Promise<void> {
    if (!this.#renderer) {
      try {
        this.#loading ??= this.#load()
        this.#renderer = await this.#loading
      } catch {
        // Offline or a stale deploy: try again on the next change.
        this.#loading = null
        this.element.replaceChildren(
          h('p', { className: 'preview-error', textContent: 'The preview could not be loaded.' }),
        )
        return
      }
    }
    if (!this.#active || !this.#dirty) return
    this.#dirty = false
    const { render, patch } = this.#renderer
    patch(this.element, render(this.#text.toString()))
    this.#onRender()
  }
}
