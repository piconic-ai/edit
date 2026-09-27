import type { Compartment, Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type * as Y from 'yjs'
import { defaultStore, type Store } from './storage.ts'

export const VIM_KEY = 'ima:vim'

/** Vim mode is off unless this browser turned it on before. */
export function loadVimMode(store: Store | null = defaultStore()): boolean {
  try {
    return store?.getItem(VIM_KEY) === 'on'
  } catch {
    return false
  }
}

export function saveVimMode(on: boolean, store: Store | null = defaultStore()): void {
  try {
    store?.setItem(VIM_KEY, on ? 'on' : 'off')
  } catch {
    // Private mode or storage disabled: the choice lasts for this page only.
  }
}

/**
 * Loads the Vim keymap on first use, so people who never turn it on do not
 * download it.
 *
 * The extension undoes through CodeMirror's own history, which would also
 * revert edits made by others. `u` and `Ctrl-r` go through the shared
 * UndoManager instead, which only tracks this browser's edits.
 */
export async function vimExtension(undoManager: Y.UndoManager): Promise<Extension> {
  const { CodeMirror, Vim, vim } = await import('@replit/codemirror-vim')
  const undo = () => {
    undoManager.undo()
  }
  const redo = () => {
    undoManager.redo()
  }
  // Module-wide tables, which is fine with one editor per page.
  CodeMirror.commands.undo = undo
  CodeMirror.commands.redo = redo
  // The ex commands copied the original functions when the module loaded.
  Vim.defineEx('undo', 'u', undo)
  Vim.defineEx('redo', 'red', redo)
  return vim({ status: true })
}

/**
 * Switches the editor in and out of Vim mode and remembers the choice.
 * The compartment must come before the other keymaps.
 */
export class VimToggle {
  #on = false
  #seq = 0
  #view: EditorView
  #compartment: Compartment
  #load: () => Promise<Extension>
  #store: Store | null

  constructor(
    view: EditorView,
    compartment: Compartment,
    load: () => Promise<Extension>,
    store: Store | null = defaultStore(),
  ) {
    this.#view = view
    this.#compartment = compartment
    this.#load = load
    this.#store = store
  }

  get on(): boolean {
    return this.#on
  }

  /** Resolves to false if the keymap could not be loaded (for example, offline). */
  async set(on: boolean): Promise<boolean> {
    const seq = ++this.#seq
    const was = this.#on
    this.#on = on
    let extension: Extension = []
    if (on) {
      try {
        extension = await this.#load()
      } catch {
        if (seq === this.#seq) this.#on = was
        return false
      }
    }
    // A newer choice may have been made while the keymap was loading.
    if (seq !== this.#seq) return true
    saveVimMode(on, this.#store)
    this.#view.dispatch({ effects: this.#compartment.reconfigure(extension) })
    return true
  }
}
