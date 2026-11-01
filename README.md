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
- `inbox/<from>/<yyyymmdd-hhmmss>-<repo>.tar.gz` — Individual submitted work products.

### Identifiers & Limits
- `<repo>`: Must match `^[a-z0-9][a-z0-9._-]*$` (strictly lowercase). Non-matching identifiers are rejected with `400`.
- `<from>`: Sanitised by converting to lowercase, replacing characters outside `[a-z0-9._-]` with `-`, and trimming non-alphanumeric prefixes.
- **Payload size limit**: Upload bodies for snapshots and inbox items are capped at 4.5 MB (`4,718,592` bytes). Requests exceeding this limit receive HTTP `413 Payload Too Large`.
- **Errors**: All errors are returned as JSON `{"error": "..."}` with appropriate HTTP status codes (400, 401, 404, 405, 413, 500).

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
    - `x-from` (optional): Display name override (defaults to recipient token name or signed token label).
  - Body: Raw `tar.gz` archive (max 4.5 MB).
  - Saves file to `inbox/<from>/<yyyymmdd-hhmmss>-<repo>.tar.gz`, appends entry to `inbox/index.json`, increments `seq`.
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

## The Read-Modify-Write Race on Inbox Index

### Explanation
When an agent submits work to `POST /api/s/<token>/inbox/<repo>`, the server:
1. Uploads the blob to `inbox/<from>/<yyyymmdd-hhmmss>-<repo>.tar.gz`.
2. Reads `inbox/index.json` from Vercel Blob store.
3. Increments `index.seq` and appends the new entry record to `index.entries`.
4. Overwrites `inbox/index.json` with the updated JSON.

Vercel Blob is an object storage system, not a relational database. It lacks built-in transactional primitives, distributed mutex locks, or conditional updates in this access pattern. If two agents simultaneously submit work:
- Both requests may read the same initial state of `inbox/index.json` (e.g. `seq = 5`).
- Both calculate `seq = 6`.
- Both write back their respective `inbox/index.json`.
- The last write wins, silently overwriting the other's entry in the index list and duplicating sequence numbers.

### Operational Scope & Mitigations
In `muse-shelf`, this design tradeoff is intentional:
- Distribution is meant for a small set of trusted, asynchronous AI agents submitting infrequent completed tasks, where submission collision probability is near zero.
- The underlying blob files (`inbox/<from>/<yyyymmdd-hhmmss>-<repo>.tar.gz`) are always preserved and never overwritten because their paths contain timestamp and agent name.
- If high-concurrency atomic inbox indexing is required in the future, the index state can be backed by a transactional store (such as Vercel Postgres or Redis) or optimistic concurrency control via blob ETags (`if-match` conditional PUT).

---

## Running the Tests

Tests use the native Node.js test runner (`node:test`) and run with zero external network dependencies:

```bash
npm test
```
