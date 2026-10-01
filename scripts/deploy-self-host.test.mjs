import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { deploySelfHost } from './deploy-self-host.mjs'

test('maintainer commands select their config despite the root self-host config', () => {
  const workerPackage = new URL('../packages/worker/package.json', import.meta.url)
  const pkg = JSON.parse(readFileSync(workerPackage, 'utf8'))
  const { unstable_readConfig: readConfig } = createRequire(workerPackage)('wrangler')
  for (const name of ['dev', 'deploy', 'cf-typegen', 'deploy:lab', 'preview']) {
    const configArg = pkg.scripts[name].match(/--config\s+(\S+)/)?.[1]
    assert.ok(configArg, `${name} must not rely on Wrangler's config discovery`)
    const configPath = fileURLToPath(new URL(configArg, workerPackage))
    const config = readConfig({
      config: configPath,
      env: name === 'deploy:lab' ? 'lab' : undefined,
    })
    assert.equal(config.configPath, configPath)
    assert.equal(config.name, name === 'deploy:lab' ? 'edit-lab' : 'edit')
    assert.equal(
      config.r2_buckets[0].bucket_name,
      name === 'deploy:lab' ? 'edit-lab-blobs' : 'edit-blobs',
    )
    if (name === 'preview') {
      assert.equal(config.previews.durable_objects.bindings[0].class_name, 'Room')
      assert.equal(config.previews.r2_buckets[0].bucket_name, 'edit-blobs-preview')
    }
  }
})

test('cleanup uses the provisioned bucket after deployment, including jurisdiction', () => {
  const calls = []
  let config = { r2_buckets: [{ binding: 'BLOBS', bucket_name: 'before' }] }
  deploySelfHost({
    run: (args) => {
      calls.push(args)
      if (args.includes('deploy')) {
        config = {
          r2_buckets: [{ binding: 'BLOBS', bucket_name: 'team-images', jurisdiction: 'eu' }],
        }
      }
    },
    readConfig: () => config,
  })
  assert.equal(calls.length, 3)
  const cleanup = calls[2]
  assert.deepEqual(cleanup.slice(4, 10), [
    'r2',
    'bucket',
    'lifecycle',
    'set',
    'team-images',
    '--file',
  ])
  const policy = JSON.parse(readFileSync(cleanup[10], 'utf8'))
  assert.equal(policy.rules.length, 1)
  assert.equal(policy.rules[0].conditions.prefix, 'rooms/')
  assert.equal(policy.rules[0].deleteObjectsTransition.condition.maxAge, 86400)
  assert.ok(cleanup.includes('--force'))
  assert.deepEqual(cleanup.slice(-2), ['--jurisdiction', 'eu'])
  assert.equal(calls[1].at(-1), cleanup[cleanup.indexOf('--config') + 1])
})

test('dry run builds and packages without touching bucket lifecycle', () => {
  const calls = []
  deploySelfHost({
    dryRun: true,
    run: (args) => calls.push(args),
    readConfig: () => assert.fail('dry run must not read provisioned resources'),
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].at(-1), '--dry-run')
})

test('failed build or deployment stops before cleanup', () => {
  for (const failAt of [1, 2]) {
    let calls = 0
    assert.throws(
      () =>
        deploySelfHost({
          run: () => {
            if (++calls === failAt) throw new Error('failed')
          },
          readConfig: () => assert.fail('deployment failed'),
        }),
      /failed/,
    )
    assert.equal(calls, failAt)
  }
})

test('missing attachment binding fails rather than reporting a complete deployment', () => {
  assert.throws(() => deploySelfHost({ run: () => {}, readConfig: () => ({}) }), /BLOBS/)
})

test('button configuration publishes the whole app without production domains or previews', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.json', import.meta.url), 'utf8'))
  assert.equal(config.workers_dev, true)
  assert.equal(config.preview_urls, false)
  assert.equal(config.routes, undefined)
  assert.equal(config.env, undefined)
  assert.equal(config.previews, undefined)
  assert.ok(config.migrations.some((migration) => migration.new_sqlite_classes.includes('Room')))
  for (const path of [config.main, `${config.assets.directory}/index.html`]) {
    assert.ok(path.startsWith('packages/'))
  }
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.scripts['deploy:production'], 'pnpm --filter @pedit/worker run deploy')
})
