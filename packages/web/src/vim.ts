import { indentWithTab } from '@codemirror/commands'
import type { Compartment, Extension } from '@codemirror/state'
import { type EditorView, keymap, ViewPlugin } from '@codemirror/view'
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
 *
 * Tab indents instead of moving focus, as it does in Vim. Escape then Tab
 * still leaves the editor.
 */
export async function vimExtension(undoManager: Y.UndoManager): Promise<Extension> {
  const { CodeMirror, getCM, Vim, vim } = await import('@replit/codemirror-vim')
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
  fixLastLineDelete(Vim)
  return [vim({ status: true }), keymap.of([indentWithTab]), skipTrailingLine(getCM)]
}

type GetCM = typeof import('@replit/codemirror-vim').getCM
type VimApi = typeof import('@replit/codemirror-vim').Vim
type RegisterController = ReturnType<VimApi['getRegisterController']>

const fixedControllers = new WeakSet<object>()

/**
 * `dd` on the last line of a file without a trailing newline also deletes
 * the newline before it, and the register gets that newline in front of the
 * line, so `p` pastes an empty line too. Stores it as a plain line instead.
 * Patched on the prototype so it survives the register controller being
 * recreated.
 */
function fixLastLineDelete(Vim: VimApi): void {
  const proto: RegisterController = Object.getPrototypeOf(Vim.getRegisterController())
  if (fixedControllers.has(proto)) return
  fixedControllers.add(proto)
  const pushText = proto.pushText
  proto.pushText = function (registerName, operator, text, linewise, blockwise) {
    const lastLine = linewise && text.startsWith('\n') && !text.endsWith('\n')
    const stored = lastLine ? `${text.slice(1)}\n` : text
    pushText.call(this, registerName, operator, stored, linewise, blockwise)
  }
}

/**
 * A file that ends with a newline shows an empty line after it, which Vim
 * does not have. Keeps the normal-mode cursor off that line, so `dd` on the
 * last line lands on the new last line and `p` pastes below it, as in Vim.
 */
function skipTrailingLine(getCM: GetCM): Extension {
  return ViewPlugin.define((view) => {
    const cm = getCM(view)
    const skip = () => {
      const vim = cm?.state.vim
      if (!cm || !vim || vim.insertMode || vim.visualMode) return
      const { doc, selection } = view.state
      const last = doc.lines
      if (last < 2 || doc.line(last).length > 0) return
      if (doc.lineAt(selection.main.head).number !== last) return
      const above = doc.line(last - 1).text
      cm.setCursor(last - 2, Math.max(0, above.search(/\S/)))
    }
    // Vim commands end outside of a view update, but a click reports its
    // cursor activity during one, when the view cannot be dispatched to.
    const onCursorActivity = () => {
      if (cm?.curOp?.isVimOp) skip()
      else queueMicrotask(skip)
    }
    cm?.on('cursorActivity', onCursorActivity)
    return { destroy: () => cm?.off('cursorActivity', onCursorActivity) }
  })
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
