// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { expandOnTap, MAX_FACES, setMore } from '../src/people.ts'

describe('expandOnTap', () => {
  it('shows and hides the names on narrow screens', () => {
    const list = document.createElement('ul')
    expandOnTap(list, () => true)
    list.click()
    expect('expanded' in list.dataset).toBe(true)
    list.click()
    expect('expanded' in list.dataset).toBe(false)
  })

  it('does nothing on wide screens, where the names always show', () => {
    const list = document.createElement('ul')
    let narrow = true
    expandOnTap(list, () => narrow)
    list.click()
    narrow = false
    list.click()
    expect('expanded' in list.dataset).toBe(false)
    list.click()
    expect('expanded' in list.dataset).toBe(false)
  })
})

describe('setMore', () => {
  it('counts the people past the faces the row shows', () => {
    const list = document.createElement('ul')
    setMore(list, MAX_FACES + 2)
    expect(list.dataset.more).toBe('+2')
  })

  it('clears the count once everyone fits', () => {
    const list = document.createElement('ul')
    setMore(list, MAX_FACES + 1)
    setMore(list, MAX_FACES)
    expect('more' in list.dataset).toBe(false)
  })
})
