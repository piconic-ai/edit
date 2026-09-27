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

function gearIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24',
    width: '18',
    height: '18',
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
  path.setAttribute('d', gearPath())
  const hub = document.createElementNS(SVG_NS, 'circle')
  for (const [k, v] of Object.entries({ cx: '12', cy: '12', r: '3' })) hub.setAttribute(k, v)
  svg.append(path, hub)
  return svg
}

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

export interface ChoiceOptions<T extends string> {
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

export interface ListboxOption {
  value: string
  label: string
  /** Background and text colours for a small preview. */
  swatch?: { bg: string; fg: string }
}

export interface ListboxOptions {
  label: string
  groups: readonly { label: string; options: readonly ListboxOption[] }[]
  value: string
  onChange: (value: string) => void
}

export interface Settings {
  button: HTMLButtonElement
  panel: HTMLElement
  addSection(title: string): void
  addToggle(options: ToggleOptions): Toggle
  /** A row of radio buttons. */
  addChoice<T extends string>(options: ChoiceOptions<T>): Control<T>
  addSelect<T extends string>(options: ChoiceOptions<T>): Control<T>
  addRange(options: RangeOptions): Control<number>
  /**
   * A grouped list that applies the highlighted option as the arrow keys move,
   * so the effect shows while the panel stays open. Enter closes the panel.
   */
  addListbox(options: ListboxOptions): Control<string>
}

let uid = 0

/**
 * A gear button that opens a panel of per-browser preferences.
 * The panel is a popover, so the browser handles closing it on Escape or an
 * outside click.
 */
export function createSettings(): Settings {
  const list = h('div', { className: 'settings-list' })
  const panel = h('div', { className: 'settings', id: 'settings', role: 'dialog' }, [
    h('h2', { textContent: 'Settings' }),
    list,
  ])
  panel.setAttribute('popover', '')
  panel.setAttribute('aria-label', 'Settings')

  const button = h('button', { type: 'button', className: 'icon', title: 'Settings' }, [gearIcon()])
  button.setAttribute('aria-label', 'Settings')
  button.setAttribute('popovertarget', panel.id)

  // Open right under the button, wherever the header has wrapped it to,
  // and keep the whole panel on screen, scrolling inside it if it is too tall.
  panel.addEventListener('beforetoggle', (ev) => {
    if ((ev as ToggleEvent).newState !== 'open') return
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

  const addChoice = <T extends string>({
    label,
    options,
    value,
    onChange,
  }: ChoiceOptions<T>): Control<T> => {
    const name = nextId('choice')
    const inputs = options.map((o) => {
      const input = h('input', { type: 'radio', name, value: o.value, checked: o.value === value })
      input.addEventListener('change', () => {
        if (input.checked) onChange(o.value)
      })
      return h('label', {}, [input, h('span', { textContent: o.label })])
    })
    list.append(
      h('fieldset', { className: 'settings-field settings-choice' }, [
        h('legend', { textContent: label }),
        h('div', {}, inputs),
      ]),
    )
    return {
      set: (next) => {
        for (const radio of list.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) {
          radio.checked = radio.value === next
        }
      },
    }
  }

  const addSelect = <T extends string>({
    label,
    options,
    value,
    onChange,
  }: ChoiceOptions<T>): Control<T> => {
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

  const addListbox = ({ label, groups, value, onChange }: ListboxOptions): Control<string> => {
    const labelId = nextId('label')
    const box = h('div', { className: 'settings-listbox', role: 'listbox', tabIndex: 0 })
    box.setAttribute('aria-labelledby', labelId)
    const options: HTMLElement[] = []
    for (const group of groups) {
      const groupId = nextId('group')
      const el = h('div', { role: 'group' }, [
        h('div', { className: 'settings-group-label', id: groupId, textContent: group.label }),
      ])
      el.setAttribute('aria-labelledby', groupId)
      for (const o of group.options) {
        const swatch = h('span', { className: 'swatch', textContent: 'Aa' })
        swatch.setAttribute('aria-hidden', 'true')
        if (o.swatch) {
          swatch.style.background = o.swatch.bg
          swatch.style.color = o.swatch.fg
        }
        const option = h('div', { role: 'option', id: nextId('option') }, [
          swatch,
          h('span', { textContent: o.label }),
        ])
        option.dataset.value = o.value
        option.addEventListener('click', () => choose(option))
        options.push(option)
        el.append(option)
      }
      box.append(el)
    }

    const select = (active: HTMLElement | undefined) => {
      for (const option of options) {
        option.setAttribute('aria-selected', String(option === active))
      }
      if (active) {
        box.setAttribute('aria-activedescendant', active.id)
        active.scrollIntoView?.({ block: 'nearest' })
      } else {
        box.removeAttribute('aria-activedescendant')
      }
    }
    const choose = (option: HTMLElement | undefined) => {
      if (!option || option.getAttribute('aria-selected') === 'true') return
      select(option)
      onChange(option.dataset.value ?? '')
    }

    box.addEventListener('keydown', (ev) => {
      const current = options.findIndex((o) => o.getAttribute('aria-selected') === 'true')
      const last = options.length - 1
      const target =
        ev.key === 'ArrowDown'
          ? Math.min(last, current + 1)
          : ev.key === 'ArrowUp'
            ? Math.max(0, current - 1)
            : ev.key === 'Home'
              ? 0
              : ev.key === 'End'
                ? last
                : null
      if (target !== null) {
        ev.preventDefault()
        choose(options[target])
      } else if (ev.key === 'Enter') {
        ev.preventDefault()
        panel.hidePopover?.()
      }
    })

    const find = (v: string) => options.find((o) => o.dataset.value === v)
    select(find(value))
    list.append(
      h('div', { className: 'settings-field' }, [
        h('span', { id: labelId, textContent: label }),
        box,
      ]),
    )
    return { set: (next) => select(find(next)) }
  }

  return { button, panel, addSection, addToggle, addChoice, addSelect, addRange, addListbox }
}
