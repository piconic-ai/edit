// @vitest-environment jsdom
import { render } from '@barefootjs/client/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../src/components/Cards.tsx'
import '../src/components/Layout.tsx'
import type { LayoutParts } from '../src/components/Layout.tsx'

const mounted: HTMLElement[] = []
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove()
})

function mount(name: string, props: Record<string, unknown> = {}) {
  const container = document.createElement('div')
  document.body.append(container)
  mounted.push(container)
  render(container, name, props)
  return container
}

describe('Landing', () => {
  it('says what ima is and links to the install guide', () => {
    const el = mount('Landing')
    expect(el.querySelector('h1')?.textContent).toBe('ima')
    expect(el.querySelector('code')?.textContent).toBe('ima notes.md')
    expect(el.querySelector('p')?.textContent).toBe(
      'Co-edit a local text file, right now. Run ima notes.md and share the link it prints. How to install',
    )
    expect(el.querySelector('a')?.getAttribute('href')).toBe(
      'https://github.com/piconic-ai/ima#install',
    )
  })
})

describe('IncompleteLink', () => {
  it('asks for the whole URL', () => {
    const el = mount('IncompleteLink')
    expect(el.querySelector('h1')?.textContent).toBe('This link is incomplete')
    expect(el.textContent).toContain('including the part after #')
  })
})

describe('JoinCard', () => {
  function join() {
    const onJoin = vi.fn()
    const el = mount('JoinCard', { onJoin })
    const input = el.querySelector('input') as HTMLInputElement
    const form = el.querySelector('form') as HTMLFormElement
    const submit = (value: string) => {
      input.value = value
      form.dispatchEvent(new Event('submit', { cancelable: true }))
    }
    return { el, input, onJoin, submit }
  }

  it('focuses a name field that fits autofill', () => {
    const { input } = join()
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('autocomplete')).toBe('name')
    expect(input.required).toBe(true)
    expect(input.maxLength).toBe(40)
  })

  it('joins with the trimmed name, and not with a blank one', () => {
    const { onJoin, submit } = join()
    submit('   ')
    expect(onJoin).not.toHaveBeenCalled()
    submit('  Ada  ')
    expect(onJoin).toHaveBeenCalledWith('Ada')
  })
})

describe('Layout', () => {
  it('hands over the room page parts, in page order', () => {
    let parts: LayoutParts | undefined
    const el = mount('Layout', { onReady: (p: LayoutParts) => (parts = p) })
    expect(parts).toBeDefined()
    const p = parts as LayoutParts
    expect(p.main.tagName).toBe('MAIN')
    expect(p.main.className).toBe('editor')
    expect(p.preview.getAttribute('aria-label')).toBe('Preview')
    const order = [...(el.querySelector('.layout')?.querySelectorAll('*') ?? [])]
    const at = (node: HTMLElement) => order.indexOf(node)
    expect([p.header, p.banner, p.main, p.source, p.splitter, p.preview, p.table].map(at)).toEqual(
      [...[p.header, p.banner, p.main, p.source, p.splitter, p.preview, p.table].map(at)].sort(
        (a, b) => a - b,
      ),
    )
  })
})
