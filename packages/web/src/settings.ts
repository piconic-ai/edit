import { h } from './dom.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'
const PANEL_WIDTH = 320
const EDGE = 8

/** An eight-toothed gear outline centred in a 24x24 box. */
function gearPath(teeth = 8, outer = 10, inner = 7.5): string {
  const points: string[] = []
  const step = (2 * Math.PI) / teeth
  const at = (r: number, a: number) =>
    `${(12 + r * Math.cos(a)).toFixed(2)} ${(12 + r * Math.sin(a)).toFixed(2)}`
  for (let i = 0; i < teeth; i++) {
    const a = i * step
    // Each tooth: rise, flat top, fall; the gap to the next one is a straight edge.
    points.push(
      at(inner, a - step * 0.3),
      at(outer, a - step * 0.18),
      at(outer, a + step * 0.18),
      at(inner, a + step * 0.3),
    )
  }
  return `M${points.join('L')}Z`
}

/** A stroked 24x24 icon, hidden from screen readers since its button has a label. */
function icon(size: number, d: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24',
    width: String(size),
    height: String(size),
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })) {
    svg.setAttribute(k, v)
  }
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', d)
  svg.append(path)
  return svg
}

function gearIcon(): SVGSVGElement {
  const svg = icon(18, gearPath())
  const hub = document.createElementNS(SVG_NS, 'circle')
  for (const [k, v] of Object.entries({ cx: '12', cy: '12', r: '3' })) hub.setAttribute(k, v)
  svg.append(hub)
  return svg
}

const CHEVRON_RIGHT = 'M9 6l6 6-6 6'
const CHEVRON_LEFT = 'M15 6l-6 6 6 6'

export interface ToggleOptions {
  label: string
  hint?: string
  checked: boolean
  onChange: (checked: boolean) => void
}

/** A control whose value can be set from outside without calling onChange. */
export interface Control<T> {
  set(value: T): void
}

/** Updates the checkbox without calling onChange, e.g. to undo a failed change. */
export type Toggle = Control<boolean>

export interface SelectOptions<T extends string> {
  label: string
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}

export interface RangeOptions {
  label: string
  min: number
  max: number
  step: number
  value: number
  format: (value: number) => string
  onChange: (value: number) => void
}

export interface GalleryOption {
  value: string
  label: string
  /** A picture of the option; called once for its card and again whenever it becomes current. */
  preview: () => HTMLElement
}

export interface GalleryOptions {
  label: string
  groups: readonly { label: string; options: readonly GalleryOption[] }[]
  value: string
  onChange: (value: string) => void
}

export interface Settings {
  button: HTMLButtonElement
  panel: HTMLElement
  addSection(title: string): void
  addToggle(options: ToggleOptions): Toggle
  addSelect<T extends string>(options: SelectOptions<T>): Control<T>
  addRange(options: RangeOptions): Control<number>
  /**
   * A row showing the current option that opens a page of cards. The cards are
   * a listbox that applies each option as it is clicked or the arrow keys
   * reach it, so the effect shows behind the panel. Enter, Escape or the back
   * button return to the settings.
   */
  addGallery(options: GalleryOptions): Control<string>
}

let uid = 0

/**
 * A gear button that opens a panel of per-browser preferences.
 * The panel is a popover, so the browser handles closing it on Escape or an
 * outside click.
 */
