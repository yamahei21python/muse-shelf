# BUILD_NOTES.md — muse-shelf Implementation Notes

## Summary of What Was Built

Implemented **muse-shelf**, a private repository snapshot distribution and agent inbox application on Vercel Serverless Functions with Vercel Blob private storage:

1. **API Endpoints (`api/`)**:
   - `GET /api/health` — Unauthenticated health check returning `{"ok":true}`.
   - `GET /api/s/<token>/manifest` — Returns JSON list of all repository snapshot meta objects sorted by repo name.
   - `GET /api/s/<token>/dl/<repo>` — Streams repository snapshot archive with gzip headers (`Content-Disposition: attachment; filename="<repo>.tar.gz"`).
   - `POST /api/s/<token>/inbox/<repo>` — Ingests agent work products (up to 4.5 MB), stores at `inbox/<from>/<yyyymmdd-hhmmss>-<repo>.tar.gz`, appends entry to `inbox/index.json`, increments sequence, and returns 201 `{"ok":true,"seq":N}`.
   - `PUT /api/admin/snapshot/<repo>` — Uploads snapshot archive and writes `meta/<repo>.json` with commit SHA, size, and timestamp.
   - `GET /api/admin/inbox?since=<seq>` — Lists inbox entries optionally filtered by sequence threshold.
   - `GET /api/admin/inbox-file?path=<blob path>` — Downloads inbox work product files.
   - `POST /api/admin/mint` — Generates short-lived signed tokens (`v1.<exp>.<label>.<hmac>`).

2. **Core Libraries (`lib/`)**:
   - `lib/store.js` — Pluggable storage adapter supporting `@vercel/blob` (private access mode) and in-memory Map implementation for offline test isolation.
   - `lib/auth.js` — Timing-safe validation for long-lived recipient tokens (`SHELF_TOKENS_JSON`), HMAC-SHA256 short-lived signed tokens, and admin token (`SHELF_ADMIN_TOKEN`).
   - `lib/validation.js` — Repo name validation (`^[a-z0-9][a-z0-9._-]*$`), `<from>` sanitization, UTC timestamp formatting (`YYYYMMDD-HHMMSS`), and body size limits.
   - `lib/http.js` — Streaming body reader with 4.5 MB hard cap enforcement, JSON parsing, and uniform response helpers.
   - `lib/router.js` — Route dispatcher for offline test server and standalone invocation.

3. **Runtime & Configuration**:
   - `package.json` — Configured with ESM (`"type": "module"`) and `@vercel/blob` as the sole runtime dependency.
   - `vercel.json` — Omitted per spec instruction ("if (and only if) the routing needs it") because Vercel native file-system routing in `api/` directly maps all routes, including dynamic bracket paths (`[token]` and `[repo]`).

---

## Simplest Options & Design Decisions Picked

1. **ESM vs CJS**: Picked Node.js ECMAScript Modules (ESM) with `"type": "module"` in `package.json` for modern, idiomatic Node 22 compatibility.
2. **Dynamic Route Mapping**: File structure uses standard Vercel bracket notation:
   - `api/s/[token]/manifest.js`
   - `api/s/[token]/dl/[repo].js`
   - `api/s/[token]/inbox/[repo].js`
   - `api/admin/snapshot/[repo].js`
   Handlers check `req.query` first and fall back to regex parsing of `req.url` if invoked outside Vercel.
3. **Storage Adapter Injection**: `lib/store.js` dynamically imports `@vercel/blob` only when the production adapter is active. The test suite injects `createMemoryAdapter()` via `setStorageAdapter()`, completely avoiding loading `@vercel/blob` or requiring network access during test runs.
4. **Sanitization of `<from>`**: Lowercases the raw string, replaces all characters outside `[a-z0-9._-]` with hyphens (`-`), and trims any leading non-alphanumeric characters. If the resulting string is empty or fails the regex, HTTP 400 is returned.
5. **Payload Size Enforcement**: Enforced at 4.5 MB (`4,718,592` bytes) in `lib/http.js` during chunk streaming to reject oversized uploads with HTTP 413 without buffering excessive data in memory.
6. **Spec Deviations**: None. All routes, headers, token verification rules, error structures, and storage keys match the specification exactly.

---

## Exact Test Results

Test suite was executed via `npm test` (`node --test`). All 28 tests passed with 0 failures, 0 cancellations, and 0 skipped tests:

