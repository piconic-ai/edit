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
dashboard → `edit` Worker → Previews). Previews are configured by the `previews`
block in `packages/worker/wrangler.jsonc`.

Maintainer scripts explicitly pass `--config wrangler.jsonc` from `packages/worker`.
Without it, Wrangler's config discovery can select the `packages/wrangler.json`
for self-hosting, which has no Preview configuration.

The server workspace and lockfile live in `packages/`. Root commands forward
to it, so the Workers Builds root directory and commands below stay the same.
The Deploy to Cloudflare button copies only this workspace.

To try a Preview with the CLI:

```sh
# Set server: https://<branch-name>-edit.<subdomain>.workers.dev in .pedit/config.yaml
go run ./cmd/pedit notes.md
```

Workers Builds settings (Cloudflare dashboard → `edit` Worker → Settings → Build).
They live only in the dashboard, not in Git, and are lost when the repository
is disconnected, so keep this table in sync with them:

| Setting | Production | Previews Base |
| --- | --- | --- |
| Git repository | `piconic-ai/pedit` | *(shared)* |
| Branch control | `release` | Builds for Preview branches enabled |
| Build command | *(empty)* | *(empty)* |
| Deploy / Preview command | `pnpm run deploy:production` | `pnpm run preview` |
| Root directory | `/` | `/` |
| Build watch paths | include `*`, exclude *(empty)* | include `*`, exclude *(empty)* |
| Build token | `edit build token` | *(shared)* |
| Build variables | *(none)* | *(none)* |

> [!WARNING]
> The production deploy command must be `pnpm run deploy:production`, not
> `pnpm run deploy`. `pnpm run deploy` deploys `packages/wrangler.json`, the
> self-hosting configuration. Workers Builds then only warns that the Worker
> name `pedit` does not match and deploys it as `edit` anyway, so production
> keeps serving but loses its own settings: `edit.<subdomain>.workers.dev`
> serves production, branch Previews get no URL, Workers Logs stop, and
> attachments go to the `pedit-blobs` bucket. Workers Builds may also open a
> pull request renaming the Worker in `packages/wrangler.json`; close it, as
> self-hosted deployments rely on that name.

### Maintenance mode

When the public relay has to stop (a traffic spike, abuse the rate limits do
not stop, a serious bug), set the `MAINTENANCE` variable, like a shop that
either turns away new customers or closes:

| `MAINTENANCE` | New rooms | Open rooms and reconnects | Images |
| --- | --- | --- | --- |
| *(unset)* | as usual | as usual | as usual |
| `no-new-rooms` | 503, saying the relay takes no new rooms and pointing to self-hosting | as usual | as usual |
| `closed` | 503, saying the relay is closed for maintenance | closed with `4006` | 503 |

Use `no-new-rooms` to stop growth while sessions in progress finish, and
`closed` to stop everything.

To set it: Cloudflare dashboard → `edit` Worker → Settings → Variables and
Secrets → add `MAINTENANCE` as text and deploy. Like any change of variables,
it deploys a new version within seconds, which drops every open WebSocket;
with `closed`, their reconnects are turned away. `keep_vars` in
`wrangler.jsonc` keeps the variable across release deploys, so it stays until
someone removes it.

To end it, delete the variable and deploy. Nothing reconnects on its own: a
host whose `pedit` is still running presses Enter to reconnect to the same
room, then guests press Reconnect in the editor. Guests who press it before
their host is back find the session ended.

To stop faster, without a deploy, add a WAF custom rule (Cloudflare dashboard
→ piconic.ai → Security → WAF → Custom rules) with the action Block:

- no new rooms: `http.host eq "edit.piconic.ai" and http.request.method eq "POST" and http.request.uri.path eq "/api/rooms"`
- everything: `http.host eq "edit.piconic.ai" and starts_with(http.request.uri.path, "/api/")`

Blocked requests never reach the Worker and are not billed, but clients only
see a 403: the CLI cannot say why, and browsers keep reconnecting. Disable
the rule to end it.

### Attachment buckets

Pasted images are stored in R2 as ciphertext while their room's host is
connected, and the room deletes them when the host leaves. Each deployment
needs its bucket, with a lifecycle rule that expires anything a failed
deletion leaves behind:

```sh
for bucket in edit-blobs edit-blobs-preview edit-lab-blobs; do
  pnpm --dir packages --filter @pedit/worker exec wrangler r2 bucket create "$bucket"
  pnpm --dir packages --filter @pedit/worker exec wrangler r2 bucket lifecycle add "$bucket" expire-rooms rooms/ --expire-days 1
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
# Set server: https://edit-lab.piconic.ai in .pedit/config.yaml
go run ./cmd/pedit notes.md
```

Deploying it is also a rehearsal of self-hosting pedit on another Cloudflare account.
