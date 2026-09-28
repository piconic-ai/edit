import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToTest } from '@barefootjs/test'
import { describe, expect, it } from 'vitest'

const dir = join(import.meta.dirname, '../src/components')
const components = readdirSync(dir).filter((f) => f.endsWith('.tsx'))

// The compiler's IR for every component: it must compile with no errors, and
// the banner's reactive parts must be wired as intended.
describe.each(components)('%s', (file) => {
  const ir = renderToTest(readFileSync(join(dir, file), 'utf8'), file)

  it('compiles without errors', () => {
    expect(ir.errors).toEqual([])
  })
})

describe('EndedBanner IR', () => {
  const file = 'EndedBanner.tsx'
  const ir = renderToTest(readFileSync(join(dir, file), 'utf8'), file)

  it('keeps the room status and the copy state as signals', () => {
    expect(ir.signals).toEqual(expect.arrayContaining(['status', 'copy']))
  })

  it('has two buttons with click handlers', () => {
    const buttons = ir.findAll({ tag: 'button' })
    expect(buttons).toHaveLength(2)
    for (const b of buttons) expect(b.events).toContain('click')
  })
})
