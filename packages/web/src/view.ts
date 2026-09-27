import { h } from './dom.ts'
import { defaultStore, type Store } from './storage.ts'

export type ViewMode = 'editor' | 'split' | 'preview'

export const VIEW_KEY = 'ima:view'
export const NARROW_QUERY = '(max-width: 720px)'

const MODES: readonly { mode: ViewMode; label: string }[] = [
  { mode: 'editor', label: 'Edit' },
  { mode: 'split', label: 'Split' },
  { mode: 'preview', label: 'Preview' },
]

function isViewMode(value: unknown): value is ViewMode {
  return MODES.some((m) => m.mode === value)
}

/** The mode this browser chose last, or null if it never chose one. */
export function loadViewMode(store: Store | null = defaultStore()): ViewMode | null {
  try {
    const value = store?.getItem(VIEW_KEY)
    return isViewMode(value) ? value : null
  } catch {
    return null
  }
}

export function saveViewMode(mode: ViewMode, store: Store | null = defaultStore()): void {
  try {
    store?.setItem(VIEW_KEY, mode)
  } catch {
    // Private mode or storage disabled: the choice lasts for this page only.
  }
}

/**
 * What to show for the chosen mode. Markdown opens side by side, except on
 * narrow screens where two panes do not fit: there it opens for reading.
 */
export function effectiveMode(chosen: ViewMode | null, narrow: boolean): ViewMode {
  const mode = chosen ?? 'split'
  return narrow && mode === 'split' ? 'preview' : mode
}

export interface ViewSwitchOptions {
  narrow: boolean
  /** Called with the mode to show whenever it may have changed. */
  onApply: (mode: ViewMode) => void
  store?: Store | null
}

/**
 * The Edit / Split / Preview buttons in the header. Only Markdown has a
 * preview, so for other files the buttons hide and the editor fills the page.
 */
export class ViewSwitch {
  readonly element: HTMLElement
  #buttons = new Map<ViewMode, HTMLButtonElement>()
  #chosen: ViewMode | null
  #narrow: boolean
  #enabled = true
  #onApply: (mode: ViewMode) => void
  #store: Store | null

  constructor({ narrow, onApply, store = defaultStore() }: ViewSwitchOptions) {
    this.#store = store
    this.#chosen = loadViewMode(store)
    this.#narrow = narrow
    this.#onApply = onApply
    this.element = h('div', { className: 'view-switch', role: 'group', ariaLabel: 'View' })
    for (const { mode, label } of MODES) {
      const button = h('button', { type: 'button', textContent: label })
      button.dataset.mode = mode
      button.addEventListener('click', () => this.choose(mode))
      this.#buttons.set(mode, button)
      this.element.append(button)
    }
    this.#apply()
  }

  get mode(): ViewMode {
    return this.#enabled ? effectiveMode(this.#chosen, this.#narrow) : 'editor'
  }

  choose(mode: ViewMode): void {
    this.#chosen = mode
    saveViewMode(mode, this.#store)
    this.#apply()
  }

  setNarrow(narrow: boolean): void {
    this.#narrow = narrow
    this.#apply()
  }

  /** Whether the file has a preview at all. */
  setEnabled(enabled: boolean): void {
    this.#enabled = enabled
    this.#apply()
  }

  #apply(): void {
    const mode = this.mode
    this.element.hidden = !this.#enabled
    for (const [m, button] of this.#buttons) {
      button.setAttribute('aria-pressed', String(m === mode))
    }
    const split = this.#buttons.get('split')
    if (split) split.hidden = this.#narrow
    this.#onApply(mode)
  }
}