```
> muse-shelf@1.0.0 test
> node --test

TAP version 13
# Subtest: Admin Inbox list: filters by since parameter
ok 1 - Admin Inbox list: filters by since parameter
  ---
  duration_ms: 179.21403
  type: 'test'
  ...
# Subtest: Admin Inbox file: downloads stored inbox blob
ok 2 - Admin Inbox file: downloads stored inbox blob
  ---
  duration_ms: 87.094323
  type: 'test'
  ...
# Subtest: Auth: long-lived recipient token accept and reject
ok 3 - Auth: long-lived recipient token accept and reject
  ---
  duration_ms: 116.238198
  type: 'test'
  ...
# Subtest: Auth: signed token accept, expired reject, and tampered signature reject
ok 4 - Auth: signed token accept, expired reject, and tampered signature reject
  ---
  duration_ms: 86.765443
  type: 'test'
  ...
# Subtest: Auth: admin auth accept and reject
ok 5 - Auth: admin auth accept and reject
  ---
  duration_ms: 19.113896
  type: 'test'
  ...
# Subtest: Download: hit returns 200 with snapshot bytes and correct headers
ok 6 - Download: hit returns 200 with snapshot bytes and correct headers
  ---
  duration_ms: 106.366259
  type: 'test'
  ...
# Subtest: Download: returns 404 when repo snapshot is unknown
ok 7 - Download: returns 404 when repo snapshot is unknown
  ---
  duration_ms: 72.19729
  type: 'test'
  ...
# Subtest: Download: rejects invalid repo name with 400
ok 8 - Download: rejects invalid repo name with 400
  ---
  duration_ms: 24.639261
  type: 'test'
  ...
# Subtest: Download: rejects invalid agent token with 401
ok 9 - Download: rejects invalid agent token with 401
  ---
  duration_ms: 10.516479
  type: 'test'
  ...
# Subtest: Health endpoint GET /api/health returns 200 { ok: true }
ok 10 - Health endpoint GET /api/health returns 200 { ok: true }
  ---
  duration_ms: 162.320246
  type: 'test'
  ...
# Subtest: Health endpoint rejects non-GET/HEAD methods with 405
ok 11 - Health endpoint rejects non-GET/HEAD methods with 405
  ---
  duration_ms: 19.519127
  type: 'test'
  ...
# Subtest: test/helpers.js
ok 5 - test/helpers.js
  ---
  duration_ms: 1020.998036
  type: 'test'
  ...
# Subtest: Inbox POST: appends entry, increments seq, and stores blob
ok 13 - Inbox POST: appends entry, increments seq, and stores blob
  ---
  duration_ms: 183.453013
  type: 'test'
  ...
# Subtest: Inbox POST: rejects missing x-base-sha header with 400
ok 14 - Inbox POST: rejects missing x-base-sha header with 400
  ---
  duration_ms: 17.630564
  type: 'test'
  ...
# Subtest: Inbox POST: rejects bad repo name with 400
ok 15 - Inbox POST: rejects bad repo name with 400
  ---
  duration_ms: 9.088367
  type: 'test'
  ...
# Subtest: Inbox POST: rejects oversize body (> 4.5 MB) with 413
ok 16 - Inbox POST: rejects oversize body (> 4.5 MB) with 413
  ---
  duration_ms: 100.313564
  type: 'test'
  ...
# Subtest: Manifest: returns empty list when no snapshots seeded
ok 17 - Manifest: returns empty list when no snapshots seeded
  ---
  duration_ms: 110.124943
  type: 'test'
  ...
# Subtest: Manifest: returns meta objects sorted by repo name
ok 18 - Manifest: returns meta objects sorted by repo name
  ---
  duration_ms: 23.20463
  type: 'test'
  ...
# Subtest: Mint: produces a signed token that verifies and accesses agent routes
ok 19 - Mint: produces a signed token that verifies and accesses agent routes
  ---
  duration_ms: 198.695786
  type: 'test'
  ...
# Subtest: Mint: input validation for ttl_minutes and label
ok 20 - Mint: input validation for ttl_minutes and label
  ---
  duration_ms: 83.96081
  type: 'test'
  ...
# Subtest: Snapshot PUT: stores snapshot bytes and writes meta JSON
ok 21 - Snapshot PUT: stores snapshot bytes and writes meta JSON
  ---
  duration_ms: 169.105242
  type: 'test'
  ...
# Subtest: Snapshot PUT: rejects missing x-sha with 400
ok 22 - Snapshot PUT: rejects missing x-sha with 400
  ---
  duration_ms: 18.317126
  type: 'test'
  ...
# Subtest: Snapshot PUT: rejects invalid repo name with 400
ok 23 - Snapshot PUT: rejects invalid repo name with 400
  ---
  duration_ms: 69.048908
  type: 'test'
  ...
# Subtest: Snapshot PUT: rejects oversize body with 413
ok 24 - Snapshot PUT: rejects oversize body with 413
  ---
  duration_ms: 104.639598
  type: 'test'
  ...
# Subtest: Snapshot PUT: rejects unauthenticated call with 401
ok 25 - Snapshot PUT: rejects unauthenticated call with 401
  ---
  duration_ms: 10.135819
  type: 'test'
  ...
# Subtest: Unit: validation and sanitization
ok 26 - Unit: validation and sanitization
  ---
  duration_ms: 1.218181
  type: 'test'
  ...
# Subtest: Unit: in-memory store adapter
ok 27 - Unit: in-memory store adapter
  ---
  duration_ms: 2.439692
  type: 'test'
  ...
# Subtest: Unit: auth token minting and timing safe equality
ok 28 - Unit: auth token minting and timing safe equality
  ---
  duration_ms: 1.495141
  type: 'test'
  ...
1..28
# tests 28
# suites 0
# pass 28
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1838.13119
```
