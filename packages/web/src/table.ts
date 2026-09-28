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
import { ContextMenu, type MenuItem, SEPARATOR } from './menu.ts'
import { participants } from './room.ts'

/** Marks the table's own edits, so the undo manager tracks them and the view knows them. */
const TABLE_ORIGIN = Symbol('table')

interface Position {
  row: number
  col: number
}

/** What is selected around the cursor cell: the cell, its whole row, or its whole column. */
export type Span = 'cell' | 'row' | 'column'

/** What a right-click or long press landed on. */
type Target =
  | { kind: 'cell'; at: Position }
  | { kind: 'row'; row: number }
  | { kind: 'column'; col: number }

const LONG_PRESS_MS = 550

/** Spreadsheet column names: A to Z, then AA, AB and on. */
export function columnName(index: number): string {
  let n = index + 1
  let name = ''
  while (n > 0) {
    const r = (n - 1) % 26
    name = String.fromCharCode(65 + r) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

/** The shortcuts, as in Google Sheets. */
export const SHORTCUTS = {
  insert: ['Mod', 'Alt', '='],
  remove: ['Mod', 'Alt', '-'],
} as const

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
 * CSV and TSV as a spreadsheet-like grid, with lettered columns and numbered
 * rows. Each change is written straight to the shared text (csv.ts), so the
 * table is only another way to look at the file. The selected cell is
 * remembered by its place in the text, so it stays put when someone adds a
 * row above it. Rows and columns are added and removed from a context menu
 * (right-click or long press) or with Google Sheets' shortcuts.
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
  #menu = new ContextMenu()
  #span: Span = 'cell'
  /** Set after a long press opened the menu, so the tap that ends it does not select. */
  #swallowClick = false
  /** How the last press came: a second tap edits on a touch screen, not with a mouse. */
  #pointer = 'mouse'
  /** The cell's value when its edit began, for Escape to put back. */
  #original = ''
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
  /** The edited text, hidden under the editor, so the cell keeps the size it would have. */
  #mirror = h('span', { className: 'cell-mirror' })

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

    this.#grid = h('table', { className: 'grid' })
    this.#grid.setAttribute('role', 'grid')
    this.#grid.addEventListener('click', (ev) => this.#onClick(ev))
    this.#grid.addEventListener('dblclick', (ev) => {
      const at = this.#positionOf(ev.target)
      if (at) this.edit(at)
    })
    this.#grid.addEventListener('keydown', (ev) => this.#onKey(ev))
    this.#grid.addEventListener('contextmenu', (ev) => {
      if ((ev.target as Element).closest?.('.cell-editor')) return
      const target = this.#targetOf(ev.target)
      if (!target) return
      ev.preventDefault()
      this.openMenu(target, ev.clientX, ev.clientY)
    })
    this.#listenForLongPress()
    this.#scroller = h('div', { className: 'table-scroll' }, [this.#grid])
    this.element = h('section', { className: 'table-view', ariaLabel: 'Table' }, [
      this.#scroller,
      this.#menu.element,
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
    if (!on) {
      this.#finishEdit(false)
      this.#menu.close()
    }
    this.#request()
  }

  get selected(): Position | null {
    return this.#selected && { ...this.#selected }
  }

  get span(): Span {
    return this.#span
  }

  get menu(): ContextMenu {
    return this.#menu
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

  /** Moves the cursor to a cell; `span` widens the selection to its row or column. */
  select(at: Position, focus = true, span: Span = 'cell'): void {
    const row = Math.max(0, at.row)
    const col = Math.max(0, at.col)
    if (this.#editor) this.#finishEdit(false)
    this.#selected = { row, col }
    this.#span = span
    this.#anchor = this.#anchorFor(this.#selected)
    this.#publishCursor()
    this.#paintSelection(focus)
  }

  /** Starts editing a cell; `initial` replaces its value, as typing over a cell does. */
  edit(at: Position, initial?: string): void {
    if (!this.#table) return
    this.select(at, false)
    this.#original = this.#valueAt(at)
    const value = initial ?? this.#original
    const editor = h('textarea', { className: 'cell-editor', value, rows: 1 })
    editor.setAttribute('aria-label', 'Cell')
    editor.addEventListener('input', () => {
      this.#write(editor.value)
      this.#fit()
    })
    editor.addEventListener('keydown', (ev) => this.#onEditorKey(ev))
    // Redraws move the textarea to a fresh cell, which blurs it for a moment:
    // only a blur that sticks ends the edit.
    editor.addEventListener('blur', () => {
      setTimeout(() => {
        if (this.#editor === editor && document.activeElement !== editor) this.#finishEdit(false)
      })
    })
    this.#editor = editor
    this.#mirror.setAttribute('aria-hidden', 'true')
    this.#cellElement(at)?.replaceChildren(this.#mirror, editor)
    this.#fit()
    editor.focus()
    editor.setSelectionRange(value.length, value.length)
    if (initial !== undefined) this.#write(initial)
  }

  /** Inserts an empty row next to the cursor's and selects it. */
  insertRow(where: 'above' | 'below'): void {
    const table = this.#table
    if (!table) return
    const at = this.#selected ?? { row: 0, col: 0 }
    const row = where === 'above' ? at.row : at.row + 1
    this.#apply(insertRow(table, row))
    this.select({ row, col: at.col }, true, this.#span === 'row' ? 'row' : 'cell')
  }

  /** Inserts an empty column next to the cursor's and selects it. */
  insertColumn(where: 'left' | 'right'): void {
    const table = this.#table
    if (!table) return
    const at = this.#selected ?? { row: 0, col: 0 }
    const col = where === 'left' ? at.col : at.col + 1
    this.#apply(insertColumn(table, col))
    this.select({ row: at.row, col }, true, this.#span === 'column' ? 'column' : 'cell')
  }

  deleteRow(): void {
    const table = this.#table
    const at = this.#selected
    if (!table || !at || !table.rows[at.row]) return
    this.#apply(deleteRow(table, at.row))
    const rows = this.#table?.rows.length ?? 0
    // The row that takes its place stays selected the same way, so pressing
    // the delete keys again goes on deleting rows.
    const span = this.#span === 'row' ? 'row' : 'cell'
    this.select({ row: Math.min(at.row, Math.max(0, rows - 1)), col: at.col }, true, span)
  }

  deleteColumn(): void {
    const table = this.#table
    const at = this.#selected
    if (!table || !at || at.col >= table.columns) return
    this.#apply(deleteColumn(table, at.col))
    const cols = this.#table?.columns ?? 0
    const span = this.#span === 'column' ? 'column' : 'cell'
    this.select({ row: at.row, col: Math.min(at.col, Math.max(0, cols - 1)) }, true, span)
  }

  /** Opens the row and column menu for what was right-clicked or long-pressed. */
  openMenu(target: Target, x: number, y: number): void {
    if (this.#editor) this.#finishEdit(false)
    const cursor = this.#selected
    if (target.kind === 'row') {
      this.select({ row: target.row, col: cursor?.col ?? 0 }, true, 'row')
    } else if (target.kind === 'column') {
      this.select({ row: cursor?.row ?? 0, col: target.col }, true, 'column')
    } else if (!this.#inSelection(target.at)) {
      this.select(target.at)
    }
    this.#menu.show(this.#menuItems(target.kind), x, y)
  }

  #menuItems(kind: Target['kind']): (MenuItem | null)[] {
    const table = this.#table
    const at = this.#selected
    const { insert, remove } = SHORTCUTS
    // The shortcuts work on a whole selected row or column, as in Google Sheets.
    const rowKeys = kind === 'row'
    const columnKeys = kind === 'column'
    const rows: MenuItem[] = [
      {
        label: 'Insert row above',
        keys: rowKeys ? insert : undefined,
        action: () => this.insertRow('above'),
      },
      { label: 'Insert row below', action: () => this.insertRow('below') },
      {
        label: 'Delete row',
        keys: rowKeys ? remove : undefined,
        disabled: !(table && at && table.rows[at.row]),
        action: () => this.deleteRow(),
      },
    ]
    const columns: MenuItem[] = [
      {
        label: 'Insert column left',
        keys: columnKeys ? insert : undefined,
        action: () => this.insertColumn('left'),
      },
      { label: 'Insert column right', action: () => this.insertColumn('right') },
      {
        label: 'Delete column',
        keys: columnKeys ? remove : undefined,
        disabled: !(table && at && at.col < table.columns),
        action: () => this.deleteColumn(),
      },
    ]
    if (kind === 'row') return rows
    if (kind === 'column') return columns
    return [...rows, SEPARATOR, ...columns]
  }

  #inSelection(at: Position): boolean {
    const s = this.#selected
    if (!s) return false
    if (this.#span === 'row') return s.row === at.row
    if (this.#span === 'column') return s.col === at.col
    return s.row === at.row && s.col === at.col
  }

  /** Touch screens: a long press opens the menu, as a right-click does. */
  #listenForLongPress(): void {
    let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null
    const cancel = () => {
      if (press) clearTimeout(press.timer)
      press = null
    }
    this.#grid.addEventListener('pointerdown', (ev) => {
      // The click that ends a long press, if the platform sends one, always
      // comes before the next press: a flag still set here was never used.
      this.#swallowClick = false
      this.#pointer = ev.pointerType
      if (ev.pointerType !== 'touch') return
      cancel()
      const target = this.#targetOf(ev.target)
      if (!target || (ev.target as Element).closest?.('.cell-editor')) return
      const { clientX: x, clientY: y } = ev
      press = {
        x,
        y,
        timer: setTimeout(() => {
          press = null
          // Android also sends contextmenu for a long press; one menu is enough.
          if (this.#menu.open) return
          this.#swallowClick = true
          this.openMenu(target, x, y)
        }, LONG_PRESS_MS),
      }
    })
    this.#grid.addEventListener('pointermove', (ev) => {
      if (press && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 10) cancel()
    })
    this.#grid.addEventListener('pointerup', cancel)
    this.#grid.addEventListener('pointercancel', cancel)
  }

  /** Clears every cell in the selection. */
  #clear(): void {
    const table = this.#table
    const at = this.#selected
    if (!table || !at) return
    const cells: Position[] =
      this.#span === 'row'
        ? Array.from({ length: table.columns }, (_, col) => ({ row: at.row, col }))
        : this.#span === 'column'
          ? table.rows.map((_, row) => ({ row, col: at.col }))
          : [at]
    this.#apply(cells.flatMap((c) => setCell(table, c.row, c.col, '')))
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
      return
    }
    const columns = Math.max(1, table.columns)
    // An empty file still gets one cell to type into.
    const rows = table.rows.length > 0 ? table.rows : [{ cells: [] }]
    const corner = h('th', { className: 'grid-corner' })
    corner.setAttribute('aria-hidden', 'true')
    const heads = Array.from({ length: columns }, (_, col) => {
      const th = h('th', { className: 'col-head', textContent: columnName(col) })
      th.setAttribute('role', 'columnheader')
      th.dataset.headCol = String(col)
      return th
    })
    const lines = rows.map((r, row) => {
      const head = h('th', { className: 'row-head', textContent: String(row + 1) })
      head.setAttribute('role', 'rowheader')
      head.dataset.headRow = String(row)
      const tr = h('tr', {}, [head])
      for (let col = 0; col < columns; col++) {
        const cell = h('td', { textContent: r.cells[col]?.value ?? '' })
        cell.setAttribute('role', 'gridcell')
        cell.dataset.row = String(row)
        cell.dataset.col = String(col)
        cell.tabIndex = -1
        tr.append(cell)
      }
      return tr
    })
    // Redrawing replaces the focused cell; the new one takes the focus over.
    const hadFocus = this.#grid.contains(document.activeElement)
    this.#grid.replaceChildren(
      h('thead', {}, [h('tr', {}, [corner, ...heads])]),
      h('tbody', {}, lines),
    )
    const editor = this.#editor
    if (editor && this.#selected) {
      const focused = document.activeElement === editor
      const value = this.#valueAt(this.#selected)
      if (editor.value !== value) keepCaret(editor, value)
      const { selectionStart, selectionEnd } = editor
      this.#cellElement(this.#selected)?.replaceChildren(this.#mirror, editor)
      this.#fit()
      if (focused && document.activeElement !== editor) {
        editor.focus()
        editor.setSelectionRange(selectionStart, selectionEnd)
      }
    }
    this.#paintSelection(hadFocus)
    this.#paintPeers()
  }

  #paintSelection(focus: boolean): void {
    for (const el of this.#grid.querySelectorAll<HTMLElement>('[aria-selected="true"]')) {
      el.removeAttribute('aria-selected')
      el.tabIndex = -1
    }
    for (const el of this.#grid.querySelectorAll<HTMLElement>('[data-mark]')) {
      delete el.dataset.mark
    }
    const at = this.#selected
    if (at) {
      // The headers of the cursor light up; a whole row or column is filled in.
      const rowHead = this.#grid.querySelector<HTMLElement>(`[data-head-row="${at.row}"]`)
      const colHead = this.#grid.querySelector<HTMLElement>(`[data-head-col="${at.col}"]`)
      if (rowHead) rowHead.dataset.mark = this.#span === 'row' ? 'selected' : 'active'
      if (colHead) colHead.dataset.mark = this.#span === 'column' ? 'selected' : 'active'
      if (this.#span === 'column') {
        for (const head of this.#grid.querySelectorAll<HTMLElement>('[data-head-row]')) {
          head.dataset.mark = 'active'
        }
      }
      if (this.#span === 'row') {
        for (const head of this.#grid.querySelectorAll<HTMLElement>('[data-head-col]')) {
          head.dataset.mark = 'active'
        }
      }
      const span =
        this.#span === 'row'
          ? `td[data-row="${at.row}"]`
          : this.#span === 'column'
            ? `td[data-col="${at.col}"]`
            : null
      if (span) {
        for (const el of this.#grid.querySelectorAll<HTMLElement>(span)) el.dataset.mark = 'span'
      }
    }
    const cell = at ? this.#cellElement(at) : null
    // Keeps the grid reachable with Tab even before anything was selected.
    const target = cell ?? this.#grid.querySelector<HTMLElement>('[data-row]')
    if (target) target.tabIndex = 0
    if (cell) {
      cell.setAttribute('aria-selected', 'true')
      if (focus && !this.#editor) cell.focus()
      cell.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    }
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

  #targetOf(target: EventTarget | null): Target | null {
    const el = (target as HTMLElement | null)?.closest?.<HTMLElement>(
      '[data-row], [data-head-row], [data-head-col]',
    )
    if (!el || !this.#grid.contains(el)) return null
    if (el.dataset.headRow !== undefined) return { kind: 'row', row: Number(el.dataset.headRow) }
    if (el.dataset.headCol !== undefined) return { kind: 'column', col: Number(el.dataset.headCol) }
    return { kind: 'cell', at: { row: Number(el.dataset.row), col: Number(el.dataset.col) } }
  }

  #positionOf(target: EventTarget | null): Position | null {
    const cell = (target as HTMLElement | null)?.closest?.<HTMLElement>('[data-row]')
    if (!cell || !this.#grid.contains(cell)) return null
    return { row: Number(cell.dataset.row), col: Number(cell.dataset.col) }
  }

  #onClick(ev: MouseEvent): void {
    if (this.#swallowClick) {
      this.#swallowClick = false
      return
    }
    if ((ev.target as HTMLElement).closest('.cell-editor')) return
    const target = this.#targetOf(ev.target)
    if (target?.kind === 'row') {
      this.select({ row: target.row, col: this.#selected?.col ?? 0 }, true, 'row')
      return
    }
    if (target?.kind === 'column') {
      this.select({ row: this.#selected?.row ?? 0, col: target.col }, true, 'column')
      return
    }
    const at = this.#positionOf(ev.target)
    if (!at) return
    const again =
      this.#span === 'cell' && this.#selected?.row === at.row && this.#selected.col === at.col
    // A mouse edits on a double-click, as in a spreadsheet. A second tap edits
    // on a touch screen, where a double tap may zoom instead.
    if (again && this.#pointer === 'touch') this.edit(at)
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
    // Google Sheets' keys: with a whole row or column selected, Ctrl+Alt+=
    // inserts one before it and Ctrl+Alt+- deletes it (⌘⌥ on a Mac). On a single
    // cell Sheets asks what to insert, so they do nothing here. The codes
    // survive ⌥ changing the character.
    if (mod && ev.altKey && (ev.code === 'Equal' || ev.code === 'Minus')) {
      ev.preventDefault()
      if (this.#span === 'cell') return
      const column = this.#span === 'column'
      if (ev.code === 'Equal') {
        if (column) this.insertColumn('left')
        else this.insertRow('above')
      } else if (column) this.deleteColumn()
      else this.deleteRow()
      return
    }
    if (ev.key === ' ' && (ev.shiftKey || ev.ctrlKey) && !ev.metaKey && !ev.altKey) {
      ev.preventDefault()
      this.select({ row, col }, true, ev.shiftKey ? 'row' : 'column')
      return
    }
    if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) {
      ev.preventDefault()
      const rect = this.#cellElement({ row, col })?.getBoundingClientRect()
      const target: Target =
        this.#span === 'row'
          ? { kind: 'row', row }
          : this.#span === 'column'
            ? { kind: 'column', col }
            : { kind: 'cell', at: { row, col } }
      this.openMenu(target, rect?.left ?? 0, rect?.bottom ?? 0)
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
      this.#clear()
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
    // A line break inside the cell: Alt+Enter or Ctrl/⌘+Enter, as in Google Sheets.
    if (ev.key === 'Enter' && (ev.altKey || mod)) {
      ev.preventDefault()
      const editor = ev.target as HTMLTextAreaElement
      editor.setRangeText('\n', editor.selectionStart, editor.selectionEnd, 'end')
      this.#write(editor.value)
      this.#fit()
      return
    }
    if (ev.key === 'Escape') {
      // As in a spreadsheet, Escape drops the edit: the cell gets back the
      // value it had when the edit began.
      ev.preventDefault()
      this.#write(this.#original)
      this.#finishEdit(true)
      this.select(at)
      return
    }
    const next =
      ev.key === 'Enter'
        ? { row: Math.max(0, at.row + (ev.shiftKey ? -1 : 1)), col: at.col }
        : ev.key === 'Tab'
          ? { row: at.row, col: Math.max(0, at.col + (ev.shiftKey ? -1 : 1)) }
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
    this.#mirror.remove()
    this.#dirty = true
    if (this.#active) this.#render()
    if (focus) this.#paintSelection(true)
  }

  /** Sizes the cell to the text being typed; the editor fills the cell. */
  #fit(): void {
    const editor = this.#editor
    if (!editor) return
    // The zero-width space keeps a trailing line break's empty line.
    this.#mirror.textContent = `${editor.value}\u200b`
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
