import { h } from './dom.ts'

const LABEL = 'Copy text'
const RESET_MS = 2000

type Clipboard = Pick<globalThis.Clipboard, 'writeText'>

/** False where the Clipboard API is missing (not a secure context) or refused. */
export async function copyText(
  text: string,
  clipboard: Clipboard | undefined = navigator.clipboard,
): Promise<boolean> {
  try {
    if (!clipboard) return false
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * A button that copies the whole document. Selecting all of it by hand does
 * not work on a phone: the editor only draws the lines on screen.
 */
export function copyButton(
  getText: () => string,
  options: { clipboard?: Clipboard; resetMs?: number } = {},
): HTMLButtonElement {
  const button = h('button', { type: 'button', textContent: LABEL })
  let timer: ReturnType<typeof setTimeout> | undefined
  button.addEventListener('click', async () => {
    const clipboard = 'clipboard' in options ? options.clipboard : navigator.clipboard
    const ok = await copyText(getText(), clipboard)
    button.textContent = ok ? 'Copied' : 'Could not copy'
    clearTimeout(timer)
    timer = setTimeout(() => {
      button.textContent = LABEL
    }, options.resetMs ?? RESET_MS)
  })
  return button
}
