import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const configPath = fileURLToPath(new URL('../wrangler.json', import.meta.url))
const lifecyclePath = fileURLToPath(new URL('./r2-lifecycle.json', import.meta.url))

// Read after deployment: Deploy to Cloudflare / Wrangler can rewrite resource
// names. Never apply the cleanup rule to a hard-coded bucket in another config.
export function deploySelfHost({ run, readConfig, dryRun = false }) {
  run(['--filter', '@pedit/web', 'build'])
  const wrangler = ['--filter', '@pedit/worker', 'exec', 'wrangler']
  run([...wrangler, 'deploy', '--config', configPath, ...(dryRun ? ['--dry-run'] : [])])
  if (dryRun) return

  const blob = readConfig().r2_buckets?.find((binding) => binding.binding === 'BLOBS')
  if (!blob?.bucket_name) throw new Error('Deployed config has no BLOBS bucket name')
  run([
    ...wrangler,
    'r2',
    'bucket',
    'lifecycle',
    'set',
    blob.bucket_name,
    '--file',
    lifecyclePath,
    '--force',
    '--config',
    configPath,
    ...(blob.jurisdiction ? ['--jurisdiction', blob.jurisdiction] : []),
  ])
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== '--dry-run')) {
    console.error('Usage: pnpm run deploy [--dry-run]')
    process.exit(1)
  }
  try {
    deploySelfHost({
      dryRun: args.includes('--dry-run'),
      readConfig: () => JSON.parse(readFileSync(configPath, 'utf8')),
      run: (args) => {
        const result = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit' })
        if (result.error) throw result.error
        if (result.status !== 0) throw new Error(`pnpm failed (exit ${result.status})`)
      },
    })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
