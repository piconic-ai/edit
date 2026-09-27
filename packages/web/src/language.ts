import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'

/**
 * How to highlight the shared file. Markdown is bundled with the editor;
 * everything else is loaded on demand from @codemirror/language-data.
 */
export type Language =
  | { kind: 'markdown' }
  | { kind: 'plain' }
  | { kind: 'lazy'; description: LanguageDescription }

// Extensions we read differently from @codemirror/language-data.
const overrides = new Map<string, string | null>([
  // Obsidian canvas files are JSON.
  ['canvas', 'JSON'],
  // Tables have their own view (table.ts); highlighting would only add noise.
  ['csv', null],
  ['tsv', null],
  // Not in language-data, so it would otherwise fall back to Markdown.
  ['txt', null],
])

function byName(name: string): LanguageDescription | null {
  return languages.find((l) => l.name === name) ?? null
}

/** Picks the language for the host's file name, defaulting to Markdown. */
export function resolveLanguage(file: string | undefined): Language {
  const name = (file ?? '').split(/[\\/]/).pop() ?? ''
  const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase()
  if (ext !== undefined && overrides.has(ext)) {
    const override = overrides.get(ext)
    const description = override ? byName(override) : null
    return description ? { kind: 'lazy', description } : { kind: 'plain' }
  }
  // Match on a lowercased extension so NOTES.MD is still Markdown.
  const normalized = ext ? `${name.slice(0, -ext.length)}${ext}` : name
  const description = LanguageDescription.matchFilename(languages, normalized)
  if (!description || description.name === 'Markdown') return { kind: 'markdown' }
  return { kind: 'lazy', description }
}
