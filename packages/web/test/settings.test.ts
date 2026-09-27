// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createSettings } from '../src/settings.ts'

describe('createSettings', () => {
  it('opens its panel from a labelled gear button', () => {
    const { button, panel } = createSettings()
    expect(button.getAttribute('aria-label')).toBe('Settings')
    expect(button.querySelector('svg path')?.getAttribute('d')).toMatch(/^M.+Z$/)
    expect(panel.hasAttribute('popover')).toBe(true)
    expect(button.getAttribute('popovertarget')).toBe(panel.id)
  })

  it('adds toggles that report changes and can be reset without reporting', () => {
    const { panel, addToggle } = createSettings()
    document.body.append(panel)
    const changes: boolean[] = []
    const toggle = addToggle({
      label: 'Vim keybindings',
      hint: 'Only in this browser.',
      checked: false,
      onChange: (on) => changes.push(on),
    })

    const row = panel.querySelector('label')
    const input = panel.querySelector('input')
    if (!row || !input) throw new Error('no toggle rendered')
    expect(row.textContent).toContain('Vim keybindings')
    expect(row.textContent).toContain('Only in this browser.')
    expect(input.checked).toBe(false)

    input.click()
    expect(changes).toEqual([true])

    toggle.set(false)
    expect(input.checked).toBe(false)
    expect(changes).toEqual([true])
  })

  it('starts a toggle in the stored state', () => {
    const { panel, addToggle } = createSettings()
    addToggle({ label: 'A', checked: true, onChange: () => {} })
    addToggle({ label: 'B', checked: false, onChange: () => {} })
    const inputs = [...panel.querySelectorAll('input')].map((i) => i.checked)
    expect(inputs).toEqual([true, false])
  })
})

