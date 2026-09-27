import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import {
  CsvError,
  cellAt,
  deleteColumn,
  deleteRow,
  type Edit,
  insertColumn,
  insertRow,
  setCell,
  type Table,
  tryParse,
} from './csv.ts'
import { h } from './dom.ts'
import { participants } from './room.ts'

/** Marks the table's own edits, so the undo manager tracks them and the view knows them. */
const TABLE_ORIGIN = Symbol('table')

interface Position {
  row: number
  col: number
}

interface Peer {
  name: string
  color: string
}

export interface TableViewOptions {
  /** Called whenever the file starts or stops parsing, with why it does not. */
  onError?: (error: CsvError | null) => void
  /** Batches redraws; a frame by default. */
  schedule?: (redraw: () => void) => void
}

export function applyToText(text: Y.Text, edits: readonly Edit[], origin: unknown): void {
  if (edits.length === 0) return
  text.doc?.transact(() => {
    // From the end, so earlier positions stay valid.
    for (const e of [...edits].sort((a, b) => b.from - a.from)) {
      if (e.to > e.from) text.delete(e.from, e.to - e.from)
      if (e.insert) text.insert(e.from, e.insert)
    }
  }, origin)
}

/** Why the table cannot show, in a line fit for a tooltip. */
export function describeError(error: CsvError): string {
  return `Shown as text: line ${error.line} is not valid CSV (${error.message.toLowerCase()}).`
}

/**
 * CSV and TSV as a grid. Each change is written straight to the shared text
 * (csv.ts), so the table is only another way to look at the file.
 * The selected cell is remembered by its place in the text, so it stays put
 * when someone adds a row above it.
 */
export class TableView {
  readonly element: HTMLElement
  #text: Y.Text
  #awareness: Awareness
  #undo: Y.UndoManager
  #schedule: (redraw: () => void) => void
  #onError: (error: CsvError | null) => void
  #grid: HTMLTableElement
  #scroller: HTMLElement
  #tools: Record<'addRow' | 'deleteRow' | 'addColumn' | 'deleteColumn', HTMLButtonElement>
  #delimiter: string | null = null
  #table: Table | null = null
  #error: CsvError | null = null
  #active = false
  #dirty = true
  #pending = false
  #selected: Position | null = null
  /** Where the selected cell starts in the text; null for a cell not in the file yet. */
  #anchor: Y.RelativePosition | null = null
  #editor: HTMLTextAreaElement | null = null

