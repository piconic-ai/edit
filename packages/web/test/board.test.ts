// @vitest-environment jsdom
import type { InternalFlowStore } from '@barefootjs/xyflow'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { BoardView } from '../src/board.ts'
import { EDGES, NODES, read, TEXT } from '../src/canvas.ts'

beforeAll(() => {
  // jsdom has neither; xyflow measures with the first and the board waits on the second.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

const views: BoardView[] = []
afterEach(() => {
  for (const v of views.splice(0)) v.element.remove()
})

function docOf(nodes: object[], edges: object[] = []): Y.Doc {
  const doc = new Y.Doc()
  const map = (values: object) => {
    const m = new Y.Map<unknown>()
    for (const [k, v] of Object.entries(values)) {
      if (k === TEXT && typeof v === 'string') {
        const t = new Y.Text()
        t.insert(0, v)
        m.set(k, t)
      } else m.set(k, v)
    }
    return m
  }
  doc.getArray(NODES).push(nodes.map(map))
  doc.getArray(EDGES).push(edges.map(map))
  return doc
}

const node = (id: string, extra: object = {}) => ({
  id,
  type: 'text',
  text: id,
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  ...extra,
})

function setup(doc: Y.Doc) {
  const view = new BoardView(doc, new Awareness(doc))
  document.body.append(view.element)
  views.push(view)
  view.active = true
  return view
}

const tick = () => new Promise((r) => setTimeout(r, 20))

/** The flow's store, with the setters xyflow's own handlers use. */
const storeOf = (view: BoardView) => view.store as unknown as InternalFlowStore

const texts = (view: BoardView) =>
  [...view.element.querySelectorAll('.canvas-body')].map((b) => b.textContent)

/** A change made by someone else, arriving through the room. */
function remote(doc: Y.Doc, fn: () => void) {
  doc.transact(fn, 'remote')
}

function mapOf(doc: Y.Doc, id: string): Y.Map<unknown> {
  for (const item of doc.getArray(NODES)) {
    if (item instanceof Y.Map && item.get('id') === id) return item
  }
  throw new Error(`no node ${id}`)
}

describe('BoardView', () => {
  it('draws the nodes the document holds', async () => {
    const doc = docOf([node('a'), node('b', { type: 'file', file: 'b.md', x: 200 })])
    const view = setup(doc)
    await tick()
    const cards = [...view.element.querySelectorAll('.canvas-card')]
    expect(cards.map((c) => c.className)).toEqual([
      'canvas-card canvas-card--text',
      'canvas-card canvas-card--file',
    ])
    expect(cards.map((c) => c.querySelector('.canvas-body')?.textContent)).toEqual(['a', 'b.md'])
    expect(view.empty.get()).toBe(false)
  })

  it('follows changes others make, and skips what a file cannot hold', async () => {
    const doc = docOf(
      [node('a'), node('b', { x: 200 })],
      [{ id: 'ab', fromNode: 'a', toNode: 'b' }],
    )
    const view = setup(doc)
    await tick()
    expect(view.element.querySelectorAll('.bf-flow__edges .canvas-edge')).toHaveLength(1)

    remote(doc, () => {
      ;(mapOf(doc, 'a').get(TEXT) as Y.Text).insert(1, '!')
      mapOf(doc, 'b').set('width', 300)
      const broken = new Y.Map<unknown>()
      broken.set('id', 'c')
      doc.getArray(NODES).push([broken])
    })
    await tick()
    expect(texts(view)).toEqual(['a!', 'b'])
    expect(view.nodes.get('b')?.get().width).toBe(300)

    remote(doc, () => doc.getArray(NODES).delete(1, 1))
    await tick()
    expect(texts(view)).toEqual(['a!'])
    // The edge to the deleted node goes with it.
    expect(view.element.querySelectorAll('.bf-flow__edges .canvas-edge')).toHaveLength(0)
  })

  it('writes where a drag left the nodes once it ends', async () => {
    const doc = docOf([node('a'), node('b', { x: 200 })])
    const view = setup(doc)
    await tick()
    const store = storeOf(view)
    store.setDragging(true)
    store.setNodes((prev) =>
      prev.map((n) => (n.id === 'a' ? { ...n, position: { x: 40.4, y: 9.6 } } : n)),
    )
    // Someone else moves b meanwhile: a stays under the pointer, b moves.
    remote(doc, () => mapOf(doc, 'b').set('y', 70))
    await tick()
    const positions = () => Object.fromEntries(store.nodes().map((n) => [n.id, n.position]))
    expect(positions()).toEqual({ a: { x: 40.4, y: 9.6 }, b: { x: 200, y: 70 } })
    expect(read(doc).nodes[0]).toMatchObject({ x: 0, y: 0 })

    store.setDragging(false)
    await tick()
    expect(read(doc).nodes.map((n) => [n.id, n.x, n.y])).toEqual([
      ['a', 40, 10],
      ['b', 200, 70],
    ])
  })

  it('adds an edge from side to side, and not from a node to itself', async () => {
    const doc = docOf([node('a'), node('b', { x: 200 })])
    const view = setup(doc)
    await tick()
    view.onConnect({ source: 'a', target: 'b', sourceHandle: 'right', targetHandle: 'left' })
    view.onConnect({ source: 'a', target: 'a', sourceHandle: 'top', targetHandle: 'left' })
    view.onConnect({ source: 'b', target: 'a', sourceHandle: 'nowhere', targetHandle: null })
    const edges = read(doc).edges
    expect(edges.map(({ id: _, ...e }) => e)).toEqual([
      { fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left' },
      { fromNode: 'b', toNode: 'a' },
    ])
    expect(edges[0]?.id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('deletes what xyflow deletes, and undoes it', async () => {
    const doc = docOf(
      [node('a'), node('b', { x: 200 })],
      [{ id: 'ab', fromNode: 'a', toNode: 'b' }],
    )
    const view = setup(doc)
    await tick()
    const store = storeOf(view)
    view.onNodesDelete(store.nodes().filter((n) => n.id === 'a'))
    expect(read(doc)).toMatchObject({ nodes: [{ id: 'b' }], edges: [] })
    view.onKey(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))
    expect(read(doc).nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(read(doc).edges.map((e) => e.id)).toEqual(['ab'])
    view.onEdgesDelete(store.edges())
    expect(read(doc).edges).toEqual([])
    view.onKey(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true }))
    expect(read(doc).edges).toEqual([])
  })

  it('gives xyflow the edges only to select and delete', async () => {
    const doc = docOf(
      [node('a'), node('b', { x: 200 })],
      [{ id: 'ab', fromNode: 'a', toNode: 'b' }],
    )
    const view = setup(doc)
    await tick()
    expect(storeOf(view).edges()).toMatchObject([
      { id: 'ab', source: 'a', target: 'b', hidden: true },
    ])
    // xyflow's own SimpleEdge is not drawn; edges.ts draws instead.
    expect(view.element.querySelectorAll('[data-edge-id]')).toHaveLength(0)
  })

  it('adds a text node where the board is double-clicked, and types in a double-clicked one', async () => {
    const doc = docOf([node('a')])
    const view = setup(doc)
    await tick()
    const pane = view.element.querySelector('.canvas-view') as HTMLElement
    pane.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 500, clientY: 300 }))
    await tick()
    const added = read(doc).nodes[1]
    expect(added).toMatchObject({ type: 'text', text: '', width: 250, height: 60 })
    expect(view.editing.get()).toBe(added?.id)

    view.finishEditing()
    const card = view.element.querySelector(
      '.bf-flow__node[data-id="a"] .canvas-card',
    ) as HTMLElement
    card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(view.editing.get()).toBe('a')
    expect(card.dataset.editing).toBe('')
    expect(card.querySelector('.canvas-editor .cm-content')?.textContent).toBe('a')
    view.finishEditing()
    expect(card.querySelector('.cm-editor')).toBeNull()
  })

  it('changes nothing once the room has closed', async () => {
    const doc = docOf([node('a')])
    const view = setup(doc)
    await tick()
    view.readOnly = true
    const before = Y.encodeStateAsUpdate(doc)
    const pane = view.element.querySelector('.canvas-view') as HTMLElement
    pane.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 10, clientY: 10 }))
    view.edit('a')
    expect(view.editing.get()).toBeNull()
    expect(storeOf(view).nodesDraggable()).toBe(false)
    await tick()
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })
})
