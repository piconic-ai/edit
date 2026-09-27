import { h } from './dom.ts'

export interface MenuItem {
  label: string
  /** The key combination that does the same, shown on the right. */
  shortcut?: string
  disabled?: boolean
  action: () => void
}

/** A separator between groups of items. */
export const SEPARATOR = null

const EDGE = 8

/** Whether shortcuts read ⌘ and ⌥ rather than Ctrl and Alt. */
export function isMac(nav: Pick<Navigator, 'userAgent'> = navigator): boolean {
  return /Mac|iPhone|iPad/.test(nav.userAgent)
}

/** A shortcut as this platform writes it, from keys like ['Mod', 'Alt', '=']. */
export function formatShortcut(keys: readonly string[], mac = isMac()): string {
  const names: Record<string, [string, string]> = {
    Mod: ['⌘', 'Ctrl'],
    Ctrl: ['⌃', 'Ctrl'],
    Alt: ['⌥', 'Alt'],
    Shift: ['⇧', 'Shift'],
    Space: ['Space', 'Space'],
  }
  const parts = keys.map((k) => names[k]?.[mac ? 0 : 1] ?? k)
  return mac ? parts.join('') : parts.join('+')
}

/**
 * A context menu at a point. It closes on Escape, Tab, a pick, or a press
 * anywhere else, and gives the focus back to where it was.
 */
export class ContextMenu {
  readonly element: HTMLElement
  #returnFocus: HTMLElement | null = null
  #onOutside = (ev: Event) => {
    if (!this.element.contains(ev.target as Node)) this.close()
  }

  constructor() {
    this.element = h('div', { className: 'context-menu', role: 'menu', hidden: true })
    this.element.addEventListener('keydown', (ev) => this.#onKey(ev))
    this.element.addEventListener('contextmenu', (ev) => ev.preventDefault())
  }

  get open(): boolean {
    return !this.element.hidden
  }

  show(items: readonly (MenuItem | null)[], x: number, y: number): void {
    this.#returnFocus = document.activeElement as HTMLElement | null
    this.element.replaceChildren(
      ...items.map((item) => {
        if (!item) return h('div', { className: 'context-menu-separator', role: 'separator' })
        const button = h('button', {
          type: 'button',
          role: 'menuitem',
          tabIndex: -1,
          disabled: item.disabled ?? false,
        })
        button.append(h('span', { textContent: item.label }))
        if (item.shortcut) {
          button.append(h('kbd', { textContent: item.shortcut }))
          button.setAttribute('aria-keyshortcuts', item.shortcut)
        }
        button.addEventListener('click', () => {
          this.close()
          item.action()
        })
        return button
      }),
    )
    this.element.hidden = false
    // Keep it on screen: flip left or up when it would overflow.
    const { width, height } = this.element.getBoundingClientRect()
    const vw = document.documentElement.clientWidth
    const vh = document.documentElement.clientHeight
    const left = x + width + EDGE > vw ? Math.max(EDGE, x - width) : x
    const top = y + height + EDGE > vh ? Math.max(EDGE, y - height) : y
    this.element.style.left = `${left}px`
    this.element.style.top = `${top}px`
    document.addEventListener('pointerdown', this.#onOutside, true)
    this.#items()[0]?.focus()
  }

  close(): void {
    if (!this.open) return
    this.element.hidden = true
    document.removeEventListener('pointerdown', this.#onOutside, true)
    const back = this.#returnFocus
    this.#returnFocus = null
    if (back?.isConnected) back.focus()
  }

  #items(): HTMLButtonElement[] {
    return [...this.element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter(
      (b) => !b.disabled,
    )
  }

  #onKey(ev: KeyboardEvent): void {
    const items = this.#items()
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const target =
      ev.key === 'ArrowDown'
        ? items[(at + 1) % items.length]
        : ev.key === 'ArrowUp'
          ? items[(at - 1 + items.length) % items.length]
          : ev.key === 'Home'
            ? items[0]
            : ev.key === 'End'
              ? items.at(-1)
              : undefined
    if (target) {
      ev.preventDefault()
      target.focus()
    } else if (ev.key === 'Escape' || ev.key === 'Tab') {
      ev.preventDefault()
      this.close()
    }
    // Keys stay in the menu, not the grid under it.
    ev.stopPropagation()
  }
}
