// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { CanvasEdge } from '../src/canvas.ts'
import { anchor, type Box, EdgeLayer, facingSides, shapeOf, shapesOf } from '../src/edges.ts'

const box = (x: number, y: number, width = 100, height = 50): Box => ({ x, y, width, height })
const edge = (extra: Partial<CanvasEdge> = {}): CanvasEdge => ({
  id: 'e',
  fromNode: 'a',
  toNode: 'b',
  ...extra,
})

describe('facingSides', () => {
  it.each([
    [box(300, 0), ['right', 'left']],
    [box(-300, 0), ['left', 'right']],
    [box(0, 300), ['bottom', 'top']],
    [box(0, -300), ['top', 'bottom']],
    // Further apart across than down: sideways.
    [box(200, 150), ['right', 'left']],
  ])('to %j -> %j', (to, sides) => {
    expect(facingSides(box(0, 0), to)).toEqual(sides)
  })
})

describe('anchor', () => {
  it('is the middle of a side', () => {
    const b = box(10, 20, 100, 50)
    expect(anchor(b, 'top')).toEqual({ x: 60, y: 20 })
    expect(anchor(b, 'right')).toEqual({ x: 110, y: 45 })
    expect(anchor(b, 'bottom')).toEqual({ x: 60, y: 70 })
    expect(anchor(b, 'left')).toEqual({ x: 10, y: 45 })
  })
})

describe('shapeOf', () => {
  it('runs between the sides the file names, with square bends', () => {
    const s = shapeOf(edge({ fromSide: 'bottom', toSide: 'top' }), box(0, 0), box(300, 0), false)
    // Straight out of the bottom and into the top, with square bends: xyflow's
    // zero-radius bends are degenerate Qs whose control point is the corner.
    expect(s.d).toBe(
      'M50 50L 50,74Q 50,74 50,74L 200,74Q 200,74 200,74L 200,-24Q 200,-24 200,-24L 350,-24Q 350,-24 350,-24L350 0',
    )
  })

  it('faces the nodes when the file names no sides', () => {
    const s = shapeOf(edge(), box(0, 0), box(300, 0), false)
    expect(s.d).toMatch(/^M100 25L.*300 25$/)
  })

  it('has the spec defaults for ends, and the label and colour', () => {
    expect(shapeOf(edge(), box(0, 0), box(300, 0), false)).toMatchObject({
      arrowStart: false,
      arrowEnd: true,
      label: '',
    })
    expect(
      shapeOf(
        edge({ fromEnd: 'arrow', toEnd: 'none', label: 'uses', color: '2' }),
        box(0, 0),
        box(300, 0),
        true,
      ),
    ).toMatchObject({
      arrowStart: true,
      arrowEnd: false,
      label: 'uses',
      color: '2',
      selected: true,
    })
  })
})

describe('shapesOf', () => {
  it('skips edges whose nodes are not on the board', () => {
    const boxes = new Map([
      ['a', box(0, 0)],
      ['b', box(300, 0)],
    ])
    const shapes = shapesOf([edge(), edge({ id: 'gone', toNode: 'zz' })], boxes, new Set(['e']))
    expect(shapes.map((s) => [s.id, s.selected])).toEqual([['e', true]])
  })
})

describe('EdgeLayer', () => {
  let svg: SVGSVGElement
  afterEach(() => svg.remove())

  function setup() {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    document.body.append(svg)
    const selected: string[] = []
    const layer = new EdgeLayer(svg, (id) => selected.push(id))
    return { layer, selected }
  }

  it('draws SVG groups, updates them in place and removes the gone', () => {
    const { layer } = setup()
    const boxes = new Map([
      ['a', box(0, 0)],
      ['b', box(300, 0)],
    ])
    layer.draw(shapesOf([edge({ label: 'uses', color: '1' })], boxes, new Set()))
    const group = svg.querySelector<SVGGElement>('.canvas-edge')
    expect(group?.namespaceURI).toBe('http://www.w3.org/2000/svg')
    expect(group?.getAttribute('data-hit-id')).toBe('e')
    expect(group?.getAttribute('data-color')).toBe('1')
    expect(group?.querySelector('.canvas-edge-line')?.getAttribute('marker-end')).toBe(
      'url(#canvas-arrow)',
    )
    expect(group?.querySelector('.canvas-edge-line')?.hasAttribute('marker-start')).toBe(false)
    expect(group?.querySelector('text')?.textContent).toBe('uses')
    // xyflow rewrites `d` on path[data-hit-id]: no path may carry it.
    expect(svg.querySelectorAll('path[data-hit-id], path[data-id]')).toHaveLength(0)

    layer.draw(
      shapesOf(
        [edge({ color: '#ff0000' })],
        new Map([...boxes, ['b', box(0, 300)]]),
        new Set(['e']),
      ),
    )
    expect(svg.querySelector('.canvas-edge')).toBe(group)
    expect(group?.hasAttribute('data-color')).toBe(false)
    expect(group?.getAttribute('style')).toBe('--card-color: #ff0000')
    expect(group?.hasAttribute('data-selected')).toBe(true)
    expect(group?.querySelector('.canvas-edge-line')?.getAttribute('d')).toMatch(/^M50 50L/)

    layer.draw([])
    expect(svg.querySelectorAll('.canvas-edge')).toHaveLength(0)
  })

  it('keeps colours that are not presets or hex out of the markup', () => {
    const { layer } = setup()
    const boxes = new Map([
      ['a', box(0, 0)],
      ['b', box(300, 0)],
    ])
    layer.draw(shapesOf([edge({ color: 'red; background: url(x)' })], boxes, new Set()))
    const group = svg.querySelector('.canvas-edge')
    expect(group?.hasAttribute('style')).toBe(false)
    expect(group?.hasAttribute('data-color')).toBe(false)
  })

  it('selects an edge pressed on', () => {
    const { layer, selected } = setup()
    layer.draw(
      shapesOf(
        [edge()],
        new Map([
          ['a', box(0, 0)],
          ['b', box(300, 0)],
        ]),
        new Set(),
      ),
    )
    svg
      .querySelector('.canvas-edge-hit')
      ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(selected).toEqual(['e'])
  })
})