describe('settings controls', () => {
  it('adds section headings in order', () => {
    const { panel, addSection, addToggle } = createSettings()
    addSection('Appearance')
    addToggle({ label: 'A', checked: false, onChange: () => {} })
    addSection('Editor')
    const headings = [...panel.querySelectorAll('h3')].map((el) => el.textContent)
    expect(headings).toEqual(['Appearance', 'Editor'])
  })

  it('adds a radio choice that reports changes and can be set without reporting', () => {
    const { panel, addChoice } = createSettings()
    // Detached radios do not report changes in jsdom.
    document.body.append(panel)
    const changes: string[] = []
    const choice = addChoice({
      label: 'Page',
      options: [
        { value: 'system', label: 'System' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ],
      value: 'system',
      onChange: (v) => changes.push(v),
    })
    const radios = [...panel.querySelectorAll<HTMLInputElement>('input[type=radio]')]
    expect(panel.querySelector('legend')?.textContent).toBe('Page')
    expect(radios.map((r) => r.checked)).toEqual([true, false, false])

    radios[2]?.click()
    expect(changes).toEqual(['dark'])

    choice.set('light')
    expect(radios.map((r) => r.checked)).toEqual([false, true, false])
    expect(changes).toEqual(['dark'])
  })

  it('keeps separate radio groups apart', () => {
    const { panel, addChoice } = createSettings()
    const options = [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ]
    addChoice({ label: 'One', options, value: 'a', onChange: () => {} })
    addChoice({ label: 'Two', options, value: 'b', onChange: () => {} })
    const checked = [...panel.querySelectorAll<HTMLInputElement>('input[type=radio]')].map(
      (r) => r.checked,
    )
    expect(checked).toEqual([true, false, false, true])
  })

  it('adds a select that reports changes and can be set without reporting', () => {
    const { panel, addSelect } = createSettings()
    const changes: string[] = []
    const control = addSelect({
      label: 'Font',
      options: [
        { value: 'mono', label: 'Monospace' },
        { value: 'sans', label: 'Proportional' },
      ],
      value: 'sans',
      onChange: (v) => changes.push(v),
    })
    const select = panel.querySelector('select')
    if (!select) throw new Error('no select rendered')
    expect(select.value).toBe('sans')

    select.value = 'mono'
    select.dispatchEvent(new Event('change'))
    expect(changes).toEqual(['mono'])

    control.set('sans')
    expect(select.value).toBe('sans')
    expect(changes).toEqual(['mono'])
  })

  it('adds a range that reports every step with a formatted value', () => {
    const { panel, addRange } = createSettings()
    const changes: number[] = []
    const range = addRange({
      label: 'Font size',
      min: 12,
      max: 24,
      step: 1,
      value: 15,
      format: (v) => `${v}px`,
      onChange: (v) => changes.push(v),
    })
    const input = panel.querySelector<HTMLInputElement>('input[type=range]')
    const output = panel.querySelector('output')
    if (!input || !output) throw new Error('no range rendered')
    expect([input.min, input.max, input.step, input.value]).toEqual(['12', '24', '1', '15'])
    expect(output.textContent).toBe('15px')

    input.value = '18'
    input.dispatchEvent(new Event('input'))
    expect(changes).toEqual([18])
    expect(output.textContent).toBe('18px')

    range.set(20)
    expect(input.value).toBe('20')
    expect(output.textContent).toBe('20px')
    expect(changes).toEqual([18])
  })
})

describe('settings listbox', () => {
  function gallery(value = 'b') {
    const settings = createSettings()
    document.body.append(settings.panel)
    const changes: string[] = []
    const control = settings.addListbox({
      label: 'Editor theme',
      groups: [
        {
          label: 'Light',
          options: [
            { value: 'a', label: 'A', swatch: { bg: '#ffffff', fg: '#000000' } },
            { value: 'b', label: 'B' },
          ],
        },
        {
          label: 'Dark',
          options: [
            { value: 'c', label: 'C' },
            { value: 'd', label: 'D' },
          ],
        },
      ],
      value,
      onChange: (v) => changes.push(v),
    })
    const box = settings.panel.querySelector<HTMLElement>('[role=listbox]')
    if (!box) throw new Error('no listbox rendered')
    const selected = () =>
      box.querySelector<HTMLElement>('[aria-selected=true]')?.dataset.value ?? null
    const press = (key: string) => {
      const ev = new KeyboardEvent('keydown', { key, cancelable: true })
      box.dispatchEvent(ev)
      return ev
    }
    return { ...settings, box, changes, control, selected, press }
  }

  it('is a labelled, focusable listbox with labelled groups', () => {
    const { box } = gallery()
    const label = document.getElementById(box.getAttribute('aria-labelledby') ?? '')
    expect(label?.textContent).toBe('Editor theme')
    expect(box.tabIndex).toBe(0)
    const groups = [...box.querySelectorAll('[role=group]')].map(
      (g) => document.getElementById(g.getAttribute('aria-labelledby') ?? '')?.textContent,
    )
    expect(groups).toEqual(['Light', 'Dark'])
    const swatch = box.querySelector<HTMLElement>('.swatch')
    expect(swatch?.style.background).toBe('rgb(255, 255, 255)')
  })

  it('applies each option as the arrow keys reach it, across groups', () => {
    const { box, changes, selected, press } = gallery('b')
    expect(selected()).toBe('b')

    expect(press('ArrowDown').defaultPrevented).toBe(true)
    expect(selected()).toBe('c')
    press('ArrowDown')
    press('ArrowDown') // Stays on the last option.
    press('ArrowUp')
    press('Home')
    press('End')
    expect(changes).toEqual(['c', 'd', 'c', 'a', 'd'])
    expect(box.getAttribute('aria-activedescendant')).toBe(
      box.querySelector('[aria-selected=true]')?.id,
    )
    expect(press('a').defaultPrevented).toBe(false)
  })

  it('applies an option on click and ignores a click on the current one', () => {
    const { box, changes, selected } = gallery('b')
    const options = [...box.querySelectorAll<HTMLElement>('[role=option]')]
    options[0]?.click()
    options[0]?.click()
    expect(changes).toEqual(['a'])
    expect(selected()).toBe('a')
  })

  it('closes the panel on Enter', () => {
    const { panel, press } = gallery()
    let hidden = 0
    panel.hidePopover = () => {
      hidden++
    }
    press('Enter')
    expect(hidden).toBe(1)
  })

  it('can be set without reporting', () => {
    const { changes, control, selected } = gallery('b')
    control.set('d')
    expect(selected()).toBe('d')
    expect(changes).toEqual([])
  })
})

describe('settings panel position', () => {
  function openAt(right: number, bottom: number, viewport: number) {
    const { button, panel } = createSettings()
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: viewport,
    })
    button.getBoundingClientRect = () => ({ right, bottom }) as DOMRect
    const ev = new Event('beforetoggle') as Event & { newState: string }
    ev.newState = 'open'
    panel.dispatchEvent(ev)
    return panel.style
  }

  it('lines the panel up with the right edge of the gear', () => {
    expect(openAt(1270, 40, 1280)).toMatchObject({ left: '950px', top: '46px', width: '320px' })
  })

  it('scrolls inside the panel rather than running off the bottom', () => {
    expect(openAt(1270, 40, 1280).maxHeight).toBe('calc(var(--app-height, 100dvh) - 54px)')
  })

  it('keeps the panel on screen when the gear wraps to the left', () => {
    expect(openAt(250, 80, 375)).toMatchObject({ left: '8px', width: '320px' })
    expect(openAt(300, 80, 250)).toMatchObject({ left: '8px', width: '234px' })
  })
})
