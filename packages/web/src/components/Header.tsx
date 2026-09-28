'use client'

import { createEffect, createMemo, createSignal } from '@barefootjs/client'
import type { RoomStatus } from '@ima/protocol'
import { initials } from '../identity.ts'
import type { Participant } from '../room.ts'
import type { SettingsModel } from '../settings.ts'
import type { Readable } from '../store.ts'
import type { ViewSwitch } from '../view.ts'
import { follow } from '../watch.ts'
import { Settings } from './Settings.tsx'

/** How many faces the collapsed row of participants shows before "+N". */
const MAX_FACES = 3

const STATUS_LABELS: Record<RoomStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  closed: 'Ended',
  disconnected: 'Offline',
}

export interface HeaderProps {
  /** The host's file name, once the host has told us. */
  file: Readable<string | null>
  status: Readable<RoomStatus>
  people: Readable<readonly Participant[]>
  /** Whether the screen is narrow (NARROW_QUERY). */
  narrow: Readable<boolean>
  view: ViewSwitch
  settings: SettingsModel
}

function label(p: Participant): string {
  return `${p.name}${p.isHost ? ' (host)' : ''}${p.isSelf ? ' (you)' : ''}`
}

/**
 * The top bar: file name, connection status, participants, view buttons and
 * settings. On narrow screens the participants collapse to a row of faces;
 * tapping it shows their names, and the row folds again whenever the screen
 * changes width class. Screen readers get the names either way, since CSS
 * only hides them visually.
 */
export function Header(props: HeaderProps) {
  const [file, setFile] = createSignal(props.file.get())
  const [status, setStatus] = createSignal(props.status.get())
  const [people, setPeople] = createSignal(props.people.get())
  const [narrow, setNarrow] = createSignal(props.narrow.get())
  const [buttons, setButtons] = createSignal(props.view.buttons.get())
  follow(props.file, setFile)
  follow(props.status, setStatus)
  follow(props.people, setPeople)
  follow(props.narrow, setNarrow)
  follow(props.view.buttons, setButtons)
  const [expanded, setExpanded] = createSignal(false)
  const more = createMemo(() => {
    const hidden = people().length - MAX_FACES
    return hidden > 0 ? `+${hidden}` : undefined
  })

  createEffect(() => {
    narrow()
    setExpanded(false)
  })

  return (
    <header>
      <span className="brand">ima</span>
      <span className="file">{file() ?? ''}</span>
      <span className="status" data-status={status()}>
        <span className="dot" />
        <span>{STATUS_LABELS[status()]}</span>
      </span>
      <ul
        className="people"
        aria-label="Participants"
        data-expanded={expanded() ? '' : undefined}
        data-more={more()}
        onClick={() => setExpanded(narrow() && !expanded())}
      >
        {people().map((p) => (
          <li key={p.clientId} title={label(p)} style={`--c: ${p.color}`}>
            <span className="avatar">
              {initials(p.name)}
              {p.avatar ? (
                <img
                  src={p.avatar}
                  alt=""
                  referrerpolicy="no-referrer"
                  // Unknown to Gravatar (d=404) or blocked: keep the initials.
                  onError={(e) => (e.currentTarget as HTMLElement).remove()}
                />
              ) : null}
            </span>
            <span>{label(p)}</span>
          </li>
        ))}
      </ul>
      <div
        className="view-switch"
        role="group"
        aria-label="View"
        hidden={buttons().every((b) => b.hidden)}
      >
        {buttons().map((b) => (
          <button
            key={b.mode}
            type="button"
            data-mode={b.mode}
            hidden={b.hidden}
            aria-pressed={b.pressed ? 'true' : 'false'}
            disabled={b.disabled}
            title={b.title ?? undefined}
            onClick={() => props.view.choose(b.mode)}
          >
            {b.label}
          </button>
        ))}
      </div>
      <Settings model={props.settings} />
    </header>
  )
}
