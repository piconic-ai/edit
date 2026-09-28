import { describe, expect, it } from 'vitest'
import { decodeMessage, encodeMessage, MessageType, UnknownMessageTypeError } from '../src/index.ts'

describe('message', () => {
  it('prefixes the payload with its type', () => {
    const payload = new Uint8Array([9, 8, 7])
    const sync = encodeMessage(MessageType.Sync, payload)
    expect([...sync]).toEqual([0, 9, 8, 7])
    expect(decodeMessage(sync)).toEqual({ type: MessageType.Sync, payload })

    const awareness = encodeMessage(MessageType.Awareness, payload)
    expect(decodeMessage(awareness).type).toBe(MessageType.Awareness)

    const attachment = encodeMessage(MessageType.Attachment, payload)
    expect(decodeMessage(attachment).type).toBe(MessageType.Attachment)
  })

  it('tells unknown types apart from malformed messages', () => {
    expect(() => decodeMessage(new Uint8Array([7, 1]))).toThrow(UnknownMessageTypeError)
    expect(() => decodeMessage(new Uint8Array([]))).toThrow()
    expect(() => decodeMessage(new Uint8Array([]))).not.toThrow(UnknownMessageTypeError)
  })
})
