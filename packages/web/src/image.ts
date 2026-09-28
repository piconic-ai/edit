/**
 * Readies a pasted or dropped image for the room: checks its type from its
 * bytes, drops metadata such as a photo's location without touching the
 * pixels, and shrinks it only when it is over the host's size limit.
 */

export type ImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

/** Why an image cannot be added. */
export class ImageError extends Error {
  readonly reason: 'type' | 'too_large' | 'unreadable'

  constructor(reason: ImageError['reason']) {
    super(`image rejected: ${reason}`)
    this.name = 'ImageError'
    this.reason = reason
  }
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  prefix.every((b, i) => bytes[at + i] === b)
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** The image type, read from the bytes. SVG and anything else is null. */
export function sniff(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, PNG)) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif'
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp'
  return null
}

/** Drops metadata losslessly. Throws ImageError('unreadable') on a malformed image. */
export function stripMetadata(bytes: Uint8Array, type: ImageType): Uint8Array {
  switch (type) {
    case 'image/jpeg':
      return stripJpeg(bytes)
    case 'image/png':
      return stripPng(bytes)
    case 'image/webp':
      return stripWebp(bytes)
    case 'image/gif':
      return bytes
  }
}

function unreadable(): never {
  throw new ImageError('unreadable')
}

// JPEG: a run of segments until the scan. APP1 holds EXIF (where a photo's
// location is) and XMP.
function stripJpeg(bytes: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [bytes.subarray(0, 2)]
  let i = 2
  for (;;) {
    if (bytes[i] !== 0xff) unreadable()
    const marker = bytes[i + 1]
    if (marker === undefined) unreadable()
    if (marker === 0xff) {
      i++ // fill byte
      continue
    }
    if (marker === 0xda || marker === 0xd9) {
      // Start of scan (or end of image): the rest is image data.
      out.push(bytes.subarray(i))
      break
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(bytes.subarray(i, i + 2))
      i += 2
      continue
    }
    const length = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0)
    if (length < 2 || i + 2 + length > bytes.length) unreadable()
    if (marker !== 0xe1) out.push(bytes.subarray(i, i + 2 + length))
    i += 2 + length
  }
  return concat(out)
}

// PNG: length, type, data and CRC per chunk, up to IEND. eXIf holds EXIF; the
// text chunks can hold XMP, comments and more; tIME is when it was last saved.
const PNG_METADATA = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME'])

function stripPng(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: Uint8Array[] = [bytes.subarray(0, 8)]
  let i = 8
  for (;;) {
    if (i + 12 > bytes.length) unreadable()
    const length = view.getUint32(i)
    const end = i + 12 + length
    if (end > bytes.length) unreadable()
    const type = String.fromCharCode(...bytes.subarray(i + 4, i + 8))
    if (!PNG_METADATA.has(type)) out.push(bytes.subarray(i, end))
    i = end
    if (type === 'IEND') break
  }
  return concat(out)
}

// WebP: a RIFF container of chunks, padded to even sizes. VP8X flags which
// optional chunks are there, and the RIFF header holds the total size.
const VP8X_EXIF = 0x08
const VP8X_XMP = 0x04

function stripWebp(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 12 || view.getUint32(4, true) + 8 > bytes.length) unreadable()
  const end = view.getUint32(4, true) + 8
  const out: Uint8Array[] = [bytes.slice(0, 12)]
  let i = 12
  while (i < end) {
    if (i + 8 > end) unreadable()
    const fourcc = String.fromCharCode(...bytes.subarray(i, i + 4))
    const size = view.getUint32(i + 4, true)
    const next = i + 8 + size + (size % 2)
    if (next > end) unreadable()
    if (fourcc === 'VP8X') {
      const chunk = bytes.slice(i, next)
      chunk[8] = (chunk[8] ?? 0) & ~(VP8X_EXIF | VP8X_XMP)
      out.push(chunk)
    } else if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      out.push(bytes.subarray(i, next))
    }
    i = next
  }
  const result = concat(out)
  new DataView(result.buffer).setUint32(4, result.length - 8, true)
  return result
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** Animated GIFs loop through the NETSCAPE2.0 extension. */
export function isAnimatedGif(bytes: Uint8Array): boolean {
  const marker = ascii('NETSCAPE2.0')
  for (let i = 0; i + marker.length <= bytes.length; i++) {
    if (startsWith(bytes, marker, i)) return true
  }
  return false
}

/**
 * Re-encodes an image at `scale` of its size. The result carries no
 * metadata. Swappable, since tests have no canvas.
 */
export type Shrink = (bytes: Uint8Array, type: ImageType, scale: number) => Promise<Uint8Array>

/** Scales tried in turn until the image fits. */
const SCALES = [1, 0.75, 0.5, 0.35, 0.25]

export interface PreparedImage {
  bytes: Uint8Array
  type: ImageType
}

/** Checks, strips and if needed shrinks an image. Throws ImageError. */
export async function prepareImage(
  bytes: Uint8Array,
  maxBytes: number,
  shrink: Shrink = canvasShrink,
): Promise<PreparedImage> {
  const type = sniff(bytes)
  if (!type) throw new ImageError('type')
  const stripped = stripMetadata(bytes, type)
  if (stripped.length <= maxBytes) return { bytes: stripped, type }
  // Shrinking would drop the animation.
  if (type === 'image/gif' && isAnimatedGif(bytes)) throw new ImageError('too_large')
  for (const scale of SCALES) {
    let out: Uint8Array
    try {
      out = await shrink(stripped, type, scale)
    } catch {
      throw new ImageError('unreadable')
    }
    const outType = sniff(out)
    if (outType && out.length <= maxBytes) return { bytes: out, type: outType }
  }
  throw new ImageError('too_large')
}

/** WebP where the browser can encode it (not Safari), JPEG otherwise. */
export const canvasShrink: Shrink = async (bytes, type, scale) => {
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('no 2d canvas')
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  let blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 })
  if (blob.type !== 'image/webp') {
    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
  }
  return new Uint8Array(await blob.arrayBuffer())
}
