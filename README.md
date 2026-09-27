# ima

Co-edit a local text file with others, right now.

```sh
ima notes.md
```

`ima` prints a link (and copies it to your clipboard). Paste it into Slack or wherever; whoever opens it edits the file with you in their browser. No install or account for them. Edits land in your local file about a second later. Press Ctrl+C to finish: the final state is written and the room closes.

Any UTF-8 text file works, not only Markdown: `ima main.go`, `ima data.csv` or `ima board.canvas`. The editor picks syntax highlighting from the file extension and falls back to Markdown when there is none or it is unknown; `.txt`, `.csv` and `.tsv` stay plain text.

Markdown files open with a rendered preview next to the editor (preview only on phones); switch between Edit, Split and Preview in the header. The preview shows images and videos from absolute URLs already in the document, and plays bare YouTube and Vimeo links. Images at relative paths show their alt text, since they live on your disk.

**Why "ima"?** It comes from two Japanese words read *ima*: 居間 (the living room, where you casually invite people in) and 今 (now). You invite people into your place to write together, right now, and the document never leaves your home.

## How it works

```
your machine                     Cloudflare (ima.piconic.ai)           collaborators
notes.md  <->  ima CLI  <--wss-->  Worker -> Room (Durable Object)  <--wss-->  browser editor
```

- Your local file is the source of truth. The server stores nothing.
- Every update is encrypted end to end (AES-GCM) with a key that lives only in the link's `#fragment`. Browsers never send the fragment to the server, so the server only relays ciphertext it cannot read.
- Documents are synced with [Yjs](https://yjs.dev). Edits you make to the file in your own editor while sharing are streamed to the room too.
- Anyone with the link can edit. Share it like you would share a Google Docs link.
- A room lives only while you are connected. When you press Ctrl+C (or lose your connection), everyone is disconnected and nothing is left on the server.

## Install

`ima` is a single binary with no runtime dependencies. With Go 1.25 or later:

```sh
go install github.com/piconic-ai/ima/cmd/ima@latest
```

Set `IMA_SERVER` to use a server other than `https://ima.piconic.ai`.

## Development

The CLI is written in Go; the server and the browser editor in TypeScript.

```sh
pnpm install
pnpm test        # TypeScript packages
pnpm typecheck
pnpm lint
go test ./...    # the CLI; its interop test drives the web client's RoomClient with Node.js
go vet ./...
```

Run everything locally:

```sh
pnpm --filter @ima/worker dev                  # builds the web editor, serves on http://localhost:8787
IMA_SERVER=http://localhost:8787 go run ./cmd/ima notes.md
```

| Path | What it is |
| --- | --- |
| `cmd/ima`, `internal/` | The `ima` command (Go). `internal/protocol` mirrors `packages/protocol` on top of [ygo](https://github.com/reearth/ygo) |
| `packages/protocol` | Encryption, message framing and the Yjs room client used by the web editor |
| `packages/worker` | Hono Worker + `Room` Durable Object (WebSocket Hibernation API); also serves the web editor |
| `packages/web` | CodeMirror 6 editor for collaborators |

The wire format (AES-GCM frames, message types, y-protocols sync and awareness)
is shared by both implementations: change them together.

## Releases and deploys

Production (`ima.piconic.ai`) deploys when a tagpr release PR is merged
(see `.github/workflows/tagpr.yml`): the merge tags the release, the workflow
fast-forwards the `release` branch to the tag, and Cloudflare Workers Builds
deploys `release`. Every other branch gets its own
[Worker Preview](https://developers.cloudflare.com/workers/previews/) on push, at
`https://<branch-name>-ima.<subdomain>.workers.dev`, with its own Durable Object
namespace and its own logs under the Preview's Observability tab (Cloudflare
dashboard → ima Worker → Previews). Previews are configured by the `previews`
block in `packages/worker/wrangler.jsonc`.

To try a Preview with the CLI:

```sh
IMA_SERVER=https://<branch-name>-ima.<subdomain>.workers.dev go run ./cmd/ima notes.md
```

Workers Builds settings (Cloudflare dashboard → ima Worker → Settings → Build):

| Setting | Value |
| --- | --- |
| Git repository | `piconic-ai/ima` |
| Root directory | `/` |
| Production branch | `release` |
| Build command | *(empty)* |
| Deploy command | `pnpm run deploy` |
| Non-production branch builds | enabled |
| Preview command | `pnpm run preview` |

### Lab

`ima-lab.piconic.ai` is a second Worker (`ima-lab`) for experiments that should
not touch production, such as putting the whole host behind Cloudflare Access.
It is defined as the `lab` environment in `packages/worker/wrangler.jsonc`, has
its own Durable Object namespace, and is deployed by hand:

```sh
pnpm run deploy:lab
IMA_SERVER=https://ima-lab.piconic.ai go run ./cmd/ima notes.md
```

Deploying it is also a rehearsal of self-hosting ima on another Cloudflare account.

### Behind Cloudflare Access

ima works on a host protected by a Cloudflare Access self-hosted application.

- Collaborators sign in with Access and join without typing a name. The editor
  reads their name from `/cdn-cgi/access/get-identity`, which Access answers
  itself, and their avatar from the IdP's `picture` claim or Gravatar.
- The host just runs `ima notes.md`. When the server is behind Access, ima
  signs in with [cloudflared](https://github.com/cloudflare/cloudflared): the
  browser opens once per Access session, and the host joins as themselves,
  with a Gravatar avatar from their email. Install cloudflared first, for
  example with `brew install cloudflared`.

The token is read once when ima starts. If the Access session expires while
sharing (24 hours by default), ima cannot reconnect until it is restarted.

The Worker runs on the Workers Free plan (100,000 requests a day). It uses a
SQLite-backed Durable Object and no D1 or KV. `piconic.ai` must be on the same
Cloudflare account for the custom domain.
