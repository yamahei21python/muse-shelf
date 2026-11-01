# muse-shelf

**muse-shelf** is a lightweight, zero-database Vercel serverless application that functions as a private "repository shelf". It distributes repository snapshots (`tar.gz`) to trusted AI agents and collects their work products into an inbox. Canonical repository history remains on GitHub; this shelf acts strictly as a distribution shelf and inbox buffer.

All persistent state is stored in a single private Vercel Blob store (`@vercel/blob` with `access: 'private'`).

---

## Deliverables & Architecture

- **`api/`**: Serverless route handlers deployable on Vercel with framework preset `null` (plain Node.js ESM).
- **`lib/`**: Shared core modules for authentication, storage adaptation, HTTP helpers, and input validation.
- **`package.json`**: Minimal footprint with `@vercel/blob` as the sole runtime dependency.
- **`test/`**: Full test suite running completely offline without network or Vercel dependencies, using `node --test` and an in-memory storage adapter.

---

## Environment Variables

| Variable | Scope | Description |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | Production | Vercel Blob read/write token (auto-populated by Vercel when connected to a Blob store). |
| `SHELF_ADMIN_TOKEN` | Production / Admin | Secret string compared in constant time against the `x-admin-token` request header. |
| `SHELF_SIGNING_SECRET` | Production / Admin / Agent | Secret key used to generate and verify HMAC-SHA256 signatures for short-lived tokens. |
| `SHELF_TOKENS_JSON` | Production / Agent | JSON object mapping recipient display names to token strings, e.g. `{"macmuse":"token_a","xmuse":"token_b"}`. |

*Note: Never place real secrets into version control or logging output.*

---

## Token Formats & Authentication

### 1. Long-Lived Recipient Tokens (Agent-facing)
- **Source**: Configured in `SHELF_TOKENS_JSON` as `{ "<name>": "<token>" }`.
- **Presentation**: In the URL path (`/api/s/<token>/...`), never in headers.
- **Permissions**: Full read access to repository snapshots and manifest; write access to the inbox.
- **Comparison**: Verified using `crypto.timingSafeEqual` in constant time.
- **Default identity**: The token's display name key in `SHELF_TOKENS_JSON` (e.g. `macmuse`).

### 2. Short-Lived Signed Tokens (Agent-facing)
- **Format**: `v1.<exp_unix>.<label_b64url>.<hmac_b64url>`
  - `v1`: Version identifier.
  - `<exp_unix>`: Expiration timestamp in seconds since Unix epoch.
  - `<label_b64url>`: Display label / agent identifier, base64url-encoded.
  - `<hmac_b64url>`: HMAC-SHA256 signature calculated over the literal string `v1.<exp_unix>.<label_b64url>` using secret `SHELF_SIGNING_SECRET`, base64url-encoded.
- **Presentation**: In the URL path (`/api/s/<token>/...`), never in headers.
- **Verification**: Signature is validated using `crypto.timingSafeEqual` prior to checking `exp_unix > now`.
- **Default identity**: The decoded `<label_b64url>`.

### 3. Admin Tokens (Admin-facing)
- **Presentation**: Header `x-admin-token`.
- **Verification**: Constant-time comparison against `process.env.SHELF_ADMIN_TOKEN`.

---

## Storage Layout (Blob Paths)

All state is stored within private Vercel Blob keys:

- `snapshots/<repo>.tar.gz` — The latest snapshot archive of a repository.
- `meta/<repo>.json` — Metadata object for the snapshot:
  ```json
  {
    "repo": "<repo>",
    "sha": "<sha>",
    "size_bytes": 1048576,
    "updated_at": "2026-11-01T08:00:00.000Z"
  }
  ```
- `inbox/index.json` — Inbox sequence index and entry history:
  ```json
  {
    "seq": 12,
    "entries": [
      {
        "seq": 1,
        "from": "macmuse",
        "repo": "cool-project",
        "base_sha": "abc1234",
        "size_bytes": 20480,
        "path": "inbox/macmuse/20261101-120000-cool-project.tar.gz",
        "received_at": "2026-11-01T12:00:00.000Z"
      }
    ]
  }
  ```
- `inbox/<from>/<yyyymmdd-hhmmss>-<repo>-<rand>.tar.gz` — Individual submitted work products (with a random 8-character hex suffix to ensure unique paths even for concurrent uploads within the same second).

