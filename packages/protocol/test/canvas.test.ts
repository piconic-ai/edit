import { describe, expect, it } from 'vitest'
import {
  type CanvasMessage,
  decodeCanvas,
  encodeCanvas,
  MAX_CANVAS_EDIT_BYTES,
  UnknownCanvasKindError,
} from '../src/index.ts'

const bytes = (s: string) => [...new TextEncoder().encode(s)]

describe('canvas', () => {
  it('round-trips every kind', () => {
    const all: CanvasMessage[] = [
      { kind: 'edit', id: 'e1', base: '{"nodes":[]}', next: '{"nodes":[{"id":"居間"}]}' },
      { kind: 'edit', id: 'e2', base: '', next: '' },
      { kind: 'applied', id: 'e1' },
      { kind: 'rejected', id: 'e1', reason: 'board.canvas:1:2: nodes[0]: has no "x"' },
    ]
    for (const m of all) expect(decodeCanvas(encodeCanvas(m))).toEqual(m)
  })

  // Pins the layout, which internal/protocol/canvas_test.go pins too.
  it('uses the shared layout', () => {
    const data = encodeCanvas({ kind: 'edit', id: 'e', base: '{}', next: 'x' })
    expect([...data]).toEqual([0, 1, ...bytes('e'), 2, ...bytes('{}'), 1, ...bytes('x')])
  })

  it('refuses to encode invalid messages', () => {
    const half = 'x'.repeat(MAX_CANVAS_EDIT_BYTES / 2 + 1)
    const invalid = [
      { kind: 'applied', id: '' },
      // 22 characters, but more than 64 bytes of UTF-8.
      { kind: 'applied', id: '居'.repeat(22) },
      { kind: 'edit', id: 'e', base: half, next: half },
      { kind: 'rejected', id: 'e', reason: '' },
    ] as CanvasMessage[]
    for (const m of invalid) expect(() => encodeCanvas(m), JSON.stringify(m).slice(0, 80)).toThrow()
  })

  it('rejects malformed payloads', () => {
    const valid = encodeCanvas({ kind: 'edit', id: 'e', base: 'a', next: 'b' })
    for (const data of [
      new Uint8Array(),
      valid.subarray(0, valid.length - 1),
      new Uint8Array([...valid, 0]),
      new Uint8Array([1, 1, 0xff]),
    ]) {
      expect(() => decodeCanvas(data)).toThrow()
    }
    expect(() => decodeCanvas(new Uint8Array([9, 1, 101]))).toThrow(UnknownCanvasKindError)
  })
})
