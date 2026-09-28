import { describe, expect, it } from 'vitest'
import {
  type Attachment,
  decodeAttachment,
  encodeAttachment,
  MAX_WANT_HASHES,
  UnknownAttachmentKindError,
} from '../src/index.ts'

const hashA = '0123456789abcdef0123456789abcdef'
const hashB = 'fedcba9876543210fedcba9876543210'
const bytes = (s: string) => [...new TextEncoder().encode(s)]

describe('attachment', () => {
  it('round-trips every kind', () => {
    const all: Attachment[] = [
      { kind: 'announce', hash: hashA, mime: 'image/png' },
      { kind: 'want', hashes: [hashA, hashB] },
      { kind: 'stored', hash: hashA, path: 'assets/居間.png' },
      { kind: 'rejected', hash: hashA, reason: 'too_large' },
    ]
    for (const a of all) expect(decodeAttachment(encodeAttachment(a))).toEqual(a)
  })

  // Pins the layout, which internal/protocol/attachment_test.go pins too.
  it('uses the shared layout', () => {
    const data = encodeAttachment({ kind: 'stored', hash: hashA, path: 'a.png' })
    expect([...data]).toEqual([2, 32, ...bytes(hashA), 5, ...bytes('a.png')])
  })

  it('refuses to encode invalid messages', () => {
    const invalid = [
      { kind: 'announce', hash: 'ABC', mime: 'image/png' },
      { kind: 'announce', hash: hashA, mime: '' },
      { kind: 'want', hashes: [] },
      { kind: 'want', hashes: [hashA, 'nope'] },
      { kind: 'want', hashes: Array(MAX_WANT_HASHES + 1).fill(hashA) },
      { kind: 'stored', hash: hashA, path: 'a'.repeat(1025) },
      // 64 characters, but more than 64 bytes of UTF-8.
      { kind: 'rejected', hash: hashA, reason: '居'.repeat(64) },
    ] as Attachment[]
    for (const a of invalid) expect(() => encodeAttachment(a), JSON.stringify(a)).toThrow()
  })

  it('refuses to decode malformed payloads', () => {
    const valid = encodeAttachment({ kind: 'announce', hash: hashA, mime: 'image/png' })
    const malformed: Record<string, number[]> = {
      empty: [],
      truncated: [...valid.subarray(0, -1)],
      trailing: [...valid, 0],
      'too many': [1, 0x81, 0x02], // 257 hashes
      'invalid utf-8': [3, 32, ...bytes(hashA), 2, 0xff, 0xfe],
    }
    for (const [name, data] of Object.entries(malformed)) {
      expect(() => decodeAttachment(new Uint8Array(data)), name).toThrow()
      expect(() => decodeAttachment(new Uint8Array(data)), name).not.toThrow(
        UnknownAttachmentKindError,
      )
    }
  })

  it('tells unknown kinds apart from malformed payloads', () => {
    expect(() => decodeAttachment(new Uint8Array([9]))).toThrow(UnknownAttachmentKindError)
  })
})
