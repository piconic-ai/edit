# Self-hosting with Cloudflare Access

## Deploy from your browser

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fpiconic-ai%2Fedit)

Sign in to Cloudflare and GitHub, enable R2 if prompted, and choose your
repository, Worker and bucket names. Accept the root directory `/`, build
command `pnpm run build` and deploy command `pnpm run deploy`.
The setup copies the whole repository so all workspace dependencies are available.

Cloudflare builds the browser editor, provisions the Worker, SQLite Durable
Object and private R2 bucket, then publishes a `workers.dev` URL. The deploy
script also applies a one-day expiry rule to encrypted attachments under
`rooms/`, as a backstop for failed session cleanup.

```sh
PEDIT_SERVER=https://<worker>.<subdomain>.workers.dev pedit notes.md
```

No domain or local build tools are needed for this flow. Cloudflare resources
and billing belong to your account. The relay is public by default: anyone
with a full session link can read and edit while the host is connected.
Cloudflare Access is an optional additional sign-in requirement.

The button uses the root `wrangler.json`, which has no piconic domains or
production bindings. Production and the lab use `packages/worker/wrangler.jsonc`.
See [Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
for the setup flow and supported resource provisioning.

## Add Cloudflare Access

For a custom domain, use an active Cloudflare DNS zone in the same account,
and configure an identity provider in Cloudflare Zero Trust.

Before using private documents:

1. Choose a hostname such as `pedit.example.com` and create the Access
   application described below.
2. In your new repository's `wrangler.json`, add
   `"routes": [{ "pattern": "pedit.example.com", "custom_domain": true }]`,
   set `"workers_dev": false` and keep `"preview_urls": false`.
3. Push the change to your deployment branch. Workers Builds redeploys it.

Configure the Access application before publishing the custom hostname:

1. In Cloudflare Zero Trust, open **Access controls → Applications → Create new application**.
2. Choose **Self-hosted and private**, then **Add public hostname**.
3. Set the hostname to `pedit.example.com`. Leave the path empty to protect the
   entire host, including `/api/*`, WebSockets and the browser editor.
4. Create and attach an **Allow** policy for the email addresses or identity
   provider groups that should have access. Include both hosts and collaborators.
5. Select your identity provider and a session duration suitable for your sessions,
   then create the application.

Access denies users who do not match an Allow policy. See Cloudflare's
[self-hosted application guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
and [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/).

This deployment runs directly on Workers, so no Tunnel is needed. pedit relies
on Access enforcing the custom hostname at Cloudflare's edge; the Worker does
not independently validate Access JWTs. Protect every route to this deployment
and keep alternative public hostnames disabled.

Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)
on the host computer (`brew install cloudflared` on macOS), then:

```sh
PEDIT_SERVER=https://pedit.example.com pedit notes.md
```

pedit detects Access and opens a browser sign-in through cloudflared when
needed. Collaborators sign in in their browsers; they need neither CLI.
The CLI reads its token once at startup. If it expires, finish with Ctrl+C,
restart pedit and share the new link to reconnect with a fresh token.

## Verify Access and local saving

Use a test Markdown file to check that:

- A signed-out browser is asked to sign in, and a disallowed identity is denied.
- An allowed host can run pedit and an allowed collaborator can join and edit.
- Edits reach the local file; Ctrl+C closes the room and saves the final state.
- A pasted test image is saved under local `assets/`, and its encrypted R2
  object is removed after the host leaves.
- Workers dashboard settings expose no unprotected `workers.dev`, preview URL
  or additional route to the same deployment.

For privacy boundaries and log retention, see [security](security.md).
For the project's own release and preview setup, see [deployment](deployment.md).

## Deploy with the CLI instead

Requires Node.js 22+, pnpm 10.7.1 and a Cloudflare account with R2 enabled:

```sh
git clone https://github.com/piconic-ai/edit.git
cd edit
pnpm install --frozen-lockfile
pnpm --filter @pedit/worker exec wrangler login
pnpm run deploy
```

Wrangler provisions the configured bucket if it does not exist; change the
Worker and bucket names in `wrangler.json` if needed. To only validate the
build and packaging, run `pnpm run deploy --dry-run`; it skips remote cleanup
configuration. Keep this file valid JSON because the deployment script reads it.

If bucket cleanup configuration fails, the deploy script exits with an error
even if the Worker was published. Correct the permission or bucket issue and
rerun the deployment; applying the same named lifecycle rule is repeatable.

The deploy script manages lifecycle configuration for this dedicated bucket
from `scripts/r2-lifecycle.json`. Add any additional lifecycle rules to that
file; dashboard-only lifecycle changes are replaced on the next deployment.
