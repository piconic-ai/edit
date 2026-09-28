// @vitest-environment jsdom
import { render } from '@barefootjs/client/runtime'
import type { RoomStatus } from '@ima/protocol'
import { describe, expect, it, vi } from 'vitest'
import '../src/components/EndedBanner.tsx'
import { Store } from '../src/store.ts'

function mount(props: Record<string, unknown> = {}) {
  const status = new Store<RoomStatus>('connected')
  const container = document.createElement('div')
  document.body.append(container)
  const onReconnect = vi.fn()
  render(container, 'EndedBanner', { status, text: () => 'hello', onReconnect, ...props })
  const banner = container.querySelector<HTMLElement>('.banner') as HTMLElement
  const [copy, reconnect] = [...banner.querySelectorAll('button')]
  return {
    status,
    banner,
    copy: copy as HTMLButtonElement,
    reconnect: reconnect as HTMLButtonElement,
    onReconnect,
  }
}

describe('EndedBanner', () => {
  it('shows only once the room closes', () => {
    const { status, banner } = mount()
    expect(banner.hidden).toBe(true)
    status.set('closed')
    expect(banner.hidden).toBe(false)
  })

  it('copies the whole text and says so', async () => {
    const writeText = vi.fn(async () => {})
    const { copy } = mount({ clipboard: { writeText } })
    copy.click()
    await vi.waitFor(() => expect(copy.textContent).toBe('Copied'))
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('says when copying failed, then goes back to its label', async () => {
    vi.useFakeTimers()
    try {
      const { copy } = mount({ clipboard: undefined, resetMs: 1000 })
      copy.click()
      await vi.waitFor(() => expect(copy.textContent).toBe('Could not copy'))
      vi.advanceTimersByTime(1000)
      expect(copy.textContent).toBe('Copy text')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconnects on request', () => {
    const { reconnect, onReconnect } = mount()
    reconnect.click()
    expect(onReconnect).toHaveBeenCalledOnce()
  })
})
