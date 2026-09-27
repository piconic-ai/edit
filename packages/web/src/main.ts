import { markdown } from '@codemirror/lang-markdown'
import { Compartment, EditorState, type Extension, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { importKey, RoomClient, type RoomStatus } from '@ima/protocol'
import { basicSetup } from 'codemirror'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import {
  type Appearance,
  applyPage,
  applyText,
  FONT_SIZE,
  type Font,
  LINE_HEIGHT,
  loadAppearance,
  pickTheme,
  resolveAppearance,
  saveAppearance,
} from './appearance.ts'
import { h } from './dom.ts'
import { avatarFor, fetchIdentity, initials } from './identity.ts'
import { resolveLanguage } from './language.ts'
import { PreviewPane } from './pane.ts'
import { colorFor, parseRoomLocation, participants, roomSocketUrl, selectionTint } from './room.ts'
import { createSettings, type Settings } from './settings.ts'
import { Splitter } from './splitter.ts'
import {
  fallbackTheme,
  loadTheme,
  readerTheme,
  THEMES,
  type ThemeInfo,
  ThemeSwitcher,
} from './themes.ts'
import { NARROW_QUERY, type ViewMode, ViewSwitch } from './view.ts'
import { loadVimMode, VimToggle, vimExtension } from './vim.ts'
import './style.css'

const NAME_KEY = 'ima:name'
const DARK_QUERY = '(prefers-color-scheme: dark)'
const app = document.getElementById('app') as HTMLElement

function loadName(): string | null {
  try {
    return localStorage.getItem(NAME_KEY)
  } catch {
    return null
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name)
  } catch {
    // Private mode or storage disabled: ask again next time.
  }
}

function showCard(title: string, body: (Node | string)[]): HTMLElement {
  const card = h('div', { className: 'card' }, [h('h1', { textContent: title }), ...body])
  app.replaceChildren(h('div', { className: 'center' }, [card]))
  return card
}

function showLanding(): void {
  showCard('ima', [
    h('p', {}, [
      'Co-edit a local text file, right now. Run ',
      h('code', { textContent: 'ima notes.md' }),
      ' and share the link it prints. ',
      h('a', {
        href: 'https://github.com/piconic-ai/ima#install',
        textContent: 'How to install',
      }),
    ]),
    h('p', { textContent: '居間 (living room) + 今 (now).' }),
  ])
}

function askName(): Promise<string> {
  return new Promise((resolve) => {
    const input = h('input', {
      name: 'name',
      placeholder: 'Your name',
      autocomplete: 'name',
      required: true,
      maxLength: 40,
    })
    const form = h('form', {}, [input, h('button', { type: 'submit', textContent: 'Join' })])
    form.addEventListener('submit', (ev) => {
      ev.preventDefault()
      const name = input.value.trim()
      if (!name) return
      saveName(name)
      resolve(name)
    })
    showCard('Join the room', [
      h('p', { textContent: 'Others will see this name next to your cursor.' }),
      form,
    ])
    input.focus()
  })
}

interface Me {
  name: string
  avatar?: string
}

interface LoadedTheme {
  id: string
  extension: Extension
}

/** Offline or a stale deploy: start on the ima theme of the same scheme. */
function loadStartTheme(id: string): Promise<LoadedTheme> {
  return loadTheme(id).then(
    (extension) => ({ id, extension }),
    () => fallbackTheme(id),
  )
}

function lineWrapping(on: boolean): Extension {
  return on ? EditorView.lineWrapping : []
}

