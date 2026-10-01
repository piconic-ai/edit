# Self-hosting notes

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fpiconic-ai%2Fedit)

The deployment button requires a Cloudflare
account with R2 enabled and a GitHub account. It creates your own repository,
Worker, Durable Object namespace and R2 bucket using the root `wrangler.json`.
The relay is public by default; configure Access to require sign-in.

## Protect the entire deployment

Set up a [Cloudflare Access self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
for your custom hostname. Leave its path empty: pedit needs the browser editor,
`/api/*` and WebSockets protected together. Allow both the people running the
CLI and their collaborators in your Access policy.

pedit relies on Access at Cloudflare's edge; the Worker does not independently
validate Access JWTs. Configure Access before publishing the hostname, and
close alternative public routes. In your repository's `wrangler.json`, add:

```json
"routes": [{ "pattern": "pedit.example.com", "custom_domain": true }],
"workers_dev": false,
"preview_urls": false
```

Remove any other unprotected routes to the same Worker. After deployment,
check that a signed-out browser must sign in and a disallowed identity cannot
reach the editor or API.

## CLI sign-in

Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)
on the computer running pedit, then:

```sh
PEDIT_SERVER=https://pedit.example.com pedit notes.md
```

pedit detects Access and uses cloudflared to open browser sign-in when needed.
Collaborators only need their browsers. No Cloudflare Tunnel is needed.

The CLI reads its token once at startup and does not refresh it during a
session. If it expires, finish with Ctrl+C, restart pedit and share the new
session link.

## Attachment cleanup

`pnpm run deploy` applies the rules in `scripts/r2-lifecycle.json` to the bucket
bound as `BLOBS`. They expire encrypted attachments under `rooms/` after one
day as a backstop if deletion on host disconnect fails.

Use a dedicated bucket: deployment replaces its lifecycle configuration.
Keep any additional rules in `scripts/r2-lifecycle.json`; dashboard-only
changes are overwritten on the next deployment.

If applying the cleanup rules fails, deployment reports an error even if the
Worker was already published. Fix the bucket or permission issue and rerun
`pnpm run deploy` to apply the rules.
