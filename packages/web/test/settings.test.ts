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

describe('settings gallery', () => {
  function preview(name: string) {
    return () => {
      const el = document.createElement('span')
      el.className = 'preview'
      el.dataset.name = name
      return el
    }
  }

  function gallery(value = 'b') {
    const settings = createSettings()
    document.body.append(settings.panel)
    settings.addSection('Appearance')
    const changes: string[] = []
    const control = settings.addGallery({
      label: 'Theme',
      groups: [
        {
          label: 'Light',
          options: [
            { value: 'a', label: 'A', preview: preview('a') },
            { value: 'b', label: 'B', preview: preview('b') },
          ],
        },
        {
          label: 'Dark',
          options: [
            { value: 'c', label: 'C', preview: preview('c') },
            { value: 'd', label: 'D', preview: preview('d') },
          ],
        },
      ],
      value,
      onChange: (v) => changes.push(v),
    })
    settings.addToggle({ label: 'Wrap', checked: true, onChange: () => {} })
    const panel = settings.panel
    const home = panel.querySelector<HTMLElement>('.settings-home')
    const page = panel.querySelector<HTMLElement>('.settings-page')
    const row = panel.querySelector<HTMLButtonElement>('.settings-nav')
    const box = panel.querySelector<HTMLElement>('[role=listbox]')
    const back = panel.querySelector<HTMLButtonElement>('.settings-back')
    if (!home || !page || !row || !box || !back) throw new Error('no gallery rendered')
    const selected = () =>
      box.querySelector<HTMLElement>('[aria-selected=true]')?.dataset.value ?? null
    const press = (key: string, target: HTMLElement = box) => {
      const ev = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true })
      target.dispatchEvent(ev)
      return ev
    }
    return { ...settings, home, page, row, box, back, changes, control, selected, press }
  }

  it('shows only the current option on the settings page', () => {
    const { home, page, row } = gallery('b')
    expect(home.hidden).toBe(false)
    expect(page.hidden).toBe(true)
    expect(row.textContent).toContain('Theme')
    expect(row.textContent).toContain('B')
    expect(row.getAttribute('aria-label')).toBe('Theme: B')
    expect(row.getAttribute('aria-haspopup')).toBe('listbox')
    expect(row.querySelector<HTMLElement>('.preview')?.dataset.name).toBe('b')
  })

  it('opens a page of cards in place of the settings, with the list focused', () => {
    const { home, page, row, box } = gallery()
    row.click()
    expect(home.hidden).toBe(true)
    expect(page.hidden).toBe(false)
    expect(document.activeElement).toBe(box)
    const title = document.getElementById(box.getAttribute('aria-labelledby') ?? '')
    expect(title?.textContent).toBe('Theme')
    const groups = [...box.querySelectorAll('[role=group]')].map(
      (g) => document.getElementById(g.getAttribute('aria-labelledby') ?? '')?.textContent,
    )
    expect(groups).toEqual(['Light', 'Dark'])
    const cards = [...box.querySelectorAll<HTMLElement>('[role=option]')]
    expect(cards.map((c) => c.querySelector<HTMLElement>('.preview')?.dataset.name)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ])
  })

  it('applies each option as the arrow keys reach it, across groups, and updates the row', () => {
    const { box, row, changes, selected, press } = gallery('b')
    row.click()
    expect(press('ArrowDown').defaultPrevented).toBe(true)
    expect(selected()).toBe('c')
    press('ArrowRight')
    press('ArrowRight') // Stays on the last option.
    press('ArrowLeft')
    press('ArrowUp')
    press('Home')
    press('End')
    expect(changes).toEqual(['c', 'd', 'c', 'b', 'a', 'd'])
    expect(box.getAttribute('aria-activedescendant')).toBe(
      box.querySelector('[aria-selected=true]')?.id,
    )
    expect(row.getAttribute('aria-label')).toBe('Theme: D')
    expect(row.querySelector<HTMLElement>('.preview')?.dataset.name).toBe('d')
    expect(press('a').defaultPrevented).toBe(false)
  })

  it('applies an option on click, stays open to compare, and ignores the current one', () => {
    const { box, page, row, changes, selected } = gallery('b')
    row.click()
    const options = [...box.querySelectorAll<HTMLElement>('[role=option]')]
    options[0]?.click()
    options[0]?.click()
    expect(changes).toEqual(['a'])
    expect(selected()).toBe('a')
    expect(page.hidden).toBe(false)
  })

  it.each(['Enter', 'Escape'])('goes back to the settings on %s', (key) => {
    const { home, page, row, press } = gallery()
    let hidden = 0
    ;(page.parentElement as HTMLElement).hidePopover = () => {
      hidden++
    }
    row.click()
    expect(press(key).defaultPrevented).toBe(true)
    expect(page.hidden).toBe(true)
    expect(home.hidden).toBe(false)
    expect(document.activeElement).toBe(row)
    // Escape goes back one page instead of closing the panel.
    expect(hidden).toBe(0)
  })

  it('goes back with the back button, and leaves Escape on the settings to the popover', () => {
    const { home, page, row, back, press } = gallery()
    row.click()
    expect(back.getAttribute('aria-label')).toBe('Back to settings')
    back.click()
    expect(home.hidden).toBe(false)
    expect(page.hidden).toBe(true)
    expect(press('Escape', row).defaultPrevented).toBe(false)
  })

  it('opens on the settings again after the panel closed on the gallery', () => {
    const { panel, home, page, row } = gallery()
    row.click()
    const ev = new Event('beforetoggle') as Event & { newState: string }
    ev.newState = 'open'
    panel.dispatchEvent(ev)
    expect(home.hidden).toBe(false)
    expect(page.hidden).toBe(true)
  })

  it('can be set without reporting', () => {
    const { changes, control, selected, row } = gallery('b')
    control.set('d')
    expect(selected()).toBe('d')
    expect(row.getAttribute('aria-label')).toBe('Theme: D')
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
