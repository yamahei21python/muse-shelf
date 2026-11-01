# FIX_NOTES — review-fix round 1

Fixes driven by two independent reviews of the initial release
(74736ccc), specified in FIX_SPEC.md (items 1–10). Production code
changes were drafted by a delegated opencode run; fixture updates,
the regression tests in test/fixes.test.js, the README corrections
and this file were completed by Muse during acceptance, after the
delegated runs stalled / exited early twice. Final state verified by
Muse: full suite 35/35 pass (28 pre-existing + 7 new), including the
updated behaviour contracts below.

## Per item

1. **Same-second inbox overwrite (HIGH)** — `inboxBlobPath()` in
   lib/validation.js appends `-<rand8>` (crypto.randomBytes(4) hex) to
   every inbox blob path. Two uploads in the same second now get
   distinct paths and both payloads survive; covered by assertions in
   the updated inbox happy-path test.
2. **Index race** — storage adapters gained `getEntry()` (buffer +
   etag) and `putBuffer(..., { ifMatch })` throwing
   `PreconditionFailed` (memory) / `BlobPreconditionFailedError`
   (Vercel). The inbox handler retries the read-append-write cycle up
   to 3 times, then returns 500. Adapter-level test in
   test/fixes.test.js.
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

## Deviations / notes

- Item 2's handler-level concurrency is covered by an adapter-level
  test plus the sequential two-post happy path; a true concurrent
  two-request race is not simulated (the in-memory adapter resolves
  synchronously per request, so interleaving cannot be forced
  deterministically). The retry loop is code-reviewed.
- `npm test` counts test/helpers.js as one "test" file entry under
  node --test; the 35 total includes it (the pre-existing 28 did too,
  so the net new real tests are 7).
