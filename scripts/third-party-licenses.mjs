import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * License texts for packages that are licensed but do not ship the file,
 * copied from their repositories and keyed by the `repository` URL.
 */
const VENDORED = {
  'https://github.com/uiwjs/react-codemirror': 'uiwjs-react-codemirror.txt',
}

function repositoryUrl(pkg) {
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  return url?.replace(/^git\+/, '').replace(/\.git$/, '')
}

function licenseText(dir, pkg) {
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f))
  if (file) return readFileSync(join(dir, file), 'utf8')
  const vendored = VENDORED[repositoryUrl(pkg)]
  return vendored && readFileSync(join(here, 'licenses', vendored), 'utf8')
}

/**
 * Builds a THIRD_PARTY_LICENSES text for the npm packages whose files were
 * bundled. `files` are module paths as reported by the bundler.
 */
export function thirdPartyLicenses(files, intro) {
  const packages = new Map()
  for (const file of files) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file.replace(/\\/g, '/'))
    if (!match) continue
    const dir = resolve(match[1])
    if (packages.has(dir)) continue
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const header = `${pkg.name}@${pkg.version} (${pkg.license})`
    const text = licenseText(dir, pkg)
    if (!text) throw new Error(`no license file found for ${header}`)
    packages.set(dir, { header, text: text.trim() })
  }
  const sections = [...packages.values()]
    .sort((a, b) => a.header.localeCompare(b.header))
    .map((p) => `${p.header}\n${'-'.repeat(p.header.length)}\n\n${p.text}\n`)
  return `${intro}\n\n${sections.join('\n')}`
}
