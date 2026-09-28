import { createSignal, onCleanup, onMount } from '@barefootjs/client'
import type { Readable } from './store.ts'

/**
 * Reads a store as a signal inside a component: the getter it returns
 * tracks the store's value from mount until the component goes away.
 */
export function watch<T>(store: Readable<T>): () => T {
  const [value, setValue] = createSignal(store.get())
  onMount(() => {
    // Wrapped, so a function value is stored rather than called as an update.
    onCleanup(store.subscribe((next) => setValue(() => next)))
  })
  return value
}
