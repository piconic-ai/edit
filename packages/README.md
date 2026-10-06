# pedit relay and browser editor

This directory is the standalone server workspace for
[pedit](https://github.com/piconic-ai/pedit). Deploy to Cloudflare copies it
without the Go CLI. Node.js 22+, pnpm 10.7.1 and a Cloudflare account with
R2 enabled are required.

```sh
pnpm install --frozen-lockfile
pnpm run deploy
```

`wrangler.json` configures your Worker, browser assets, Room Durable Object
and attachment bucket. Deployment builds the editor and applies
`scripts/r2-lifecycle.json` to the provisioned `BLOBS` bucket. Use a dedicated
bucket: deployment replaces its lifecycle configuration. Encrypted attachments
under `rooms/` expire after one day as a backstop for failed deletion.

Install the CLI separately from
[GitHub Releases](https://github.com/piconic-ai/pedit/releases), then use:

```sh
# Set server: https://<worker>.<subdomain>.workers.dev in .pedit/config.yaml
pedit notes.md
```

The relay is public by default. See the
[self-hosting guide](https://github.com/piconic-ai/pedit/blob/main/docs/self-hosting.md)
for Cloudflare Access setup. Maintainer deployment commands explicitly use
`worker/wrangler.jsonc`, which is separate from the self-host configuration.
