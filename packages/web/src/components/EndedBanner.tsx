'use client'

import { createSignal, onCleanup } from '@barefootjs/client'
import type { RoomStatus } from '@ima/protocol'
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
 * Shown once the room closes, which it does as soon as the host leaves.
 * Copy text matters on phones, where selecting the whole document by hand
 * does not work: the editor only draws the lines on screen.
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
    <div className="banner" role="status" hidden={status() !== 'closed'}>
      <span>This session has ended: the host is not connected. You can still copy the text.</span>
      <button type="button" onClick={copyAll}>
        {LABELS[copy()]}
      </button>
      <button type="button" onClick={() => props.onReconnect()}>
        Reconnect
      </button>
    </div>
  )
}