### Identifiers & Limits
- `<repo>`: Must match `^[a-z0-9][a-z0-9._-]*$` (strictly lowercase). Non-matching identifiers are rejected with `400`.
- `<from>`: Sanitised by converting to lowercase, replacing characters outside `[a-z0-9._-]` with `-`, and trimming non-alphanumeric prefixes.
- **Payload size limit**: Upload bodies for snapshots and inbox items are capped at 4.5 MB (`4,718,592` bytes). Requests exceeding this limit receive HTTP `413 Payload Too Large`.
- **Errors**: Application errors are returned as JSON `{"error": "..."}` with appropriate HTTP status codes (400, 401, 404, 405, 413, 500). Rejections issued by the hosting platform itself (for example Vercel's own request-body limit) may not be JSON.

---

## API Routes

### Health
- `GET /api/health`
  - Unauthenticated.
  - Returns `200 {"ok":true}`.

### Agent Routes (`/api/s/<token>/...`)
- `GET /api/s/<token>/manifest`
  - Authenticated via URL path `<token>`.
  - Returns `200 {"repos": [ <meta objects sorted by repo> ]}` compiled from `meta/*.json`.
- `GET /api/s/<token>/dl/<repo>`
  - Authenticated via URL path `<token>`.
  - Returns `200` with raw snapshot bytes, `content-type: application/gzip`, and `content-disposition: attachment; filename="<repo>.tar.gz"`.
  - Returns `404` if `<repo>` snapshot does not exist.
- `POST /api/s/<token>/inbox/<repo>`
  - Authenticated via URL path `<token>`.
  - Headers:
    - `x-base-sha` (required): Commit SHA the agent's work is based upon.
    - `x-from` (optional): Self-declared sender name, recorded in the index entry as `from_claimed` for information only. The stored `from` and the blob path always use the authenticated token identity (recipient token name or signed token label), never this header.
  - Body: Raw `tar.gz` archive (max 4.5 MB).
  - Saves file to `inbox/<from>/<yyyymmdd-hhmmss>-<repo>-<rand>.tar.gz`, appends entry to `inbox/index.json`, increments `seq`.
  - Returns `201 {"ok":true,"seq":N}`.

### Admin Routes (`x-admin-token` header)
- `PUT /api/admin/snapshot/<repo>`
  - Headers: `x-admin-token` (required), `x-sha` (required).
  - Body: Raw `tar.gz` archive (max 4.5 MB).
  - Stores snapshot bytes at `snapshots/<repo>.tar.gz` and metadata at `meta/<repo>.json`.
  - Returns `200 {"ok":true,"repo":...,"sha":...,"size_bytes":N}`.
- `GET /api/admin/inbox?since=<seq>`
  - Headers: `x-admin-token` (required).
  - Query parameter `since` (optional integer): Returns only entries where `seq > since`.
  - Returns `200 {"seq": <current>, "entries": [ ... ]}`.
- `GET /api/admin/inbox-file?path=<blob path>`
  - Headers: `x-admin-token` (required).
  - Query parameter `path` (required, must start with `inbox/`).
  - Returns `200` with the raw file bytes.
- `POST /api/admin/mint`
  - Headers: `x-admin-token` (required).
  - Body: JSON `{"ttl_minutes": <int 1..1440>, "label": "<string>"}`.
  - Returns `200 {"token": "<signed token>", "expires_at": "<ISO>"}`.

---

## How the Inbox Avoids the Read-Modify-Write Race

A submission writes exactly two objects, both unique to itself:
1. The payload at `inbox/<from>/<yyyymmdd-hhmmss>-<repo>-<rand>.tar.gz` (random 8-hex suffix, so same-second submissions never collide).
2. A sidecar metadata file at the same path plus `.json`.

No shared mutable state is touched on write, so concurrent submissions cannot lose each other. The admin listing derives entries at read time: legacy entries recorded in the old shared `inbox/index.json` (kept read-only for compatibility) come first with their stored seq values, then sidecar entries ordered by `received_at` with seq continuing after them.

History: the inbox originally kept a single `inbox/index.json` updated by read-modify-write. A later round added ETag/`ifMatch` optimistic concurrency, which still lost entries against the real store — the ETag and the body come from separate reads of an eventually consistent store and can belong to different versions, and the download-path ETag does not satisfy put preconditions. The sidecar design removes the shared file instead of layering more retries on it. The storage adapter still exposes `getEntry`/`ifMatch` for any future use that can tolerate those semantics.

---

## Security Notes

- **Tokens live in URL paths by design** (capability URLs). They therefore appear in web-server and proxy access logs. Long-lived tokens are long random values; rotate them periodically and treat log access as token access.
- **Inbox tarballs are untrusted input.** A return's contents were produced by another agent and only format-checked (gzip magic bytes, declared SHA format) on upload. Whoever extracts a return must validate archive entry paths (no absolute paths, no `..` segments) before writing anything to disk, and must review the contents before use — the operator verifies every return before it is applied anywhere.

---

## Running the Tests

Tests use the native Node.js test runner (`node:test`) and run with zero external network dependencies:

```bash
npm test
```
