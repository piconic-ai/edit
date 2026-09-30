# piconic edit

Co-edit a local text file with others, right now.

```sh
pedit notes.md
```

`pedit` prints a link (and copies it to your clipboard). Paste it into Slack or wherever; whoever opens it edits the file with you in their browser. No install or account for them. Edits land in your local file about a second later. Press Ctrl+C to finish: the final state is written and the room closes.

No file in mind yet? Run `pedit` on its own: it creates an empty `pedit-<time>.md` (for example `pedit-2026-09-26-143012.md`) in the current directory and shares that. It never overwrites a file, and when you finish it tells you the name so you can resume later with `pedit pedit-2026-09-26-143012.md`. `pedit <file>` itself only shares files that already exist.

Any UTF-8 text file works, not only Markdown: `pedit main.go`, `pedit data.csv` or `pedit board.canvas`. The editor picks syntax highlighting from the file extension and falls back to Markdown when there is none or it is unknown; `.txt`, `.csv` and `.tsv` stay plain text.

Markdown files open with a rendered preview next to the editor (preview only on phones); switch between Edit, Split and Preview in the header. The preview shows images and videos from absolute URLs already in the document, and plays bare YouTube and Vimeo links.

Paste or drop an image (PNG, JPEG, GIF or WebP) into a Markdown file, and pedit saves it next to the file as `assets/<hash>.png` and links it where you put it. Location and other metadata are removed first, and images over 10 MB are scaled down. The preview shows these images to everyone in the session; other images at relative paths show their alt text, since they live on your disk.

**Why "piconic edit"?** It is the piconic service for inviting people into a local document and editing it together, right now.

## How it works

```
your machine                     Cloudflare (edit.piconic.ai)           collaborators
notes.md  <->  pedit CLI  <--wss-->  Worker -> Room (Durable Object)  <--wss-->  browser editor
```

- Your local file is the source of truth, and pasted images are saved beside it. The server keeps nothing but those images, encrypted, while you are connected, and deletes them when the session ends.
- Every update is encrypted end to end (AES-GCM) with a key that lives only in the link's `#fragment`. Browsers never send the fragment to the server, so the server only relays ciphertext it cannot read.
- Documents are synced with [Yjs](https://yjs.dev). Edits you make to the file in your own editor while sharing are streamed to the room too.
- Anyone with the link can edit. Share it like you would share a Google Docs link.
- A room lives only while you are connected. When you press Ctrl+C (or lose your connection), everyone is disconnected and nothing is left on the server.

## Install

`pedit` is a single binary with no runtime dependencies. With Go 1.25 or later:

```sh
go install github.com/piconic-ai/edit/cmd/pedit@latest
```

Set `PEDIT_SERVER` to use a server other than `https://edit.piconic.ai`.

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
pnpm --filter @pedit/worker dev                  # builds the web editor, serves on http://localhost:8787
PEDIT_SERVER=http://localhost:8787 go run ./cmd/pedit notes.md
```

| Path | What it is |
| --- | --- |
| `cmd/pedit`, `internal/` | The `pedit` command (Go). `internal/protocol` mirrors `packages/protocol` on top of [ygo](https://github.com/reearth/ygo) |
| `packages/protocol` | Encryption, message framing and the Yjs room client used by the web editor |
| `packages/worker` | Hono Worker + `Room` Durable Object (WebSocket Hibernation API); also serves the web editor |
| `packages/web` | CodeMirror 6 editor for collaborators; UI components in BarefootJS |

The wire format (AES-GCM frames, message types, y-protocols sync and awareness)
is shared by both implementations: change them together.

- A frame is `iv || AES-GCM(room key, type || payload)`. Types: `0` sync, `1`
  awareness, `2` attachment. Clients skip types they do not know, so newer
  peers can add more.
- Attachments (images) are named by content: `hash` is the first 128 bits of
  SHA-256 of the bytes, in hex. Their bytes are encrypted with a key derived
  from the room key (HKDF-SHA256, info `pedit blob enc v1`) and stored under
  `blobId`, the first 128 bits of HMAC-SHA256 over `hash` with another derived
  key (info `pedit blob id v1`), in base64url. The server sees neither the
  content nor its hash.
- Attachment messages carry a lib0 varint kind and fields: `0` announce
  (hash, mime), `1` want (hashes), `2` stored (hash, path), `3` rejected
  (hash, reason). `internal/protocol/testdata/blob-vectors.json` pins the
  derivations for both implementations.

## Releases and deploys

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
| Deploy command | `pnpm run deploy` |
| Non-production branch builds | enabled |
| Preview command | `pnpm run preview` |

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

### Behind Cloudflare Access

pedit works on a host protected by a Cloudflare Access self-hosted application.

- Collaborators sign in with Access and join without typing a name. The editor
  reads their name from `/cdn-cgi/access/get-identity`, which Access answers
  itself, and their avatar from the IdP's `picture` claim or Gravatar.
- The host just runs `pedit notes.md`. When the server is behind Access, pedit
  signs in with [cloudflared](https://github.com/cloudflare/cloudflared): the
  browser opens once per Access session, and the host joins as themselves,
  with a Gravatar avatar from their email. Install cloudflared first, for
  example with `brew install cloudflared`.

The token is read once when pedit starts. If the Access session expires while
sharing (24 hours by default), pedit cannot reconnect until it is restarted.

The Worker runs on the Workers Free plan (100,000 requests a day). It uses a
SQLite-backed Durable Object and no D1 or KV. `piconic.ai` must be on the same
Cloudflare account for the custom domain.
