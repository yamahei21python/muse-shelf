/**
 * Regression tests for the review-fix round (FIX_SPEC items 1-10).
 * Items 1 and 4 are covered by the updated happy-path test in
 * inbox.test.js; this file covers items 2, 3, 5, 6, 8, 9, 10.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  setupTestServer,
  TEST_ADMIN_TOKEN,
  TEST_RECIPIENT_TOKENS,
  createGzipBuffer,
} from './helpers.js';
import { createMemoryAdapter, etagFromGetResult } from '../lib/store.js';
import { MAX_BODY_SIZE } from '../lib/validation.js';

const HEX_SHA = '0123456789abcdef0123456789abcdef01234567';
const MAC = TEST_RECIPIENT_TOKENS.macmuse;

// Item 2: optimistic concurrency in the memory adapter
test('Fix item 2: adapter getEntry/ifMatch precondition', async () => {
  const adapter = createMemoryAdapter();
  await adapter.putBuffer('inbox/index.json', Buffer.from('{"seq":0}'), 'application/json');
  const entry = await adapter.getEntry('inbox/index.json');
  assert.ok(entry);
  assert.strictEqual(entry.buffer.toString('utf8'), '{"seq":0}');

  // Stale etag -> PreconditionFailed
  await assert.rejects(
    adapter.putBuffer('inbox/index.json', Buffer.from('{"seq":1}'), 'application/json', { ifMatch: 'stale-etag' }),
    (err) => err.name.includes('PreconditionFailed')
  );

  // Fresh etag -> succeeds and rotates the etag
  const res = await adapter.putBuffer('inbox/index.json', Buffer.from('{"seq":1}'), 'application/json', { ifMatch: entry.etag });
  assert.ok(res.etag);
  assert.notStrictEqual(res.etag, entry.etag);
  const after = await adapter.getEntry('inbox/index.json');
  assert.strictEqual(after.buffer.toString('utf8'), '{"seq":1}');
});

// Item 2 (final design): entries are per-return sidecar files, so
// concurrent submissions cannot lose each other. (The shared
// index.json read-modify-write, even with etag/ifMatch, lost entries
// in production through etag/body version skew.)
test('Fix item 2: parallel inbox POSTs all survive', async () => {
  const env = await setupTestServer();
  try {
    const posts = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        fetch(`${env.baseUrl}/api/s/${MAC}/inbox/my-repo`, {
          method: 'POST',
          headers: { 'x-base-sha': HEX_SHA },
          body: createGzipBuffer(`parallel work ${i}`),
        }).then((r) => r.status)
      )
    );
    assert.deepStrictEqual(posts, [201, 201, 201, 201]);

    const listRes = await fetch(`${env.baseUrl}/api/admin/inbox`, {
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
    });
    const list = await listRes.json();
    assert.strictEqual(list.entries.length, 4);
    assert.deepStrictEqual(list.entries.map((e) => e.seq), [1, 2, 3, 4]);
    assert.strictEqual(new Set(list.entries.map((e) => e.path)).size, 4);
  } finally {
    await env.close();
  }
});

// Legacy index.json entries (pre-sidecar era) are still listed, with
// sidecar entries sequenced after them.
test('Fix item 2: legacy index entries merge with sidecars', async () => {
  const legacy = {
    seq: 1,
    entries: [
      { seq: 1, from: 'old-agent', repo: 'my-repo', base_sha: HEX_SHA, size_bytes: 3, path: 'inbox/old-agent/20260101-000000-my-repo-aaaaaaaa.tar.gz', received_at: '2026-01-01T00:00:00.000Z' },
    ],
  };
  const env = await setupTestServer({ 'inbox/index.json': JSON.stringify(legacy) });
  try {
    const post = await fetch(`${env.baseUrl}/api/s/${MAC}/inbox/my-repo`, {
      method: 'POST',
      headers: { 'x-base-sha': HEX_SHA },
      body: createGzipBuffer('new work'),
    });
    assert.strictEqual(post.status, 201);

    const listRes = await fetch(`${env.baseUrl}/api/admin/inbox`, {
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
    });
    const list = await listRes.json();
    assert.strictEqual(list.seq, 2);
    assert.strictEqual(list.entries[0].from, 'old-agent');
    assert.strictEqual(list.entries[0].seq, 1);
    assert.strictEqual(list.entries[1].from, 'macmuse');
    assert.strictEqual(list.entries[1].seq, 2);
  } finally {
    await env.close();
  }
});

// Round 2, item 2: the etag of a @vercel/blob get() result lives on
// result.blob.etag (SDK 2.x GetBlobResult), not at the top level.
// Reading result.etag silently disabled conditional writes in
// production while the memory adapter masked it in tests.
test('Fix round 2 (item 2): etagFromGetResult follows the SDK get() shape', async () => {
  const sdkShape = {
    statusCode: 200,
    stream: null,
    headers: new Headers({ etag: 'header-etag' }),
    blob: { pathname: 'inbox/index.json', etag: 'blob-etag' },
  };
  assert.strictEqual(etagFromGetResult(sdkShape), 'blob-etag');
  assert.strictEqual(
    etagFromGetResult({ statusCode: 200, headers: new Headers({ etag: 'header-etag' }), blob: {} }),
    'header-etag'
  );
  assert.strictEqual(etagFromGetResult({ statusCode: 200, headers: new Headers(), blob: {} }), undefined);
  assert.strictEqual(etagFromGetResult(null), undefined);
});

// Round 2, item 4: the stored `from` must be the SANITISED identity.
// A label like "Worker One/x" otherwise lands raw in the blob path,
// producing a 4-segment path the strict inbox-file guard rejects.
test('Fix round 2 (item 4): messy signed label is sanitised before storage', async () => {
  const env = await setupTestServer();
  try {
    const mintRes = await fetch(`${env.baseUrl}/api/admin/mint`, {
      method: 'POST',
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl_minutes: 30, label: 'Worker One/x' }),
    });
    assert.strictEqual(mintRes.status, 200);
    const { token } = await mintRes.json();

    const payload = createGzipBuffer('worker one work');
    const post = await fetch(`${env.baseUrl}/api/s/${token}/inbox/proj`, {
      method: 'POST',
      headers: { 'x-base-sha': HEX_SHA },
      body: payload,
    });
    assert.strictEqual(post.status, 201);

    const listRes = await fetch(`${env.baseUrl}/api/admin/inbox`, {
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
    });
    const index = await listRes.json();
    const entry = index.entries[0];
    assert.strictEqual(entry.from, 'worker-one-x');
    assert.strictEqual(entry.path.split('/').length, 3);

    const dl = await fetch(
      `${env.baseUrl}/api/admin/inbox-file?path=${encodeURIComponent(entry.path)}`,
      { headers: { 'x-admin-token': TEST_ADMIN_TOKEN } }
    );
    assert.strictEqual(dl.status, 200);
    assert.deepStrictEqual(Buffer.from(await dl.arrayBuffer()), payload);
  } finally {
    await env.close();
  }
});

// Item 3: repo names containing ".." as a substring stay retrievable
test('Fix item 3: inbox-file allows a..b, rejects traversal shapes', async () => {
  const payload = createGzipBuffer('dotdot repo work');
  const goodPath = 'inbox/agent-x/20260101-000000-a..b.tar.gz';
  const env = await setupTestServer({ [goodPath]: payload });
  try {
    const ok = await fetch(
      `${env.baseUrl}/api/admin/inbox-file?path=${encodeURIComponent(goodPath)}`,
      { headers: { 'x-admin-token': TEST_ADMIN_TOKEN } }
    );
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(Buffer.from(await ok.arrayBuffer()), payload);

    for (const bad of ['inbox/../secret.tar.gz', 'inbox/a/../../b.tar.gz', 'inbox/a/b/c.tar.gz', 'inbox/a/..\\b.tar.gz']) {
      const res = await fetch(
        `${env.baseUrl}/api/admin/inbox-file?path=${encodeURIComponent(bad)}`,
        { headers: { 'x-admin-token': TEST_ADMIN_TOKEN } }
      );
      assert.strictEqual(res.status, 400, `expected 400 for ${bad}`);
    }
  } finally {
    await env.close();
  }
});

// Item 5: chunked oversize upload receives a real 413 response.
// Uses a raw TCP socket: the http client's request/response state
// machine races with a mid-upload response differently across Node
// versions (on Node 22 the client promise can be left pending when
// the server answers and closes), which is a client artefact, not
// the behaviour under test. The behaviour under test is purely
// server-side: the 413 bytes must arrive before the socket closes.
test('Fix item 5: chunked oversize inbox POST returns 413 JSON, not a reset', { timeout: 30000 }, async () => {
  const env = await setupTestServer();
  try {
    const raw = await new Promise((resolve) => {
      const sock = net.connect(env.port, '127.0.0.1', async () => {
        sock.write(
          `POST /api/s/${MAC}/inbox/my-repo HTTP/1.1\r\n` +
          'Host: 127.0.0.1\r\n' +
          'Content-Type: application/gzip\r\n' +
          `x-base-sha: ${HEX_SHA}\r\n` +
          'Transfer-Encoding: chunked\r\n' +
          'Connection: close\r\n\r\n'
        );
        const chunk = Buffer.alloc(128 * 1024, 0x61);
        const frame = Buffer.concat([
          Buffer.from(chunk.length.toString(16) + '\r\n'),
          chunk,
          Buffer.from('\r\n'),
        ]);
        let sent = 0;
        const total = MAX_BODY_SIZE + 256 * 1024;
        while (sent < total) {
          sock.write(frame);
          sent += chunk.length;
          await new Promise((r) => setTimeout(r, 2));
        }
        sock.write('0\r\n\r\n');
      });
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => { buf = Buffer.concat([buf, d]); });
      sock.on('error', () => {});
      sock.on('close', () => resolve(buf.toString('latin1')));
      setTimeout(() => {
        try { sock.destroy(); } catch { /* already closed */ }
        resolve(buf.toString('latin1'));
      }, 10000).unref();
    });
    assert.match(raw, /^HTTP\/1\.1 413/);
    assert.match(raw, /"error"/);
  } finally {
    await env.close();
  }
});

