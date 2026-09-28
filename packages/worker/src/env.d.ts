// Optional overrides of a room's attachment quota (see room.ts for the
// defaults). Not set in wrangler.jsonc; the tests set them.
interface Env {
  BLOB_QUOTA_BYTES?: string
  BLOB_QUOTA_COUNT?: string
}