  constructor(
    text: Y.Text,
    awareness: Awareness,
    undoManager: Y.UndoManager,
    options: TableViewOptions = {},
  ) {
    this.#text = text
    this.#awareness = awareness
    this.#undo = undoManager
    this.#undo.addTrackedOrigin(TABLE_ORIGIN)
    this.#schedule = options.schedule ?? ((redraw) => requestAnimationFrame(redraw))
    this.#onError = options.onError ?? (() => {})

    const tool = (label: string, action: () => void) => {
      const button = h('button', { type: 'button', textContent: label })
      button.addEventListener('click', action)
      return button
    }
    this.#tools = {
      addRow: tool('Add row', () => this.addRow()),
      deleteRow: tool('Delete row', () => this.deleteRow()),
      addColumn: tool('Add column', () => this.addColumn()),
      deleteColumn: tool('Delete column', () => this.deleteColumn()),
    }
    this.#grid = h('table', { className: 'grid' })
    this.#grid.setAttribute('role', 'grid')
    this.#grid.addEventListener('click', (ev) => this.#onClick(ev))
    this.#grid.addEventListener('dblclick', (ev) => {
      const at = this.#positionOf(ev.target)
      if (at) this.edit(at)
    })
    this.#grid.addEventListener('keydown', (ev) => this.#onKey(ev))
    this.#scroller = h('div', { className: 'table-scroll' }, [this.#grid])
    this.element = h('section', { className: 'table-view', ariaLabel: 'Table' }, [
      h('div', { className: 'table-tools', role: 'toolbar', ariaLabel: 'Rows and columns' }, [
        ...Object.values(this.#tools),
      ]),
      this.#scroller,
    ])

    text.observe((event) => this.#onChange(event.transaction.origin === TABLE_ORIGIN))
    awareness.on('change', () => {
      if (this.#active) this.#paintPeers()
    })
  }

  get active(): boolean {
    return this.#active
  }

  set active(on: boolean) {
    this.#active = on
    if (!on) this.#finishEdit(false)
    this.#request()
  }

  get selected(): Position | null {
    return this.#selected && { ...this.#selected }
  }

  get table(): Table | null {
    return this.#table
  }

  /** The delimiter for the shared file, or null when it is not a table. */
  setDelimiter(delimiter: string | null): void {
    if (delimiter === this.#delimiter) return
    this.#delimiter = delimiter
    this.#dirty = true
    this.#parse()
    this.#request()
  }

  select(at: Position, focus = true): void {
    const row = Math.max(0, at.row)
    const col = Math.max(0, at.col)
    if (this.#editor) this.#finishEdit(false)
    this.#selected = { row, col }
    this.#anchor = this.#anchorFor(this.#selected)
    this.#publishCursor()
    this.#paintSelection(focus)
  }

  /** Starts editing a cell; `initial` replaces its value, as typing over a cell does. */
  edit(at: Position, initial?: string): void {
    if (!this.#table) return
    this.select(at, false)
    const value = initial ?? this.#valueAt(at)
    const editor = h('textarea', { className: 'cell-editor', value, rows: 1 })
    editor.setAttribute('aria-label', 'Cell')
    editor.addEventListener('input', () => this.#write(editor.value))
    editor.addEventListener('keydown', (ev) => this.#onEditorKey(ev))
    // Redraws move the textarea to a fresh cell, which blurs it for a moment:
    // only a blur that sticks ends the edit.
    editor.addEventListener('blur', () => {
      setTimeout(() => {
        if (this.#editor === editor && document.activeElement !== editor) this.#finishEdit(false)
      })
    })
    this.#editor = editor
    const cell = this.#cellElement(at)
    cell?.replaceChildren(editor)
    this.#fit()
    editor.focus()
    editor.setSelectionRange(value.length, value.length)
    if (initial !== undefined) this.#write(initial)
  }

  addRow(): void {
    const table = this.#table
    if (!table) return
    const row = this.#selected ? this.#selected.row + 1 : table.rows.length
    this.#apply(insertRow(table, row))
    this.select({ row, col: this.#selected?.col ?? 0 })
  }

  deleteRow(): void {
    const table = this.#table
    const at = this.#selected
    if (!table || !at || !table.rows[at.row]) return
    this.#apply(deleteRow(table, at.row))
    const rows = this.#table?.rows.length ?? 0
    this.select({ row: Math.min(at.row, Math.max(0, rows - 1)), col: at.col })
  }

  addColumn(): void {
    const table = this.#table
    if (!table) return
    const col = this.#selected ? this.#selected.col + 1 : Math.max(1, table.columns)
    this.#apply(insertColumn(table, col))
    this.select({ row: this.#selected?.row ?? 0, col })
  }

  deleteColumn(): void {
    const table = this.#table
    const at = this.#selected
    if (!table || !at) return
    this.#apply(deleteColumn(table, at.col))
    const cols = this.#table?.columns ?? 0
    this.select({ row: at.row, col: Math.min(at.col, Math.max(0, cols - 1)) })
  }

  #apply(edits: Edit[]): void {
    this.#undo.stopCapturing()
    applyToText(this.#text, edits, TABLE_ORIGIN)
    this.#undo.stopCapturing()
  }

  #write(value: string): void {
    const table = this.#table
    const at = this.#selected
    if (!table || !at) return
    applyToText(this.#text, setCell(table, at.row, at.col, value), TABLE_ORIGIN)
  }

  #onChange(local: boolean): void {
    this.#parse()
    if (local) {
      // Our own edit: the selection has not moved, but a new cell now has a place.
      if (this.#selected) this.#anchor = this.#anchorFor(this.#selected)
      // Typing in the open cell changes nothing else on screen.
      if (this.#editor) return
    } else {
      this.#follow()
    }
    this.#dirty = true
    this.#request()
  }

  #parse(): void {
    const result = this.#delimiter ? tryParse(this.#text.toString(), this.#delimiter) : null
    const error = result instanceof CsvError ? result : null
    this.#table = result instanceof CsvError ? null : result
    const changed = error?.message !== this.#error?.message || error?.line !== this.#error?.line
    this.#error = error
    if (changed) this.#onError(error)
  }

  /** Moves the selection to where its cell went after someone else's edit. */
  #follow(): void {
    if (!this.#selected || !this.#anchor || !this.#table || !this.#text.doc) return
    const abs = Y.createAbsolutePositionFromRelativePosition(this.#anchor, this.#text.doc)
    const at = abs && cellAt(this.#table, abs.index)
    if (at) this.#selected = at
  }

  #anchorFor(at: Position): Y.RelativePosition | null {
    const cell = this.#table?.rows[at.row]?.cells[at.col]
    return cell ? Y.createRelativePositionFromTypeIndex(this.#text, cell.from) : null
  }

  #valueAt(at: Position): string {
    return this.#table?.rows[at.row]?.cells[at.col]?.value ?? ''
  }

  /** Shows others where we are: the start of the cell, like a cursor in the text. */
  #publishCursor(): void {
    const cell = this.#selected && this.#table?.rows[this.#selected.row]?.cells[this.#selected.col]
    if (!cell) return
    const pos = Y.createRelativePositionFromTypeIndex(this.#text, cell.from + (cell.quoted ? 1 : 0))
    this.#awareness.setLocalStateField('cursor', { anchor: pos, head: pos })
  }

  #request(): void {
    if (!this.#active || !this.#dirty || this.#pending) return
    this.#pending = true
    this.#schedule(() => {
      this.#pending = false
      if (this.#active && this.#dirty) this.#render()
    })
  }

  #render(): void {
    this.#dirty = false
    const table = this.#table
    if (!table) {
      this.#grid.replaceChildren()
      this.#paintTools()
      return
    }
    const columns = Math.max(1, table.columns)
    // An empty file still gets one cell to type into.
    const rows = table.rows.length > 0 ? table.rows : [{ cells: [] }]
    const line = (cells: readonly { value: string }[], row: number, tag: 'th' | 'td') => {
      const tr = h('tr')
      for (let col = 0; col < columns; col++) {
        const cell = h(tag, { textContent: cells[col]?.value ?? '' })
        cell.setAttribute('role', row === 0 ? 'columnheader' : 'gridcell')
        cell.dataset.row = String(row)
        cell.dataset.col = String(col)
        cell.tabIndex = -1
        tr.append(cell)
      }
      return tr
    }
    const [head, ...body] = rows
    // Redrawing replaces the focused cell; the new one takes the focus over.
    const hadFocus = this.#grid.contains(document.activeElement)
    this.#grid.replaceChildren(
      h('thead', {}, [line(head?.cells ?? [], 0, 'th')]),
      h(
        'tbody',
        {},
        body.map((r, i) => line(r.cells, i + 1, 'td')),
      ),
    )
    const editor = this.#editor
    if (editor && this.#selected) {
      const focused = document.activeElement === editor
      const value = this.#valueAt(this.#selected)
      if (editor.value !== value) keepCaret(editor, value)
      const { selectionStart, selectionEnd } = editor
      this.#cellElement(this.#selected)?.replaceChildren(editor)
      this.#fit()
      if (focused && document.activeElement !== editor) {
        editor.focus()
        editor.setSelectionRange(selectionStart, selectionEnd)
      }
    }
    this.#paintSelection(hadFocus)
    this.#paintPeers()
  }

  #paintTools(): void {
    const table = this.#table
    const at = this.#selected
    const hasRow = !!(table && at && table.rows[at.row])
    this.#tools.addRow.disabled = !table
    this.#tools.addColumn.disabled = !table
    this.#tools.deleteRow.disabled = !hasRow
    this.#tools.deleteColumn.disabled = !(table && at && at.col < table.columns)
  }

  #paintSelection(focus: boolean): void {
    for (const el of this.#grid.querySelectorAll<HTMLElement>('[aria-selected="true"]')) {
      el.removeAttribute('aria-selected')
      el.tabIndex = -1
    }
    const cell = this.#selected ? this.#cellElement(this.#selected) : null
    // Keeps the grid reachable with Tab even before anything was selected.
    const target = cell ?? this.#grid.querySelector<HTMLElement>('[data-row]')
    if (target) target.tabIndex = 0
    if (cell) {
      cell.setAttribute('aria-selected', 'true')
      if (focus && !this.#editor) cell.focus()
      cell.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    }
    this.#paintTools()
  }

  #paintPeers(): void {
    for (const el of this.#grid.querySelectorAll<HTMLElement>('[data-peers]')) {
      delete el.dataset.peers
      el.style.removeProperty('--peer')
      el.querySelector('.cell-peer')?.remove()
    }
    const table = this.#table
    const doc = this.#text.doc
    if (!table || !doc) return
    const byCell = new Map<string, Peer[]>()
    const states = this.#awareness.getStates()
    for (const p of participants(states, doc.clientID)) {
      if (p.isSelf) continue
      const cursor = (states.get(p.clientId) as { cursor?: { head?: unknown } } | undefined)?.cursor
      if (!cursor?.head) continue
      let index: number | undefined
      try {
        const rel = Y.createRelativePositionFromJSON(cursor.head)
        index = Y.createAbsolutePositionFromRelativePosition(rel, doc)?.index
      } catch {
        continue
      }
      const at = index === undefined ? null : cellAt(table, index)
      if (!at) continue
      const key = `${at.row}:${at.col}`
      byCell.set(key, [...(byCell.get(key) ?? []), { name: p.name, color: p.color }])
    }
    for (const [key, peers] of byCell) {
      const [row, col] = key.split(':').map(Number) as [number, number]
      const cell = this.#cellElement({ row, col })
      const first = peers[0]
      if (!cell || !first) continue
      const names = peers.map((p) => p.name).join(', ')
      cell.dataset.peers = names
      cell.style.setProperty('--peer', first.color)
      const label = h('span', { className: 'cell-peer', textContent: names })
      label.setAttribute('aria-hidden', 'true')
      label.style.background = first.color
      cell.append(label)
    }
  }

  #cellElement(at: Position): HTMLElement | null {
    return this.#grid.querySelector<HTMLElement>(`[data-row="${at.row}"][data-col="${at.col}"]`)
  }

  #positionOf(target: EventTarget | null): Position | null {
    const cell = (target as HTMLElement | null)?.closest?.<HTMLElement>('[data-row]')
    if (!cell || !this.#grid.contains(cell)) return null
    return { row: Number(cell.dataset.row), col: Number(cell.dataset.col) }
  }

  #onClick(ev: MouseEvent): void {
    if ((ev.target as HTMLElement).closest('.cell-editor')) return
    const at = this.#positionOf(ev.target)
    if (!at) return
    const again = this.#selected?.row === at.row && this.#selected.col === at.col
    // A second tap edits: phones have no double-click to spare.
    if (again) this.edit(at)
    else this.select(at)
  }

  #onKey(ev: KeyboardEvent): void {
    // Keys in the open cell are the editor's (#onEditorKey).
    if ((ev.target as Element).closest?.('.cell-editor') || this.#editor || !this.#selected) return
    const { row, col } = this.#selected
    const mod = ev.ctrlKey || ev.metaKey
    if (mod && ev.key.toLowerCase() === 'z') {
      ev.preventDefault()
      if (ev.shiftKey) this.#undo.redo()
      else this.#undo.undo()
      return
    }
    if (mod && ev.key.toLowerCase() === 'y') {
      ev.preventDefault()
      this.#undo.redo()
      return
    }
    const rows = Math.max(1, this.#table?.rows.length ?? 0)
    const cols = Math.max(1, this.#table?.columns ?? 0)
    const moves: Record<string, Position> = {
      ArrowUp: { row: Math.max(0, row - 1), col },
      ArrowDown: { row: Math.min(rows - 1, row + 1), col },
      ArrowLeft: { row, col: Math.max(0, col - 1) },
      ArrowRight: { row, col: Math.min(cols - 1, col + 1) },
      Home: { row: mod ? 0 : row, col: 0 },
      End: { row: mod ? rows - 1 : row, col: cols - 1 },
    }
    const move = moves[ev.key]
    if (move) {
      ev.preventDefault()
      this.select(move)
    } else if (ev.key === 'Enter' || ev.key === 'F2') {
      ev.preventDefault()
      this.edit({ row, col })
    } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault()
      this.#undo.stopCapturing()
      this.#write('')
      this.#undo.stopCapturing()
    } else if (isComposing(ev)) {
      // An IME is starting: open the cell as it is, so the conversion lands in
      // the editor. Replacing the value would clear it if it did not.
      this.edit({ row, col })
    } else if (ev.key.length === 1 && !mod && !ev.altKey) {
      ev.preventDefault()
      this.edit({ row, col }, ev.key)
    }
  }

  #onEditorKey(ev: KeyboardEvent): void {
    const at = this.#selected
    // Keys that confirm or cancel an IME conversion belong to the IME. Safari
    // sends the confirming Enter just after compositionend, with keyCode 229.
    if (!at || isComposing(ev)) return
    const mod = ev.ctrlKey || ev.metaKey
    // The text is written as you type, so the textarea's own undo would lose track.
    if (mod && (ev.key.toLowerCase() === 'z' || ev.key.toLowerCase() === 'y')) {
      ev.preventDefault()
      if (ev.key.toLowerCase() === 'y' || ev.shiftKey) this.#undo.redo()
      else this.#undo.undo()
      return
    }
    if (ev.key === 'Enter' && ev.altKey) {
      ev.preventDefault()
      const editor = ev.target as HTMLTextAreaElement
      editor.setRangeText('\n', editor.selectionStart, editor.selectionEnd, 'end')
      this.#write(editor.value)
      this.#fit()
      return
    }
    const next =
      ev.key === 'Enter' && !ev.shiftKey
        ? { row: at.row + 1, col: at.col }
        : ev.key === 'Tab'
          ? { row: at.row, col: Math.max(0, at.col + (ev.shiftKey ? -1 : 1)) }
          : ev.key === 'Escape'
            ? at
            : null
    if (!next) {
      this.#fit()
      return
    }
    ev.preventDefault()
    this.#finishEdit(true)
    const rows = Math.max(1, this.#table?.rows.length ?? 0)
    const cols = Math.max(1, this.#table?.columns ?? 0)
    this.select({ row: Math.min(rows - 1, next.row), col: Math.min(cols - 1, next.col) })
  }

  #finishEdit(focus: boolean): void {
    const editor = this.#editor
    if (!editor) return
    this.#editor = null
    this.#undo.stopCapturing()
    editor.remove()
    this.#dirty = true
    if (this.#active) this.#render()
    if (focus) this.#paintSelection(true)
  }

  /** Grows the textarea with its lines. */
  #fit(): void {
    const editor = this.#editor
    if (!editor) return
    editor.rows = Math.max(1, editor.value.split('\n').length)
  }
}

function isComposing(ev: KeyboardEvent): boolean {
  return ev.isComposing || ev.key === 'Process' || ev.keyCode === 229
}

/** Replaces a textarea's value, keeping the caret on the same text around a change elsewhere. */
export function keepCaret(editor: HTMLTextAreaElement, value: string): void {
  const before = editor.value
  const caret = editor.selectionStart
  let start = 0
  while (start < before.length && start < value.length && before[start] === value[start]) start++
  editor.value = value
  const shifted = caret > start ? caret + (value.length - before.length) : caret
  const at = Math.max(0, Math.min(value.length, shifted))
  editor.setSelectionRange(at, at)
}
