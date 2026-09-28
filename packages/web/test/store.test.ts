import { describe, expect, it, vi } from 'vitest'
import { Store } from '../src/store.ts'

describe('Store', () => {
  it('tells subscribers about each new value, until they stop', () => {
    const store = new Store(1)
    const seen = vi.fn()
    const stop = store.subscribe(seen)
    store.set(2)
    expect(store.get()).toBe(2)
    stop()
    store.set(3)
    expect(seen.mock.calls).toEqual([[2]])
  })

  it('stays quiet when the value does not change', () => {
    const store = new Store('a')
    const seen = vi.fn()
    store.subscribe(seen)
    store.set('a')
    expect(seen).not.toHaveBeenCalled()
  })
})
