'use client'

import { createSignal, onCleanup } from '@barefootjs/client'
import type { RoomStatus } from '@pedit/protocol'
import { copyText } from '../copy.ts'
import type { Readable } from '../store.ts'

const RESET_MS = 2000

export interface EndedBannerProps {
  status: Readable<RoomStatus>
  /** The whole document, read when Copy is pressed. */
  text: () => string
  onReconnect: () => void
  clipboard?: Pick<Clipboard, 'writeText'>
  resetMs?: number
}

const LABELS = { idle: 'Copy text', copied: 'Copied', failed: 'Could not copy' } as const

/**
 * Shown once the room closes, which it does as soon as the host leaves, or
 * when it had no place for us. Copy text matters on phones, where selecting
 * the whole document by hand does not work: the editor only draws the lines
 * on screen. A full room never sent us any text, so there is none to copy.
 */
export function EndedBanner(props: EndedBannerProps) {
  const status = () => props.status.get()
  const [copy, setCopy] = createSignal<keyof typeof LABELS>('idle')
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))

  const copyAll = async () => {
    const clipboard = 'clipboard' in props ? props.clipboard : navigator.clipboard
    setCopy((await copyText(props.text(), clipboard)) ? 'copied' : 'failed')
    clearTimeout(timer)
    timer = setTimeout(() => setCopy('idle'), props.resetMs ?? RESET_MS)
  }

  return (
    <div className="banner" role="status" hidden={status() !== 'closed' && status() !== 'full'}>
      <span hidden={status() !== 'closed'}>
        This session has ended: the host is not connected. You can still copy the text.
      </span>
      <span hidden={status() !== 'full'}>
        This room is full: its relay takes only so many people at once. Try again when someone
        leaves, or ask the host to run their own relay, which can take more.
      </span>
      <button type="button" onClick={copyAll} hidden={status() !== 'closed'}>
        {LABELS[copy()]}
      </button>
      <button type="button" onClick={() => props.onReconnect()}>
        Reconnect
      </button>
    </div>
  )
}