/** The Appearance and Text sections of the settings panel. */
function addAppearanceSettings(
  settings: Settings,
  editor: EditorView,
  themes: ThemeSwitcher,
  wrap: Compartment,
  initial: Appearance,
): void {
  const prefersDark = matchMedia(DARK_QUERY)
  let current = initial
  const update = (next: Appearance) => {
    current = next
    saveAppearance(next)
  }
  const showTheme = async () => {
    const { editorTheme } = resolveAppearance(current, prefersDark.matches)
    gallery.set(editorTheme)
    if (editorTheme === themes.id) return
    if (!(await themes.set(editorTheme))) gallery.set(themes.id)
  }
  const swatches = (scheme: ThemeInfo['scheme']) =>
    THEMES.filter((t) => t.scheme === scheme).map((t) => ({
      value: t.id,
      label: t.label,
      swatch: { bg: t.bg, fg: t.fg },
    }))

  settings.addSection('Appearance')
  settings.addChoice({
    label: 'Page',
    options: [
      { value: 'system', label: 'System' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ],
    value: current.page,
    onChange: (page) => {
      update({ ...current, page })
      applyPage(current)
      void showTheme()
    },
  })
  const gallery = settings.addListbox({
    label: 'Editor theme',
    groups: [
      { label: 'Light', options: swatches('light') },
      { label: 'Dark', options: swatches('dark') },
    ],
    value: themes.id,
    onChange: (id) => {
      update(pickTheme(current, id, prefersDark.matches))
      void showTheme()
    },
  })
  // A theme that follows the page moves to the reader's pick for the other scheme.
  prefersDark.addEventListener('change', () => void showTheme())

  const setText = (next: Appearance) => {
    update(next)
    applyText(current)
    editor.requestMeasure()
  }
  settings.addSection('Text')
  settings.addRange({
    label: 'Font size',
    ...FONT_SIZE,
    value: current.fontSize,
    format: (v) => `${v}px`,
    onChange: (fontSize) => setText({ ...current, fontSize }),
  })
  settings.addSelect<Font>({
    label: 'Font',
    options: [
      { value: 'mono', label: 'Monospace' },
      { value: 'sans', label: 'Proportional' },
    ],
    value: current.font,
    onChange: (font) => setText({ ...current, font }),
  })
  settings.addRange({
    label: 'Line height',
    ...LINE_HEIGHT,
    value: current.lineHeight,
    format: (v) => v.toFixed(1),
    onChange: (lineHeight) => setText({ ...current, lineHeight }),
  })
  settings.addToggle({
    label: 'Wrap long lines',
    checked: current.wrap,
    onChange: (on) => {
      update({ ...current, wrap: on })
      editor.dispatch({ effects: wrap.reconfigure(lineWrapping(on)) })
    },
  })
}

async function joinRoom(
  id: string,
  key: string,
  me: Me,
  appearance: Appearance,
  theme: LoadedTheme,
): Promise<void> {
  const doc = new Y.Doc()
  const text = doc.getText('content')
  const awareness = new Awareness(doc)
  const color = colorFor(doc.clientID)
  awareness.setLocalState({ user: { ...me, color, colorLight: selectionTint(color) } })

  const status = h('span', { className: 'status' }, [h('span', { className: 'dot' }), h('span')])
  const file = h('span', { className: 'file' })
  const people = h('ul', { className: 'people', ariaLabel: 'Participants' })
  // The room closes as soon as the host leaves (or was never there).
  const reconnect = h('button', { type: 'button', textContent: 'Reconnect' })
  reconnect.addEventListener('click', () => location.reload())
  const banner = h('div', { className: 'banner', role: 'status', hidden: true }, [
    h('span', {
      textContent:
        'This session has ended: the host is not connected. You can still copy the text.',
    }),
    reconnect,
  ])
  const settings = createSettings()
  // CodeMirror forces display on .cm-editor, so the panes are hidden through a wrapper.
  const source = h('div', { className: 'source' })
  const main = h('main', { className: 'editor' }, [source])
  const narrow = matchMedia(NARROW_QUERY)
  // Filled in below; the switch applies its first mode before the editor exists.
  let showView: (mode: ViewMode) => void = (mode) => {
    main.dataset.view = mode
  }
  const view = new ViewSwitch({ narrow: narrow.matches, onApply: (mode) => showView(mode) })
  narrow.addEventListener('change', () => view.setNarrow(narrow.matches))
  app.replaceChildren(
    h('header', {}, [
      h('span', { className: 'brand', textContent: 'ima' }),
      file,
      status,
      people,
      view.element,
      settings.button,
    ]),
    settings.panel,
    banner,
    main,
  )

  const vimMode = new Compartment()
  const editable = new Compartment()
  const language = new Compartment()
  const themeMode = new Compartment()
  const wrap = new Compartment()
  // Reused so switching back to Markdown does not reparse the document.
  const markdownSupport = markdown()
  const readOnly = [EditorState.readOnly.of(true), EditorView.editable.of(false)]
  const undoManager = new Y.UndoManager(text)
  const editor = new EditorView({
    parent: source,
    extensions: [
      // The Vim keymap must see keys before basicSetup's.
      vimMode.of([]),
      basicSetup,
      // Undo only this browser's edits, not everyone's.
      Prec.high(keymap.of(yUndoManagerKeymap)),
      language.of(markdownSupport),
      themeMode.of(theme.extension),
      readerTheme,
      wrap.of(lineWrapping(appearance.wrap)),
      editable.of([]),
      yCollab(text, awareness, { undoManager }),
    ],
  })

  const followEditor = () => {
    if (main.dataset.view === 'split') preview.follow(editor)
  }
  const preview = new PreviewPane(text, { onRender: followEditor })
  const splitter = new Splitter(main, { onResize: followEditor })
  main.append(splitter.element, preview.element)
  let following = 0
  editor.scrollDOM.addEventListener('scroll', () => {
    following ||= requestAnimationFrame(() => {
      following = 0
      followEditor()
    })
  })
  showView = (mode) => {
    main.dataset.view = mode
    preview.active = mode !== 'editor'
    editor.requestMeasure()
    followEditor()
  }
  showView(view.mode)

  addAppearanceSettings(
    settings,
    editor,
    new ThemeSwitcher(editor, themeMode, theme.id),
    wrap,
    appearance,
  )
  settings.addSection('Editor')
  const vim = new VimToggle(editor, vimMode, () => vimExtension(undoManager))
  const setVim = async (on: boolean) => {
    if (!(await vim.set(on))) vimToggle.set(vim.on)
  }
  const vimOn = loadVimMode()
  const vimToggle = settings.addToggle({
    label: 'Vim keybindings',
    hint: 'Only in this browser.',
    checked: vimOn,
    onChange: (on) => void setVim(on),
  })
  if (vimOn) void setVim(true)

  const setStatus = (s: RoomStatus) => {
    status.dataset.status = s
    const label = status.lastElementChild as HTMLElement
    label.textContent =
      s === 'connected'
        ? 'Connected'
        : s === 'connecting'
          ? 'Connecting…'
          : s === 'closed'
            ? 'Ended'
            : 'Offline'
    if (s === 'closed') {
      banner.hidden = false
      editor.dispatch({ effects: editable.reconfigure(readOnly) })
    }
  }

  // Markdown until the host tells us the file name; other languages load lazily.
  let languageFor: string | undefined
  const applyLanguage = async (fileName: string) => {
    if (fileName === languageFor) return
    languageFor = fileName
    const lang = resolveLanguage(fileName)
    view.setEnabled(lang.kind === 'markdown')
    let support: Extension
    try {
      support =
        lang.kind === 'markdown'
          ? markdownSupport
          : lang.kind === 'plain'
            ? []
            : await lang.description.load()
    } catch {
      // Offline or a stale deploy: keep editing without highlighting.
      support = []
    }
    // A newer file name may have arrived while the language was loading.
    if (fileName !== languageFor) return
    editor.dispatch({ effects: language.reconfigure(support) })
  }

  const renderPeople = () => {
    const list = participants(awareness.getStates(), doc.clientID)
    people.replaceChildren(
      ...list.map((p) => {
        const face = h('span', { className: 'avatar', textContent: initials(p.name) })
        if (p.avatar) {
          const img = h('img', { src: p.avatar, alt: '', referrerPolicy: 'no-referrer' })
          // Unknown to Gravatar (d=404) or blocked: keep the initials.
          img.addEventListener('error', () => img.remove())
          face.append(img)
        }
        const label = `${p.name}${p.isHost ? ' (host)' : ''}${p.isSelf ? ' (you)' : ''}`
        const li = h('li', { title: label }, [face, h('span', { textContent: label })])
        li.style.setProperty('--c', p.color)
        return li
      }),
    )
    const host = [...awareness.getStates().values()].find((s) => s.role === 'host')
    // Keep showing the file name after the host has gone.
    if (typeof host?.file === 'string') {
      file.textContent = host.file
      document.title = `${host.file} · ima`
      void applyLanguage(host.file)
    }
  }

  const client = new RoomClient({
    url: roomSocketUrl(location, id),
    key: await importKey(key),
    doc,
    awareness,
    onStatus: (s) => {
      setStatus(s)
      renderPeople()
    },
  })
  awareness.on('change', renderPeople)

  setStatus('connecting')
  client.connect()
  renderPeople()
  window.addEventListener('pagehide', () => void client.destroy())
}

async function start(): Promise<void> {
  // index.html applied the stored values already; this validates and completes them.
  const appearance = loadAppearance()
  applyPage(appearance)
  applyText(appearance)
  if (location.pathname === '/' || location.pathname === '') {
    showLanding()
    return
  }
  const room = parseRoomLocation(location)
  if (!room) {
    showCard('This link is incomplete', [
      h('p', { textContent: 'Ask the host to copy the whole URL, including the part after #.' }),
    ])
    return
  }
  // Fetch the editor theme meanwhile, so the editor paints in it from the start.
  const theme = loadStartTheme(
    resolveAppearance(appearance, matchMedia(DARK_QUERY).matches).editorTheme,
  )
  // Behind Cloudflare Access we already know who you are.
  const identity = await fetchIdentity()
  const me: Me = identity
    ? { name: identity.name, avatar: await avatarFor(identity) }
    : { name: loadName() ?? (await askName()) }
  await joinRoom(room.id, room.key, me, appearance, await theme)
}

void start()
