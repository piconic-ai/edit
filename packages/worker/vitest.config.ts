import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // A small attachment quota, so the tests can fill it.
      miniflare: { bindings: { BLOB_QUOTA_BYTES: '100', BLOB_QUOTA_COUNT: '3' } },
    }),
  ],
})