// Item 6 (+7): malformed percent-encoding is a 400 through the router catch
test('Fix item 6/7: malformed percent-encoding returns 400 JSON', async () => {
  const env = await setupTestServer();
  try {
    const res = await fetch(`${env.baseUrl}/api/s/%E0%A4%A/manifest`);
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  } finally {
    await env.close();
  }
});

// Item 8: mint rejects labels that sanitizeFrom reduces to null
test('Fix item 8: mint rejects a Japanese-only label', async () => {
  const env = await setupTestServer();
  try {
    const res = await fetch(`${env.baseUrl}/api/admin/mint`, {
      method: 'POST',
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl_minutes: 30, label: 'テスト専用' }),
    });
    assert.strictEqual(res.status, 400);
  } finally {
    await env.close();
  }
});

// Item 9: sha format and gzip magic are enforced on both write endpoints
test('Fix item 9: invalid sha and non-gzip bodies are rejected', async () => {
  const env = await setupTestServer();
  try {
    const badShaInbox = await fetch(`${env.baseUrl}/api/s/${MAC}/inbox/my-repo`, {
      method: 'POST',
      headers: { 'x-base-sha': 'not-a-sha!' },
      body: createGzipBuffer('work'),
    });
    assert.strictEqual(badShaInbox.status, 400);

    const plainInbox = await fetch(`${env.baseUrl}/api/s/${MAC}/inbox/my-repo`, {
      method: 'POST',
      headers: { 'x-base-sha': HEX_SHA },
      body: Buffer.from('this is not gzip'),
    });
    assert.strictEqual(plainInbox.status, 400);

    const badShaSnap = await fetch(`${env.baseUrl}/api/admin/snapshot/my-repo`, {
      method: 'PUT',
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN, 'x-sha': 'zz-top' },
      body: createGzipBuffer('snap'),
    });
    assert.strictEqual(badShaSnap.status, 400);

    const plainSnap = await fetch(`${env.baseUrl}/api/admin/snapshot/my-repo`, {
      method: 'PUT',
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN, 'x-sha': HEX_SHA },
      body: Buffer.from('this is not gzip'),
    });
    assert.strictEqual(plainSnap.status, 400);
  } finally {
    await env.close();
  }
});

// Item 10: Cache-Control: private, no-store on authenticated responses
test('Fix item 10: authenticated responses carry Cache-Control: private, no-store', async () => {
  const env = await setupTestServer({ 'snapshots/my-repo.tar.gz': createGzipBuffer('seed') });
  try {
    const manifest = await fetch(`${env.baseUrl}/api/s/${MAC}/manifest`);
    assert.strictEqual(manifest.headers.get('cache-control'), 'private, no-store');

    const dl = await fetch(`${env.baseUrl}/api/s/${MAC}/dl/my-repo`);
    assert.strictEqual(dl.headers.get('cache-control'), 'private, no-store');

    const admin = await fetch(`${env.baseUrl}/api/admin/inbox`, {
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
    });
    assert.strictEqual(admin.headers.get('cache-control'), 'private, no-store');
  } finally {
    await env.close();
  }
});
