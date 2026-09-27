// @vitest-environment jsdom
import { Compartment, type Extension, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { type CodeMirrorV, getCM, Vim } from '@replit/codemirror-vim'
import { basicSetup } from 'codemirror'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { loadVimMode, saveVimMode, VIM_KEY, VimToggle, vimExtension } from '../src/vim.ts'

function memoryStore(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }
}

const brokenStore = {
  getItem: (): string | null => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
}

describe('loadVimMode / saveVimMode', () => {
  it('is off by default', () => {
    expect(loadVimMode(memoryStore())).toBe(false)
    expect(loadVimMode(null)).toBe(false)
  })

  it('remembers the choice', () => {
    const store = memoryStore()
    saveVimMode(true, store)
    expect(store.data.get(VIM_KEY)).toBe('on')
    expect(loadVimMode(store)).toBe(true)
    saveVimMode(false, store)
    expect(loadVimMode(store)).toBe(false)
  })

  it('survives storage that throws', () => {
    expect(loadVimMode(brokenStore)).toBe(false)
    expect(() => saveVimMode(true, brokenStore)).not.toThrow()
  })
})

const views: EditorView[] = []
afterEach(() => {
  for (const v of views.splice(0)) v.destroy()
})

function setup(initial = 'hello') {
  const doc = new Y.Doc()
  const text = doc.getText('content')
  const undoManager = new Y.UndoManager(text)
  const vimMode = new Compartment()
  const view = new EditorView({
    parent: document.body.appendChild(document.createElement('div')),
    extensions: [
      vimMode.of([]),
      basicSetup,
      Prec.high(keymap.of(yUndoManagerKeymap)),
      yCollab(text, new Awareness(doc), { undoManager }),
    ],
  })
  views.push(view)
  // Arrives like the host's content does: through Yjs, not undoable here.
  doc.transact(() => text.insert(0, initial), 'remote')
  return { doc, text, undoManager, vimMode, view }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('VimToggle', () => {
  it('switches Vim on and off without touching the text, and remembers it', async () => {
    const { text, undoManager, vimMode, view } = setup('shared text')
    const store = memoryStore()
    const toggle = new VimToggle(view, vimMode, () => vimExtension(undoManager), store)

    expect(await toggle.set(true)).toBe(true)
    expect(toggle.on).toBe(true)
    expect(getCM(view)).not.toBeNull()
    expect(store.data.get(VIM_KEY)).toBe('on')
    expect(view.state.doc.toString()).toBe('shared text')
    expect(text.toString()).toBe('shared text')

    expect(await toggle.set(false)).toBe(true)
    expect(getCM(view)).toBeNull()
    expect(store.data.get(VIM_KEY)).toBe('off')
    expect(view.state.doc.toString()).toBe('shared text')
    expect(text.toString()).toBe('shared text')
  })

  it('keeps the latest choice when toggled while the keymap loads', async () => {
    const { vimMode, view } = setup()
    const store = memoryStore()
    const load = deferred<Extension>()
    const toggle = new VimToggle(view, vimMode, () => load.promise, store)

    const on = toggle.set(true)
    await toggle.set(false)
    load.resolve([])
    await on
    expect(toggle.on).toBe(false)
    expect(store.data.get(VIM_KEY)).toBe('off')
  })

  it('stays off when the keymap cannot be loaded', async () => {
    const { vimMode, view } = setup()
    const store = memoryStore()
    const toggle = new VimToggle(view, vimMode, () => Promise.reject(new Error('offline')), store)

    expect(await toggle.set(true)).toBe(false)
    expect(toggle.on).toBe(false)
    expect(store.data.has(VIM_KEY)).toBe(false)
  })
})

// Vim on, with a local edit made in the editor and a remote one arrived through Yjs.
async function withLocalAndRemoteEdit() {
  const { doc, text, undoManager, vimMode, view } = setup('')
  await new VimToggle(view, vimMode, () => vimExtension(undoManager), memoryStore()).set(true)
  const cm = getCM(view) as CodeMirrorV | null
  if (!cm) throw new Error('Vim is not active')

  view.dispatch({ changes: { from: 0, insert: 'mine ' } })
  const remote = new Y.Doc()
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc))
  remote.getText('content').insert(5, 'theirs')
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)), 'remote')
  expect(text.toString()).toBe('mine theirs')
  return { cm, text, view }
}

