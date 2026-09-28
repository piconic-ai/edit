/** A value that changes over time, which components turn into a signal (see watch.ts). */
export interface Readable<T> {
  get(): T
  /** Calls `fn` with each new value; returns a function that stops. */
  subscribe(fn: (value: T) => void): () => void
}

/**
 * A plain holder for state that lives outside the components, such as the
 * room's status. main.ts writes it; components read it through a signal.
 */
export class Store<T> implements Readable<T> {
  #value: T
  #listeners = new Set<(value: T) => void>()

  constructor(value: T) {
    this.#value = value
  }

  get(): T {
    return this.#value
  }

  set(value: T): void {
    if (Object.is(value, this.#value)) return
    this.#value = value
    for (const fn of [...this.#listeners]) fn(value)
  }

  subscribe(fn: (value: T) => void): () => void {
    this.#listeners.add(fn)
    return () => {
      this.#listeners.delete(fn)
    }
  }
}
