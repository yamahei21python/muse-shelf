# FIX_NOTES — review-fix round 1

Fixes driven by two independent reviews of the initial release
(74736ccc), specified in FIX_SPEC.md (items 1–10). Production code
changes were drafted by a delegated opencode run; fixture updates,
the regression tests in test/fixes.test.js, the README corrections
and this file were completed by Muse during acceptance, after the
delegated runs stalled / exited early twice. Suite size grew across
rounds: 35 after round 1 (28 pre-existing + 7 new), 37 after the
round-2 fixes, 39 after the sidecar redesign (parallel-posts and
legacy-merge tests), 44 after round 3. All counts include test/helpers.js, which
node --test tallies as one entry.

## Per item

1. **Same-second inbox overwrite (HIGH)** — `inboxBlobPath()` in
   lib/validation.js appends `-<rand8>` (crypto.randomBytes(4) hex) to
   every inbox blob path. Two uploads in the same second now get
   distinct paths and both payloads survive; covered by assertions in
   the updated inbox happy-path test.
2. **Index race** — storage adapters gained `getEntry()` (buffer +
   etag) and `putBuffer(..., { ifMatch })` throwing
   `PreconditionFailed`. The handler initially used them to retry the
   read-append-write cycle; round 2 (below) showed that approach
   still loses entries against the real store and replaced the
   shared index with per-return sidecar files. The adapter capability
   remains and is unit-tested; the handler no longer depends on it.
3. **inbox-file ".." over-block** — the guard now requires the strict
   shape `inbox/<seg>/<file>.tar.gz` (exactly 3 segments), rejects
   segments equal to `.`/`..`, backslashes and NUL, and no longer
   rejects `..` inside a longer segment, so repos like `a..b` are
   retrievable. Tests in test/fixes.test.js.
4. **x-from spoofing** — `from` is pinned to the authenticated
   identity (token name / signed label); a differing `x-from` header
   is recorded as `from_claimed` only. The pre-existing happy-path
   test was updated to the new contract (it previously asserted the
   spoofable behaviour).
5. **Chunked oversize 413** — lib/http.js parseBody no longer calls
   req.destroy() on limit breach. The first delegated draft paused,
   drained in the background and rejected immediately; CI on Node 22
   showed that still loses the response (answering mid-upload makes
   Node destroy the socket; the client sees a reset and zero bytes —
   reproduced with a raw TCP socket). Final behaviour: on breach the
   reader keeps draining and discarding until the client finishes,
   then rejects with HttpError(413), so the JSON error is delivered
   on an intact socket. Regression test uses a raw TCP socket with a
   hand-written chunked request (the node:http client masks this
   server behaviour behind its own state machine, differently across
   Node versions).
6. **Malformed percent-encoding** — router decodes via a safeDecode
   wrapper; URIError becomes HttpError(400). Test included.
7. **Router HttpError swallowing** — the router catch now preserves
   HttpError status/message. Exercised by the item 6 test, which
   passes through that catch.
8. **Mint label validation** — mint rejects labels for which
   sanitizeFrom(label) is null (e.g. Japanese-only). Test included.
9. **SHA / gzip validation** — `isValidSha()` (hex, 7–64) enforced on
   x-base-sha / x-sha; inbox and snapshot bodies must start with the
   gzip magic bytes 0x1f 0x8b. Existing test fixtures were updated to
   valid-format SHAs (their payloads already used real gzip). Tests
   for both rejections on both endpoints included.
10. **Cache-Control** — sendJson/sendBuffer add
    `Cache-Control: private, no-store` by default (an explicit caller
    header wins). Header asserted on manifest, download and admin
    responses in test/fixes.test.js.

## README corrections

The race section previously claimed inbox blobs "are never
overwritten because their paths contain timestamp and agent name" —
false at second resolution, and the actual data-loss bug of item 1.
The section now describes the random-suffix paths and the etag
protocol; the `x-from` description, the "all errors are JSON"
qualification, a token-in-URL logging note and an untrusted-inbox
warning were also added per FIX_SPEC.

## Round 2 (post-release re-review)

Two further defects were found by an external re-review of e7fd6835;
both are fixed in this round, with regression tests.

