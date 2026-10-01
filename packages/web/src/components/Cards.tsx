'use client'

import { onMount } from '@barefootjs/client'

/** The page at `/`, for someone who opened piconic edit without a room link. */
export function Landing() {
  return (
    <div className="center">
      <div className="card">
        <h1>piconic edit</h1>
        <p>
          {'Co-edit a local text file, right now. Run '}
          <code>pedit notes.md</code>
          {' and share the link it prints. '}
          <a href="https://github.com/piconic-ai/edit#install">How to install</a>
        </p>
      </div>
    </div>
  )
}

/** A room link that lost its key, the part after #. */
export function IncompleteLink() {
  return (
    <div className="center">
      <div className="card">
        <h1>Open your shared link again</h1>
        <p>
          Part of the link may have been lost during sign-in. Please open the full URL you received
          again, including the part after #.
        </p>
      </div>
    </div>
  )
}

/** Asks for the name others see next to this browser's cursor. */
export function JoinCard(props: { onJoin: (name: string) => void }) {
  let input: HTMLInputElement | undefined
  onMount(() => input?.focus())

  const submit = (ev: Event) => {
    ev.preventDefault()
    const name = input?.value.trim()
    if (name) props.onJoin(name)
  }

  return (
    <div className="center">
      <div className="card">
        <h1>Join the room</h1>
        <p>Others will see this name next to your cursor.</p>
        <form onSubmit={submit}>
          <input
            name="name"
            placeholder="Your name"
            autocomplete="name"
            required
            maxlength={40}
            ref={(el) => {
              input = el
            }}
          />
          <button type="submit">Join</button>
        </form>
      </div>
    </div>
  )
}
