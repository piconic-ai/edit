# Privacy and security

## What is encrypted

pedit encrypts document updates and presence messages on the CLI and in the
browser with AES-256-GCM before sending them over HTTPS/WebSockets. A random
room key is shared in the URL's `#fragment`. Browsers do not send URL fragments
in HTTP requests; the relay does not receive the key and cannot decrypt these messages.

Pasted images are encrypted with a key derived from the room key. The relay
stores encrypted bytes under opaque identifiers, rather than the original
image content or its content hash. Images are saved locally under `assets/`.

## What the relay retains

The relay forwards document messages without storing document text or an
encrypted document history. The host's local file holds the saved result.
When the relay detects that the host has disconnected, it closes the room and
disconnects collaborators.

Encrypted images are kept in R2 while the session is active. The room attempts
to delete them when the host leaves. A configured R2 lifecycle rule expires
objects under `rooms/` after one day if deletion fails; expiry is a cleanup
backstop, not a promise of immediate deletion. Set up this rule when
[self-hosting](self-hosting.md).

The relay and its infrastructure can see connection metadata such as IP
addresses, room identifiers, request timing and ciphertext sizes. Workers
observability is enabled in the supplied configuration. Infrastructure logs
and Access authentication logs have their own retention settings; closing a
room does not erase them.

## Who can read and edit

The full session link contains the decryption key. On the public relay,
anyone with that link can read and edit while the host is connected. Recipients
can copy the document or forward the link. Ending a session does not erase
copies already made by participants or remove the local file and images.

Treat session links as secrets, including in chat history, screenshots and
bug reports. Cloudflare Access can additionally require an allowed identity
before joining your self-hosted relay. It does not replace end-to-end encryption.

## Trust boundaries

The relay also serves the browser editor. You must trust the operator to serve
the intended client code: a modified editor could read the key and plaintext
in the browser. Encryption also assumes trusted participant devices and browsers.

Markdown previews may request external images, videos and YouTube/Vimeo embeds.
Those providers can see the requests. With Access, participant identity is
used for display names and avatars; avatars may be loaded from an identity
provider or Gravatar using a hash of the email address.

For control over the served client, infrastructure and sign-in policy, follow
[self-hosting with Cloudflare Access](self-hosting.md).