- **Item 2 was inert in production.** The Vercel adapter's getEntry
  read `result.etag`, but @vercel/blob 2.8.2's `get()` returns
  `{ statusCode, stream, headers, blob: { ..., etag } }` — the etag
  lives on `blob` (verified against the installed SDK's type
  definitions). Production therefore always saw etag undefined,
  never sent ifMatch, and kept the original race. The memory adapter
  returned the etag at the top level of its own result, mirroring
  the misreading, so the suite could not catch it; the sequential
  production smoke could not either. Fix: a pure helper
  `etagFromGetResult()` (blob.etag, ETag-header fallback), unit
  tested against the SDK's documented shape. Two deeper production
  findings followed on the first live attempt: (1) the download-path
  etag still never satisfies put's precondition (a quiescent
  sequential write failed with "ETag mismatch"), so getEntry now
  takes the etag from `head()` (metadata API) and only falls back to
  the get() value; (2) the SDK's precondition error surfaces at
  runtime with name 'Error', not 'BlobPreconditionFailedError', so
  the Vercel adapter normalises it to the adapter contract
  (name 'PreconditionFailed', matched on the message) and the
  handler accepts that name. Even then, parallel live posts still
  lost entries: with head() providing the etag and get() the body,
  the two reads can return different versions of the index
  (propagation skew), so a conditional write can succeed while
  carrying a stale body. Final design: the shared index is gone
  from the write path. Each return writes its payload plus a
  sidecar `<path>.json`; the admin listing merges legacy
  `inbox/index.json` entries (read-only) with sidecars at read time
  (lib/inbox.js). Verified live with four parallel posts — all four
  entries listed, where the previous designs lost entries even at
  two.
  Residual (superseded by the final design above): with the shared
  index gone from the write path there is nothing left to race;
  the first-posts concern belonged to the etag design.
- **Item 4 regression: unsanitised identity stored.** The handler
  validated `sanitizeFrom(from)` but stored and pathed the RAW
  `auth.name || auth.label`. A label such as `Worker One/x` produced
  `inbox/Worker One/x/...` — a 4-segment path the strict item-3
  guard then refuses to return, and long-token names with spaces or
  capitals were affected the same way. Fix: `from` is the sanitised
  value (`sanitizeFrom(...)` or 400). Regression test mints a token
  with the label `Worker One/x`, posts, and downloads the return
  through inbox-file.

## Round 3 (fresh external review of 35c63109)

A from-scratch review of the public repo (its own run: 39/39) found
one structural flaw in the sidecar design plus smaller items; each
was verified locally before fixing:

- Entry identity: seq is derived at read time, so a late-visible
  sidecar can sort into an already-polled range and be missed by
  `?since=` consumers while an older entry repeats. No scalar
  cursor is safe over an eventually consistent set, so entries now
  carry a stable `id` (the payload path), the POST response returns
  it as the durable receipt, and seq is documented as a
  response-local ordinal. The operator's notification hook was
  migrated to seen-id diffing.
- Posting cost: the POST handler called the full listing (fetching
  every sidecar body, sequentially) just to count entries. It now
  uses countInboxEntries() (one list call + the legacy index read).
  Regression test asserts zero sidecar body reads during a POST.
- Snapshot consistency: snapshot bytes are versioned
  (`snapshots/<repo>@<sha>.tar.gz`) and the meta — which now records
  `path` — is the commit point. A failed meta write leaves the
  previous version fully intact (the new bytes are an unreferenced
  orphan). Downloads follow meta.path with a fallback to the legacy
  canonical path for pre-versioning snapshots. Regression test
  injects a meta write failure and checks manifest + download still
  serve the previous version.
- Router: query values from URLSearchParams were decoded a second
  time, corrupting or rejecting legitimate values (`%25nothex`
  became a false 400). They are now used as decoded once by the URL
  parser; path segments are still decoded exactly once.
- Token identity config: a long-lived token whose configured name
  cannot sanitise to a shelf identity now fails fast (500, server
  configuration) on every route instead of authenticating for reads
  but failing only at inbox POST time.
- safeEqual compares SHA-256 digests, so comparison time no longer
  depends on the secret's length.
- README: storage layout, POST and admin-inbox contracts, and the
  inbox-file restriction now match the implementation (the front
  half still described the retired index design).

Suite after round 3: 44 tests (39 + 5 new), passing on Node 22/24.

## Deviations / notes

- (Historical, rounds 1–2) Handler-level concurrency was initially
  covered only by adapter-level tests; the sidecar redesign made
  the write path contention-free by construction, and a handler
  level parallel-posts test (4 concurrent submissions, all listed)
  was added with it in round 2.
- `npm test` counts test/helpers.js as one "test" file entry under
  node --test; every total quoted in this file includes it.
