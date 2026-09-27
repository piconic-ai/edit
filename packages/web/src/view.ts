import { h } from './dom.ts'
import { defaultStore, type Store } from './storage.ts'

export type ViewMode = 'editor' | 'split' | 'preview' | 'table'

/** Which views a file has: Markdown has a preview, CSV and TSV a table. */
export type ViewKind = 'markdown' | 'table' | 'plain'

export const VIEW_KEY = 'ima:view'
export const TABLE_VIEW_KEY = 'ima:table-view'
export const NARROW_QUERY = '(max-width: 720px)'

interface KindInfo {
  key: string | null
  modes: readonly { mode: ViewMode; label: string }[]
}

const KINDS: Record<ViewKind, KindInfo> = {
  markdown: {
    key: VIEW_KEY,
    modes: [
      { mode: 'editor', label: 'Edit' },
      { mode: 'split', label: 'Split' },
      { mode: 'preview', label: 'Preview' },
    ],
  },
  table: {
    key: TABLE_VIEW_KEY,
    modes: [
      { mode: 'editor', label: 'Text' },
      { mode: 'table', label: 'Table' },
    ],
  },
  plain: { key: null, modes: [] },
}

function isModeOf(kind: ViewKind, value: unknown): value is ViewMode {
  return KINDS[kind].modes.some((m) => m.mode === value)
}

/** The mode this browser chose last for this kind of file, or null if it never chose one. */
export function loadViewMode(
  store: Store | null = defaultStore(),
  kind: ViewKind = 'markdown',
): ViewMode | null {
  const key = KINDS[kind].key
  if (!key) return null
  try {
    const value = store?.getItem(key)
    return isModeOf(kind, value) ? value : null
  } catch {
    return null
  }
}

export function saveViewMode(
  mode: ViewMode,
  store: Store | null = defaultStore(),
  kind: ViewKind = 'markdown',
): void {
  const key = KINDS[kind].key
  if (!key || !isModeOf(kind, mode)) return
  try {
    store?.setItem(key, mode)
  } catch {
    // Private mode or storage disabled: the choice lasts for this page only.
  }
}

/**
 * What to show for the chosen mode. Markdown opens side by side, except on
 * narrow screens where two panes do not fit: there it opens for reading.
 * Tables open as a table.
 */
export function effectiveMode(
  chosen: ViewMode | null,
  narrow: boolean,
  kind: ViewKind = 'markdown',
): ViewMode {
  if (kind === 'plain') return 'editor'
  if (kind === 'table') return chosen === 'editor' ? 'editor' : 'table'
  const mode = chosen && isModeOf('markdown', chosen) ? chosen : 'split'
  return narrow && mode === 'split' ? 'preview' : mode
}

export interface ViewSwitchOptions {
  narrow: boolean
  /** Called with the mode to show whenever it may have changed. */
  onApply: (mode: ViewMode) => void
  store?: Store | null
}

/**
 * The view buttons in the header: Edit / Split / Preview for Markdown, and
 * Text / Table for CSV and TSV. Other files have one view, so the buttons
 * hide and the editor fills the page.
 */
export class ViewSwitch {
  readonly element: HTMLElement
  #buttons = new Map<ViewMode, HTMLButtonElement>()
  #chosen = new Map<ViewKind, ViewMode | null>()
  #kind: ViewKind = 'markdown'
  #narrow: boolean
  #tableError: string | null = null
  #onApply: (mode: ViewMode) => void
  #store: Store | null

  constructor({ narrow, onApply, store = defaultStore() }: ViewSwitchOptions) {
    this.#store = store
    this.#narrow = narrow
    this.#onApply = onApply
    this.element = h('div', { className: 'view-switch', role: 'group', ariaLabel: 'View' })
    for (const mode of ['editor', 'split', 'preview', 'table'] as const) {
      const button = h('button', { type: 'button' })
      button.dataset.mode = mode
      button.addEventListener('click', () => this.choose(mode))
      this.#buttons.set(mode, button)
      this.element.append(button)
    }
    this.#apply()
  }

  get mode(): ViewMode {
    if (this.#kind === 'table' && this.#tableError !== null) return 'editor'
    return effectiveMode(this.#chosenFor(this.#kind), this.#narrow, this.#kind)
  }

  get kind(): ViewKind {
    return this.#kind
  }

  choose(mode: ViewMode): void {
    if (!isModeOf(this.#kind, mode)) return
    this.#chosen.set(this.#kind, mode)
    saveViewMode(mode, this.#store, this.#kind)
    this.#apply()
  }

  setNarrow(narrow: boolean): void {
    this.#narrow = narrow
    this.#apply()
  }

  /** Which views the shared file has. */
  setKind(kind: ViewKind): void {
    this.#kind = kind
    this.#apply()
  }

  /**
   * Why the file cannot show as a table right now, or null when it can.
   * Meanwhile the text editor shows, and the table comes back once it parses.
   */
  setTableError(message: string | null): void {
    if (message === this.#tableError) return
    this.#tableError = message
    this.#apply()
  }

  #chosenFor(kind: ViewKind): ViewMode | null {
    if (!this.#chosen.has(kind)) this.#chosen.set(kind, loadViewMode(this.#store, kind))
    return this.#chosen.get(kind) ?? null
  }

  #apply(): void {
    const mode = this.mode
    const { modes } = KINDS[this.#kind]
    this.element.hidden = modes.length === 0
    for (const [m, button] of this.#buttons) {
      const info = modes.find((x) => x.mode === m)
      button.hidden = !info || (m === 'split' && this.#narrow)
      button.textContent = info?.label ?? ''
      button.setAttribute('aria-pressed', String(m === mode))
    }
    const table = this.#buttons.get('table')
    if (table) {
      const error = this.#kind === 'table' ? this.#tableError : null
      table.disabled = error !== null
      if (error === null) table.removeAttribute('title')
      else table.title = error
    }
    this.#onApply(mode)
  }
}
