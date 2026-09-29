import { describe, expect, it } from 'vitest'
import { peersOf, presenceOf, sameNodePeers, samePresence } from '../src/presence.ts'

describe('presenceOf', () => {
  it('reads what a peer shares', () => {
    expect(
      presenceOf({ selected: ['a', 'b'], editing: 'a', dragging: { id: 'b', x: 1.5, y: -2 } }),
    ).toEqual({ selected: ['a', 'b'], editing: 'a', dragging: { id: 'b', x: 1.5, y: -2 } })
  })

  it('leaves out what is not the right shape', () => {
    expect(presenceOf(null)).toBeNull()
    expect(presenceOf('x')).toBeNull()
    expect(
      presenceOf({
        selected: ['a', 3, '', 'x'.repeat(65), { id: 'b' }],
        editing: 7,
        dragging: { id: 'b', x: Number.NaN, y: 0 },
      }),
    ).toEqual({ selected: ['a'] })
    expect(presenceOf({ selected: 'a', dragging: { id: 'b', x: 1 } })).toEqual({ selected: [] })
    expect(presenceOf({ selected: Array(300).fill('a') })?.selected).toHaveLength(256)
  })
})

describe('peersOf', () => {
  const user = (name: string, color: string) => ({ user: { name, color } })

  it('gathers others by node, and their drags, but not this browser', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, { ...user('Me', '#111111'), canvas: { selected: ['a'] } }],
      [
        2,
        {
          ...user('Ann', '#1f7a64'),
          canvas: { selected: ['a', 'b'], dragging: { id: 'b', x: 5, y: 6 } },
        },
      ],
      [3, { ...user('Bo', '#4254b5'), canvas: { selected: [], editing: 'a' } }],
      [4, { ...user('Cy', '#aa3355') }],
    ])
    const peers = peersOf(states, 1)
    expect(peers.nodes).toEqual({
      a: { names: 'Ann, Bo', color: '#1f7a64' },
      b: { names: 'Ann', color: '#1f7a64' },
    })
    expect(peers.ghosts).toEqual([{ id: 'b', x: 5, y: 6, name: 'Ann', color: '#1f7a64' }])
  })

  it('never passes on a colour that is not hex', () => {
    const states = new Map<number, Record<string, unknown>>([
      [2, { user: { name: 'Ann', color: 'red; background: url(x)' }, canvas: { selected: ['a'] } }],
    ])
    expect(peersOf(states, 1).nodes.a?.color).toMatch(/^#[0-9a-f]+$/i)
  })
})

describe('samePresence / sameNodePeers', () => {
  it('compare by value', () => {
    expect(samePresence({ selected: ['a'] }, { selected: ['a'] })).toBe(true)
    expect(samePresence({ selected: ['a'] }, { selected: ['a'], editing: 'a' })).toBe(false)
    expect(
      samePresence(
        { selected: [], dragging: { id: 'a', x: 1, y: 1 } },
        { selected: [], dragging: { id: 'a', x: 1, y: 2 } },
      ),
    ).toBe(false)
    expect(
      sameNodePeers({ a: { names: 'A', color: '#111' } }, { a: { names: 'A', color: '#111' } }),
    ).toBe(true)
    expect(sameNodePeers({ a: { names: 'A', color: '#111' } }, {})).toBe(false)
  })
})
