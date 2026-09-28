import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { HASH_PATTERN } from './blob.ts'

/**
 * Attachment messages coordinate images whose bytes travel through the server's
 * blob store, never through the relay:
 *
 * - announce: someone uploaded the attachment with this content hash
 * - want: someone needs these attachments and could not fetch them
 * - stored: the host wrote the attachment to `path`, relative to the shared file
 * - rejected: the host refused it, for `reason`
 */
export type Attachment =
  | { kind: 'announce'; hash: string; mime: string }
  | { kind: 'want'; hashes: string[] }
  | { kind: 'stored'; hash: string; path: string }
  | { kind: 'rejected'; hash: string; reason: string }

const KIND = { announce: 0, want: 1, stored: 2, rejected: 3 } as const

export const MAX_WANT_HASHES = 256
const MAX_MIME = 100
const MAX_PATH = 1024
const MAX_REASON = 64

const utf8 = new TextEncoder()
const fatalUtf8 = new TextDecoder('utf-8', { fatal: true })

export function encodeAttachment(a: Attachment): Uint8Array {
  validate(a)
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, KIND[a.kind])
  switch (a.kind) {
    case 'announce':
      encoding.writeVarString(encoder, a.hash)
      encoding.writeVarString(encoder, a.mime)
      break
    case 'want':
      encoding.writeVarUint(encoder, a.hashes.length)
      for (const hash of a.hashes) encoding.writeVarString(encoder, hash)
      break
    case 'stored':
      encoding.writeVarString(encoder, a.hash)
      encoding.writeVarString(encoder, a.path)
      break
    case 'rejected':
      encoding.writeVarString(encoder, a.hash)
      encoding.writeVarString(encoder, a.reason)
      break
  }
  return encoding.toUint8Array(encoder)
}

/** Throws on malformed payloads and on kinds this version does not know. */
export function decodeAttachment(payload: Uint8Array): Attachment {
  // lib0 can read past the end without complaint, so check around every read.
  const decoder = decoding.createDecoder(payload)
  const read = <T>(fn: () => T): T => {
    if (decoder.pos >= payload.length) throw new Error('truncated attachment message')
    const value = fn()
    if (decoder.pos > payload.length) throw new Error('truncated attachment message')
    return value
  }
  const uint = () => read(() => decoding.readVarUint(decoder))
  const str = () => fatalUtf8.decode(read(() => decoding.readVarUint8Array(decoder)))

  let a: Attachment
  const kind = uint()
  switch (kind) {
    case KIND.announce:
      a = { kind: 'announce', hash: str(), mime: str() }
      break
    case KIND.want: {
      const count = uint()
      if (count > MAX_WANT_HASHES) throw new Error('too many hashes')
      const hashes: string[] = []
      for (let i = 0; i < count; i++) hashes.push(str())
      a = { kind: 'want', hashes }
      break
    }
    case KIND.stored:
      a = { kind: 'stored', hash: str(), path: str() }
      break
    case KIND.rejected:
      a = { kind: 'rejected', hash: str(), reason: str() }
      break
    default:
      throw new Error(`unknown attachment kind: ${kind}`)
  }
  if (decoder.pos !== payload.length) throw new Error('trailing bytes in attachment message')
  validate(a)
  return a
}

function validate(a: Attachment): void {
  const hash = (h: string) => {
    if (!HASH_PATTERN.test(h)) throw new Error(`invalid content hash: ${h}`)
  }
  // Limits count UTF-8 bytes, as the Go side does.
  const text = (s: string, max: number, what: string) => {
    const bytes = utf8.encode(s).length
    if (bytes === 0 || bytes > max) throw new Error(`invalid ${what}`)
  }
  switch (a.kind) {
    case 'announce':
      hash(a.hash)
      text(a.mime, MAX_MIME, 'mime type')
      break
    case 'want':
      if (a.hashes.length === 0 || a.hashes.length > MAX_WANT_HASHES) {
        throw new Error('invalid hash count')
      }
      a.hashes.forEach(hash)
      break
    case 'stored':
      hash(a.hash)
      text(a.path, MAX_PATH, 'path')
      break
    case 'rejected':
      hash(a.hash)
      text(a.reason, MAX_REASON, 'reason')
      break
  }
}