export function createSettings(): Settings {
  const list = h('div', { className: 'settings-list' })
  const home = h('div', { className: 'settings-home' }, [
    h('h2', { textContent: 'Settings' }),
    list,
  ])
  const panel = h('div', { className: 'settings', id: 'settings', role: 'dialog' }, [home])
  panel.setAttribute('popover', '')
  panel.setAttribute('aria-label', 'Settings')

  const button = h('button', { type: 'button', className: 'icon', title: 'Settings' }, [gearIcon()])
  button.setAttribute('aria-label', 'Settings')
  button.setAttribute('popovertarget', panel.id)

  // Open right under the button, wherever the header has wrapped it to,
  // and keep the whole panel on screen, scrolling inside it if it is too tall.
  panel.addEventListener('beforetoggle', (ev) => {
    if ((ev as ToggleEvent).newState !== 'open') return
    // Always open on the settings themselves, not a page left open last time.
    showHome()
    const rect = button.getBoundingClientRect()
    const viewport = document.documentElement.clientWidth
    const width = Math.min(PANEL_WIDTH, viewport - 2 * EDGE)
    const left = Math.max(EDGE, Math.min(rect.right - width, viewport - width - EDGE))
    const top = rect.bottom + 6
    panel.style.width = `${width}px`
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
    panel.style.maxHeight = `calc(var(--app-height, 100dvh) - ${top + EDGE}px)`
  })

  const nextId = (prefix: string) => `settings-${prefix}-${++uid}`

  // Pages that replace the settings inside the panel, such as the theme gallery.
  const pages: HTMLElement[] = []
  const showHome = () => {
    for (const page of pages) page.hidden = true
    home.hidden = false
  }
  const showPage = (page: HTMLElement) => {
    home.hidden = true
    for (const p of pages) p.hidden = p !== page
    panel.scrollTop = 0
  }

  const addSection = (title: string) => {
    list.append(h('h3', { className: 'settings-section', textContent: title }))
  }

  const addToggle = ({ label, hint, checked, onChange }: ToggleOptions): Toggle => {
    const input = h('input', { type: 'checkbox', checked })
    input.addEventListener('change', () => onChange(input.checked))
    const text = h('span', { className: 'settings-text' }, [h('span', { textContent: label })])
    if (hint) text.append(h('small', { textContent: hint }))
    list.append(h('label', { className: 'settings-row' }, [input, text]))
    return {
      set: (value) => {
        input.checked = value
      },
    }
  }

  const addSelect = <T extends string>({
    label,
    options,
    value,
    onChange,
  }: SelectOptions<T>): Control<T> => {
    const select = h(
      'select',
      {},
      options.map((o) => h('option', { value: o.value, textContent: o.label })),
    )
    select.value = value
    select.addEventListener('change', () => onChange(select.value as T))
    list.append(
      h('label', { className: 'settings-field' }, [h('span', { textContent: label }), select]),
    )
    return {
      set: (next) => {
        select.value = next
      },
    }
  }

  const addRange = ({
    label,
    min,
    max,
    step,
    value,
    format,
    onChange,
  }: RangeOptions): Control<number> => {
    const input = h('input', {
      type: 'range',
      min: String(min),
      max: String(max),
      step: String(step),
    })
    input.value = String(value)
    const output = h('output', { textContent: format(value) })
    input.addEventListener('input', () => {
      const next = Number(input.value)
      output.textContent = format(next)
      onChange(next)
    })
    list.append(
      h('label', { className: 'settings-field settings-range' }, [
        h('span', { textContent: label }),
        input,
        output,
      ]),
    )
    return {
      set: (next) => {
        input.value = String(next)
        output.textContent = format(next)
      },
    }
  }

  const addGallery = ({ label, groups, value, onChange }: GalleryOptions): Control<string> => {
    const titleId = nextId('title')
    const back = h('button', { type: 'button', className: 'settings-back', title: 'Back' }, [
      icon(18, CHEVRON_LEFT),
    ])
    back.setAttribute('aria-label', 'Back to settings')
    const box = h('div', { className: 'settings-gallery', role: 'listbox', tabIndex: 0 })
    box.setAttribute('aria-labelledby', titleId)
    const page = h('div', { className: 'settings-page', hidden: true }, [
      h('div', { className: 'settings-page-head' }, [
        back,
        h('h2', { id: titleId, textContent: label }),
      ]),
      box,
    ])
    pages.push(page)
    panel.append(page)

    const options: HTMLElement[] = []
    const byValue = new Map<string, GalleryOption>()
    for (const group of groups) {
      const groupId = nextId('group')
      const cards = h('div', { className: 'settings-cards' })
      const el = h('div', { role: 'group' }, [
        h('div', { className: 'settings-group-label', id: groupId, textContent: group.label }),
        cards,
      ])
      el.setAttribute('aria-labelledby', groupId)
      for (const o of group.options) {
        byValue.set(o.value, o)
        const option = h('div', { role: 'option', id: nextId('option') }, [
          o.preview(),
          h('span', { className: 'settings-card-label', textContent: o.label }),
        ])
        option.dataset.value = o.value
        option.addEventListener('click', () => choose(option))
        options.push(option)
        cards.append(option)
      }
      box.append(el)
    }

    // The row on the settings page: the current option and a way into the gallery.
    const current = h('span', { className: 'settings-nav-value' })
    const currentPreview = h('span', { className: 'settings-nav-preview' })
    const row = h('button', { type: 'button', className: 'settings-nav' }, [
      currentPreview,
      h('span', { className: 'settings-text' }, [h('span', { textContent: label }), current]),
      icon(16, CHEVRON_RIGHT),
    ])
    row.setAttribute('aria-haspopup', 'listbox')
    list.append(row)

    const select = (active: HTMLElement | undefined) => {
      for (const option of options) {
        option.setAttribute('aria-selected', String(option === active))
      }
      const o = byValue.get(active?.dataset.value ?? '')
      current.textContent = o?.label ?? ''
      currentPreview.replaceChildren(...(o ? [o.preview()] : []))
      row.setAttribute('aria-label', o ? `${label}: ${o.label}` : label)
      if (active) {
        box.setAttribute('aria-activedescendant', active.id)
        if (!page.hidden) active.scrollIntoView?.({ block: 'nearest' })
      } else {
        box.removeAttribute('aria-activedescendant')
      }
    }
    const choose = (option: HTMLElement | undefined) => {
      if (!option || option.getAttribute('aria-selected') === 'true') return
      select(option)
      onChange(option.dataset.value ?? '')
    }
    const open = () => {
      showPage(page)
      box.focus()
      box.querySelector('[aria-selected=true]')?.scrollIntoView?.({ block: 'center' })
    }
    const close = () => {
      showHome()
      row.focus()
    }
    row.addEventListener('click', open)
    back.addEventListener('click', close)

    box.addEventListener('keydown', (ev) => {
      const at = options.findIndex((o) => o.getAttribute('aria-selected') === 'true')
      const last = options.length - 1
      const target =
        ev.key === 'ArrowDown' || ev.key === 'ArrowRight'
          ? Math.min(last, at + 1)
          : ev.key === 'ArrowUp' || ev.key === 'ArrowLeft'
            ? Math.max(0, at - 1)
            : ev.key === 'Home'
              ? 0
              : ev.key === 'End'
                ? last
                : null
      if (target !== null) {
        ev.preventDefault()
        choose(options[target])
      } else if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault()
        close()
      }
    })
    // Escape goes back one page rather than closing the whole panel.
    page.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      close()
    })

    const find = (v: string) => options.find((o) => o.dataset.value === v)
    select(find(value))
    return { set: (next) => select(find(next)) }
  }

  return { button, panel, addSection, addToggle, addSelect, addRange, addGallery }
}
