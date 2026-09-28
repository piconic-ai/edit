import { onCleanup, onMount } from '@barefootjs/client'
import type { Readable } from './store.ts'

/**
 * Keeps a component's signal in step with a store, from mount until the
 * component goes away:
 *
 *   const [status, setStatus] = createSignal(props.status.get())
 *   follow(props.status, setStatus)
 *
 * The signal is created in the component rather than here on purpose. The
 * CSR template inlines a local's initializer to render the first markup, so
 * a helper returning the signal would run again there, outside any owner,
 * and its subscription would never be released (piconic-ai/barefootjs#3235).
 * A statement like this one is not inlined.
 */
export function follow<T>(store: Readable<T>, set: (next: () => T) => unknown): void {
  onMount(() => {
    // Wrapped, so a function value is stored rather than called as an update.
    onCleanup(store.subscribe((next) => set(() => next)))
  })
}
