// @vitest-environment jsdom
import { Compartment, type Extension, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { type CodeMirrorV, getCM, Vim } from '@replit/codemirror-vim'
import { basicSetup } from 'codemirror'
import { afterEach, describe, expect, it } from 'vitest'
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