describe('vimExtension', () => {
  it('undoes and redoes with the shared UndoManager, leaving remote edits alone', async () => {
    const { cm, text, view } = await withLocalAndRemoteEdit()

    Vim.handleKey(cm, 'u', 'user')
    expect(text.toString()).toBe('theirs')
    expect(view.state.doc.toString()).toBe('theirs')

    Vim.handleKey(cm, '<C-r>', 'user')
    expect(text.toString()).toBe('mine theirs')
  })

  it.each([
    ['u', 'red'],
    ['undo', 'redo'],
  ])('routes :%s and :%s through the shared UndoManager too', async (undo, redo) => {
    const { cm, text } = await withLocalAndRemoteEdit()

    Vim.handleEx(cm, undo)
    expect(text.toString()).toBe('theirs')

    Vim.handleEx(cm, redo)
    expect(text.toString()).toBe('mine theirs')
  })
})

function pressTab(view: EditorView, shiftKey = false): boolean {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    code: 'Tab',
    keyCode: 9,
    shiftKey,
    bubbles: true,
    cancelable: true,
  })
  view.contentDOM.dispatchEvent(event)
  return event.defaultPrevented
}

describe('Tab in Vim mode', () => {
  it('indents and dedents in insert mode instead of moving focus', async () => {
    const { undoManager, vimMode, view } = setup('line')
    await new VimToggle(view, vimMode, () => vimExtension(undoManager), memoryStore()).set(true)
    const cm = getCM(view) as CodeMirrorV
    Vim.handleKey(cm, 'i', 'user')

    expect(pressTab(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('  line')

    expect(pressTab(view, true)).toBe(true)
    expect(view.state.doc.toString()).toBe('line')
  })

  it('indents the line in normal mode', async () => {
    const { undoManager, vimMode, view } = setup('line')
    await new VimToggle(view, vimMode, () => vimExtension(undoManager), memoryStore()).set(true)

    expect(pressTab(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('  line')
  })

  it('leaves Tab to the browser when Vim is off', () => {
    const { view } = setup('line')

    expect(pressTab(view)).toBe(false)
    expect(view.state.doc.toString()).toBe('line')
  })
})

describe('the empty line after a trailing newline', () => {
  async function vimOn(initial: string) {
    const { undoManager, vimMode, view } = setup(initial)
    await new VimToggle(view, vimMode, () => vimExtension(undoManager), memoryStore()).set(true)
    const cm = getCM(view) as CodeMirrorV
    const keys = (...ks: string[]) => {
      for (const k of ks) Vim.handleKey(cm, k, 'user')
    }
    const line = () => view.state.doc.lineAt(view.state.selection.main.head).number
    return { keys, line, view }
  }

  it('is skipped by dd on the last line, so p puts the line back', async () => {
    const { keys, line, view } = await vimOn('aaa\nbbb\n  ccc\n')
    keys('3', 'G', 'd', 'd')
    expect(view.state.doc.toString()).toBe('aaa\nbbb\n')
    expect(line()).toBe(2)

    keys('p')
    expect(view.state.doc.toString()).toBe('aaa\nbbb\n  ccc\n')
  })

  it('is skipped by G', async () => {
    const { keys, line } = await vimOn('aaa\n  bbb\n')
    keys('G')
    expect(line()).toBe(2)
  })

  it('leaves dd and p in the middle alone', async () => {
    const { keys, view } = await vimOn('aaa\nbbb\nccc\n')
    keys('d', 'd', 'p')
    expect(view.state.doc.toString()).toBe('bbb\naaa\nccc\n')
  })

  it('still lets insert mode reach the end', async () => {
    const { keys, line } = await vimOn('aaa\n')
    keys('G', 'o')
    expect(line()).toBe(2)
    keys('<Esc>')
    expect(line()).toBe(2)
  })

  it('treats a newline added at the end as the end of the file', async () => {
    // Without a trailing newline, `o` on the last line adds one, and the new
    // empty line is then the one Vim does not have.
    const { keys, line, view } = await vimOn('aaa')
    keys('G', 'o', '<Esc>')
    await Promise.resolve()
    expect(view.state.doc.toString()).toBe('aaa\n')
    expect(line()).toBe(1)
  })

  it('is skipped after a click too, once the view has updated', async () => {
    const { line, view } = await vimOn('aaa\n  bbb\n')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      view.dispatch({ selection: { anchor: view.state.doc.length }, userEvent: 'select.pointer' })
      await Promise.resolve()
      expect(error).not.toHaveBeenCalled()
      expect(line()).toBe(2)
    } finally {
      error.mockRestore()
    }
  })

  it('keeps a real empty last line reachable', async () => {
    const { keys, line } = await vimOn('aaa\n\n')
    keys('G')
    expect(line()).toBe(2)
  })

  it('leaves files without a trailing newline alone', async () => {
    const { keys, line } = await vimOn('aaa\n  bbb')
    keys('G')
    expect(line()).toBe(2)
  })
})

describe('deleting the last line of a file without a trailing newline', () => {
  async function run(initial: string, ...ks: string[]) {
    const { undoManager, vimMode, view } = setup(initial)
    await new VimToggle(view, vimMode, () => vimExtension(undoManager), memoryStore()).set(true)
    const cm = getCM(view) as CodeMirrorV
    for (const k of ks) Vim.handleKey(cm, k, 'user')
    return { register: Vim.getRegisterController().getRegister('"').toString(), view }
  }

  it.each([
    ['dd then p', 'aaa\nbbb', ['G', 'd', 'd', 'p']],
    ['dd then P', 'aaa\nbbb', ['G', 'd', 'd', 'P'], 'bbb\naaa'],
    ['Vd then p', 'aaa\nbbb', ['G', 'V', 'd', 'p']],
    ['dd after an empty line', 'aaa\n\nbbb', ['G', 'd', 'd', 'p']],
    ['dd after an empty first line', '\nbbb', ['G', 'd', 'd', 'p']],
  ])(
    'puts the line back without an empty line: %s',
    async (_, initial, keys, expected = initial) => {
      const { view } = await run(initial, ...keys)
      expect(view.state.doc.toString()).toBe(expected)
    },
  )

  it('stores the line as a plain line', async () => {
    const { register, view } = await run('aaa\nbbb', 'G', 'd', 'd')
    expect(view.state.doc.toString()).toBe('aaa')
    expect(register).toBe('bbb\n')
  })

  it.each([
    ['an empty line', 'aaa\n\nbbb', ['2', 'G', 'd', 'd'], '\n'],
    ['two lines from an empty one', 'aaa\n\nx\nccc', ['2', 'G', '2', 'd', 'd'], '\nx\n'],
    ['a yanked last line', 'aaa\nbbb', ['G', 'y', 'y'], 'bbb\n'],
    ['2yy from an empty line to the end', 'aaa\n\nccc', ['2', 'G', '2', 'y', 'y'], '\nccc\n'],
    ['2dd from an empty line to the end', 'aaa\n\nccc', ['2', 'G', '2', 'd', 'd'], '\nccc\n'],
    ['yG from an empty first line', '\nbbb', ['g', 'g', 'y', 'G'], '\nbbb\n'],
    ['dG from an empty first line', '\nbbb', ['g', 'g', 'd', 'G'], '\nbbb\n'],
    ['VGd from an empty line to the end', 'aaa\n\nccc', ['2', 'G', 'V', 'G', 'd'], '\nccc\n'],
  ])('leaves other line registers alone: %s', async (_, initial, keys, expected) => {
    const { register } = await run(initial, ...keys)
    expect(register).toBe(expected)
  })
})
