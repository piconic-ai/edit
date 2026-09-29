import { getBezierPath, Position } from '@barefootjs/xyflow'
import type { CanvasEdge, CanvasNode, Side } from './canvas.ts'

const SVG = 'http://www.w3.org/2000/svg'

/** The id of the arrow <marker> CanvasBoard defines; it turns around at the start. */
export const ARROW = 'canvas-arrow'

/** Where a node is on the board now, which may be ahead of the document while dragged. */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

const POSITION: Record<Side, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
}

/**
 * The sides an edge leaves and enters by when the file does not say: the
 * ones facing each other, along the axis the nodes are further apart on.
 */
export function facingSides(from: Box, to: Box): [Side, Side] {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2)
  const dy = to.y + to.height / 2 - (from.y + from.height / 2)
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ['right', 'left'] : ['left', 'right']
  return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom']
}

/** The middle of a node's side, where JSON Canvas attaches an edge. */
export function anchor(box: Box, side: Side): { x: number; y: number } {
  switch (side) {
    case 'top':
      return { x: box.x + box.width / 2, y: box.y }
    case 'right':
      return { x: box.x + box.width, y: box.y + box.height / 2 }
    case 'bottom':
      return { x: box.x + box.width / 2, y: box.y + box.height }
    case 'left':
      return { x: box.x, y: box.y + box.height / 2 }
  }
}

/** An edge ready to draw. */
export interface EdgeShape {
  id: string
  d: string
  labelX: number
  labelY: number
  label: string
  color?: string
  arrowStart: boolean
  arrowEnd: boolean
  selected: boolean
}

/** Draws an edge as a curve between the middles of its sides. */
export function shapeOf(edge: CanvasEdge, from: Box, to: Box, selected: boolean): EdgeShape {
  // Sides the file leaves out are drawn facing each other, and not written back.
  const [fromFacing, toFacing] = facingSides(from, to)
  const fromSide = edge.fromSide ?? fromFacing
  const toSide = edge.toSide ?? toFacing
  const s = anchor(from, fromSide)
  const t = anchor(to, toSide)
  const [d, labelX, labelY] = getBezierPath({
    sourceX: s.x,
    sourceY: s.y,
    sourcePosition: POSITION[fromSide],
    targetX: t.x,
    targetY: t.y,
    targetPosition: POSITION[toSide],
  })
  return {
    id: edge.id,
    d,
    labelX,
    labelY,
    label: edge.label ?? '',
    color: edge.color,
    // The spec's defaults: no arrow at the start, an arrow at the end.
    arrowStart: edge.fromEnd === 'arrow',
    arrowEnd: (edge.toEnd ?? 'arrow') === 'arrow',
    selected,
  }
}

/** The shapes of every edge whose nodes are both on the board. */
export function shapesOf(
  edges: readonly CanvasEdge[],
  boxes: ReadonlyMap<string, Box>,
  selected: ReadonlySet<string>,
): EdgeShape[] {
  const out: EdgeShape[] = []
  for (const e of edges) {
    const from = boxes.get(e.fromNode)
    const to = boxes.get(e.toNode)
    if (from && to) out.push(shapeOf(e, from, to, selected.has(e.id)))
  }
  return out
}

interface Drawn {
  group: SVGGElement
  hit: SVGPathElement
  line: SVGPathElement
  text: SVGTextElement
}

const set = (el: Element, name: string, value: string | undefined) => {
  if (value === undefined) el.removeAttribute(name)
  else if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}

/**
 * Draws the edges into xyflow's edge layer, under the nodes and inside the
 * pan and zoom. It does so by hand rather than through xyflow's SimpleEdge:
 * rendered in the browser (CSR), a component whose root is an SVG element
 * inside an <svg> loop comes out in the HTML namespace and does not show.
 * The hit path carries no data-hit-id of its own (xyflow rewrites `d` on
 * path[data-hit-id] with geometry that does not know sides); the group does,
 * so a click on an edge is not taken for a click on the empty pane.
 */
export class EdgeLayer {
  #root: SVGGElement
  #drawn = new Map<string, Drawn>()
  #onSelect: (id: string) => void

  constructor(svg: SVGSVGElement, onSelect: (id: string) => void) {
    this.#root = document.createElementNS(SVG, 'g')
    this.#root.setAttribute('class', 'canvas-edges')
    svg.append(this.#root)
    this.#onSelect = onSelect
  }

  draw(shapes: readonly EdgeShape[]): void {
    const seen = new Set<string>()
    for (const shape of shapes) {
      seen.add(shape.id)
      const drawn = this.#drawn.get(shape.id) ?? this.#create(shape.id)
      set(
        drawn.group,
        'data-color',
        shape.color && /^[1-6]$/.test(shape.color) ? shape.color : undefined,
      )
      set(
        drawn.group,
        'style',
        shape.color && /^#[0-9a-f]{3,8}$/i.test(shape.color)
          ? `--card-color: ${shape.color}`
          : undefined,
      )
      set(drawn.group, 'data-selected', shape.selected ? '' : undefined)
      set(drawn.hit, 'd', shape.d)
      set(drawn.line, 'd', shape.d)
      set(drawn.line, 'marker-start', shape.arrowStart ? `url(#${ARROW})` : undefined)
      set(drawn.line, 'marker-end', shape.arrowEnd ? `url(#${ARROW})` : undefined)
      set(drawn.text, 'x', String(shape.labelX))
      set(drawn.text, 'y', String(shape.labelY))
      if (drawn.text.textContent !== shape.label) drawn.text.textContent = shape.label
    }
    for (const [id, drawn] of this.#drawn) {
      if (!seen.has(id)) {
        drawn.group.remove()
        this.#drawn.delete(id)
      }
    }
  }

  #create(id: string): Drawn {
    const group = document.createElementNS(SVG, 'g')
    group.setAttribute('class', 'canvas-edge')
    group.setAttribute('data-hit-id', id)
    const hit = document.createElementNS(SVG, 'path')
    hit.setAttribute('class', 'canvas-edge-hit')
    hit.addEventListener('mousedown', (e) => {
      e.stopPropagation()
      this.#onSelect(id)
    })
    const line = document.createElementNS(SVG, 'path')
    line.setAttribute('class', 'canvas-edge-line')
    const text = document.createElementNS(SVG, 'text')
    text.setAttribute('class', 'canvas-edge-label')
    group.append(hit, line, text)
    this.#root.append(group)
    const drawn = { group, hit, line, text }
    this.#drawn.set(id, drawn)
    return drawn
  }

  destroy(): void {
    this.#root.remove()
    this.#drawn.clear()
  }
}

/** The board positions of the nodes, as `shapesOf` takes them. */
export function boxesOf(nodes: readonly CanvasNode[]): Map<string, Box> {
  return new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y, width: n.width, height: n.height }]))
}
