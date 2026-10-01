import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { deploySelfHost } from './deploy-self-host.mjs'

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
