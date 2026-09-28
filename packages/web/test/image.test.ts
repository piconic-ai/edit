import { describe, expect, it, vi } from 'vitest'
import {
  ImageError,
  isAnimatedGif,
  prepareImage,
  type Shrink,
  sniff,
  stripMetadata,
} from '../src/image.ts'

const bytes = (...parts: (number[] | string | Uint8Array)[]) => {
  const flat: number[] = []
  for (const p of parts) {
    if (typeof p === 'string') flat.push(...[...p].map((c) => c.charCodeAt(0)))
    else flat.push(...p)
  }
  return new Uint8Array(flat)
}
const u16be = (n: number) => [n >> 8, n & 0xff]
const u32be = (n: number) => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
const u32le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24]
const text = (b: Uint8Array) => String.fromCharCode(...b)

// A JPEG segment: marker, then a length that counts itself.
const segment = (marker: number, data: string) =>
  bytes([0xff, marker], u16be(data.length + 2), data)

function jpeg(): Uint8Array {
  return bytes(
    [0xff, 0xd8],
    segment(0xe0, 'JFIF\0app0'),
    segment(0xe1, 'Exif\0\0GPS 35.6N 139.7E'),
    segment(0xe1, 'http://ns.adobe.com/xap/1.0/\0<xmp/>'),
    segment(0xdb, 'quant'),
    [0xff, 0xda],
    u16be(4),
    'scan data',
    [0xff, 0xd9],
  )
}

const chunk = (type: string, data: string) => bytes(u32be(data.length), type, data, [0, 0, 0, 0])
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function png(): Uint8Array {
  return bytes(
    PNG_SIGNATURE,
    chunk('IHDR', '0123456789abc'),
    chunk('eXIf', 'GPS 35.6N'),
    chunk('tEXt', 'Author\0me'),
    chunk('iTXt', 'XML:com.adobe.xmp\0'),
    chunk('tIME', '1234567'),
    chunk('IDAT', 'pixels'),
    chunk('IEND', ''),
  )
}

// A RIFF chunk: fourcc, little-endian size, data padded to an even size.
const riff = (fourcc: string, data: number[] | string) => {
  const d = bytes(data)
  return bytes(fourcc, u32le(d.length), d, d.length % 2 ? [0] : [])
}

function webp(): Uint8Array {
  const body = bytes(
    'WEBP',
    riff('VP8X', [0x10 | 0x08 | 0x04, 0, 0, 0, 1, 0, 0, 1, 0, 0]),
    riff('VP8 ', 'odd'),
    riff('EXIF', 'GPS 35.6N'),
    riff('XMP ', '<xmp/>'),
  )
  return bytes('RIFF', u32le(body.length), body)
}

describe('sniff', () => {
  it('reads the type from the bytes', () => {
    expect(sniff(png())).toBe('image/png')
    expect(sniff(jpeg())).toBe('image/jpeg')
    expect(sniff(bytes('GIF89a...'))).toBe('image/gif')
    expect(sniff(bytes('GIF87a...'))).toBe('image/gif')
    expect(sniff(webp())).toBe('image/webp')
  })

  it('knows nothing else, SVG included', () => {
    expect(sniff(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniff(bytes('RIFF....WAVE'))).toBeNull()
    expect(sniff(new Uint8Array())).toBeNull()
  })
})

describe('stripMetadata', () => {
  it('drops EXIF and XMP from a JPEG and keeps the rest', () => {
    const out = stripMetadata(jpeg(), 'image/jpeg')
    expect(text(out)).not.toContain('GPS')
    expect(text(out)).not.toContain('xap')
    expect(text(out)).toContain('JFIF')
    expect(text(out)).toContain('quant')
    expect(text(out).endsWith('scan data\xff\xd9')).toBe(true)
  })

  it('drops metadata chunks from a PNG', () => {
    const out = stripMetadata(png(), 'image/png')
    expect(out).toEqual(
      bytes(
        PNG_SIGNATURE,
        chunk('IHDR', '0123456789abc'),
        chunk('IDAT', 'pixels'),
        chunk('IEND', ''),
      ),
    )
  })

  it('drops EXIF and XMP from a WebP and fixes its header', () => {
    const out = stripMetadata(webp(), 'image/webp')
    const view = new DataView(out.buffer)
    expect(view.getUint32(4, true)).toBe(out.length - 8)
    expect(text(out)).not.toContain('EXIF')
    expect(text(out)).not.toContain('XMP')
    // VP8X keeps its alpha flag but no longer claims EXIF or XMP.
    expect(out[20]).toBe(0x10)
    // The odd-sized chunk keeps its padding.
    expect(text(out)).toContain('VP8 \x03\0\0\0odd\0')
  })

  it('leaves a GIF alone', () => {
    const gif = bytes('GIF89a', 'data')
    expect(stripMetadata(gif, 'image/gif')).toBe(gif)
  })

  it('refuses malformed images', () => {
    const cut = (b: Uint8Array) => b.subarray(0, b.length - 12)
    expect(() =>
      stripMetadata(bytes([0xff, 0xd8], segment(0xe0, 'x').subarray(0, 3)), 'image/jpeg'),
    ).toThrow(ImageError)
    expect(() => stripMetadata(cut(png()), 'image/png')).toThrow(ImageError)
    expect(() => stripMetadata(cut(webp()), 'image/webp')).toThrow(ImageError)
  })
})

describe('isAnimatedGif', () => {
  it('spots the looping extension', () => {
    expect(isAnimatedGif(bytes('GIF89a', '!\xff\x0bNETSCAPE2.0'))).toBe(true)
    expect(isAnimatedGif(bytes('GIF89a', 'still'))).toBe(false)
  })
})

describe('prepareImage', () => {
  const noShrink: Shrink = () => Promise.reject(new Error('unexpected'))

  it('strips an image that fits', async () => {
    const out = await prepareImage(png(), 1000, noShrink)
    expect(out.type).toBe('image/png')
    expect(text(out.bytes)).not.toContain('eXIf')
  })

  it('shrinks an image that does not fit, a little more each time', async () => {
    const shrink = vi.fn<Shrink>(async (_b, _t, scale) =>
      bytes([0xff, 0xd8, 0xff], new Array(Math.round(scale * 100)).fill(0)),
    )
    const out = await prepareImage(png(), 60, shrink)
    expect(shrink.mock.calls.map((c) => c[2])).toEqual([1, 0.75, 0.5])
    expect(out.type).toBe('image/jpeg')
    expect(out.bytes.length).toBeLessThanOrEqual(60)
  })

  it('gives up on an image that never fits', async () => {
    const shrink: Shrink = async () => bytes([0xff, 0xd8, 0xff], new Array(1000).fill(0))
    await expect(prepareImage(png(), 60, shrink)).rejects.toMatchObject({ reason: 'too_large' })
  })

  it('refuses to shrink an animated GIF', async () => {
    const gif = bytes('GIF89a', '!\xff\x0bNETSCAPE2.0', new Array(100).fill(0))
    await expect(prepareImage(gif, 50, noShrink)).rejects.toMatchObject({ reason: 'too_large' })
  })

  it('refuses what is not an image', async () => {
    await expect(prepareImage(bytes('<svg/>'), 1000, noShrink)).rejects.toMatchObject({
      reason: 'type',
    })
  })

  it('reports an image the browser cannot decode', async () => {
    await expect(prepareImage(png(), 10, noShrink)).rejects.toMatchObject({ reason: 'unreadable' })
  })
})
