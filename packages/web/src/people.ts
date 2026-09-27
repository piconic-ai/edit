/** How many faces the collapsed row shows before "+N". */
export const MAX_FACES = 3

/** Tells CSS how many people the collapsed row leaves out, as `data-more`. */
export function setMore(list: HTMLElement, count: number): void {
  const more = Math.max(0, count - MAX_FACES)
  if (more > 0) list.dataset.more = `+${more}`
  else delete list.dataset.more
}

/**
 * On narrow screens the participants show as a row of faces; tapping the row
 * shows their names, and tapping again hides them. Screen readers get the
 * names either way, since CSS only hides them visually.
 */
export function expandOnTap(list: HTMLElement, isNarrow: () => boolean): void {
  list.addEventListener('click', () => {
    if (!isNarrow() || 'expanded' in list.dataset) delete list.dataset.expanded
    else list.dataset.expanded = ''
  })
}
