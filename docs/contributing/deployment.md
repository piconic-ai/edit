# Releases and deployments

Maintainer operations for the piconic deployments. For your own server, use
the [self-hosting guide](../self-hosting.md).

Production (`edit.piconic.ai`) deploys when a tagpr release PR is merged
(see `.github/workflows/tagpr.yml`): the merge tags the release, the workflow
fast-forwards the `release` branch to the tag, and Cloudflare Workers Builds
deploys `release`. Every other branch gets its own
[Worker Preview](https://developers.cloudflare.com/workers/previews/) on push, at
`https://<branch-name>-edit.<subdomain>.workers.dev`, with its own Durable Object
namespace and its own logs under the Preview's Observability tab (Cloudflare
dashboard → piconic edit Worker → Previews). Previews are configured by the `previews`
block in `packages/worker/wrangler.jsonc`.

To try a Preview with the CLI:

```sh
PEDIT_SERVER=https://<branch-name>-edit.<subdomain>.workers.dev go run ./cmd/pedit notes.md
```

Workers Builds settings (Cloudflare dashboard → piconic edit Worker → Settings → Build):

| Setting | Value |
| --- | --- |
| Git repository | `piconic-ai/edit` |
| Root directory | `/` |
| Production branch | `release` |
| Build command | *(empty)* |
| Deploy command | `pnpm run deploy:production` |
| Non-production branch builds | enabled |
| Preview command | `pnpm run preview` |

When adopting the root self-hosting configuration, change the production
Workers Builds deploy command to `pnpm run deploy:production` **before** building
the release with these changes. `pnpm run deploy` now deploys `wrangler.json`
for self-hosting; production, previews and the lab still use
`packages/worker/wrangler.jsonc`. This dashboard setting is not changed by Git.

### Attachment buckets

Pasted images are stored in R2 as ciphertext while their room's host is
connected, and the room deletes them when the host leaves. Each deployment
needs its bucket, with a lifecycle rule that expires anything a failed
deletion leaves behind:

```sh
for bucket in edit-blobs edit-blobs-preview edit-lab-blobs; do
  pnpm --filter @pedit/worker exec wrangler r2 bucket create "$bucket"
  pnpm --filter @pedit/worker exec wrangler r2 bucket lifecycle add "$bucket" expire-rooms rooms/ --expire-days 1
done
```

`edit-blobs` is production's, `edit-blobs-preview` is shared by every Preview,
and `edit-lab-blobs` is the lab's.

### Lab

`edit-lab.piconic.ai` is a second Worker (`edit-lab`) for experiments that should
not touch production, such as putting the whole host behind Cloudflare Access.
It is defined as the `lab` environment in `packages/worker/wrangler.jsonc`, has
its own Durable Object namespace, and is deployed by hand:

```sh
pnpm run deploy:lab
PEDIT_SERVER=https://edit-lab.piconic.ai go run ./cmd/pedit notes.md
```

Deploying it is also a rehearsal of self-hosting pedit on another Cloudflare account.
