import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestServer, TEST_RECIPIENT_TOKENS, createGzipBuffer } from './helpers.js';
import { MAX_BODY_SIZE } from '../lib/validation.js';

test('Inbox POST: appends entry, increments seq, and stores blob', async () => {
  const env = await setupTestServer();
  try {
    const payload1 = createGzipBuffer('work product 1');
    const res1 = await fetch(
      `${env.baseUrl}/api/s/${TEST_RECIPIENT_TOKENS.macmuse}/inbox/my-repo`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/gzip',
          'x-base-sha': 'base-sha-12345',
        },
        body: payload1,
      }
    );
    assert.strictEqual(res1.status, 201);
    const data1 = await res1.json();
    assert.strictEqual(data1.ok, true);
    assert.strictEqual(data1.seq, 1);

    // Second post: increments seq to 2
    const payload2 = createGzipBuffer('work product 2');
    const res2 = await fetch(
      `${env.baseUrl}/api/s/${TEST_RECIPIENT_TOKENS.macmuse}/inbox/my-repo`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/gzip',
          'x-base-sha': 'base-sha-67890',
          'x-from': 'custom-agent',
        },
        body: payload2,
      }
    );
    assert.strictEqual(res2.status, 201);
    const data2 = await res2.json();
    assert.strictEqual(data2.ok, true);
    assert.strictEqual(data2.seq, 2);

    // Verify index.json content
    const indexBuf = await env.memoryStore.getBuffer('inbox/index.json');
    assert.ok(indexBuf);
    const index = JSON.parse(indexBuf.toString('utf8'));
    assert.strictEqual(index.seq, 2);
    assert.strictEqual(index.entries.length, 2);

    // Check entry 1 default from = 'macmuse'
    assert.strictEqual(index.entries[0].seq, 1);
    assert.strictEqual(index.entries[0].from, 'macmuse');
    assert.strictEqual(index.entries[0].repo, 'my-repo');
    assert.strictEqual(index.entries[0].base_sha, 'base-sha-12345');
    assert.strictEqual(index.entries[0].size_bytes, payload1.length);
    assert.strictEqual(index.entries[0].path.startsWith('inbox/macmuse/'), true);
    assert.strictEqual(index.entries[0].path.endsWith('-my-repo.tar.gz'), true);
    assert.ok(index.entries[0].received_at);

    // Check entry 2 custom from = 'custom-agent'
    assert.strictEqual(index.entries[1].seq, 2);
    assert.strictEqual(index.entries[1].from, 'custom-agent');
    assert.strictEqual(index.entries[1].repo, 'my-repo');
    assert.strictEqual(index.entries[1].base_sha, 'base-sha-67890');
    assert.strictEqual(index.entries[1].path.startsWith('inbox/custom-agent/'), true);

    // Check that stored blob bytes match
    const storedBlob1 = await env.memoryStore.getBuffer(index.entries[0].path);
    assert.deepStrictEqual(storedBlob1, payload1);
  } finally {
    await env.close();
  }
});

test('Inbox POST: rejects missing x-base-sha header with 400', async () => {
  const env = await setupTestServer();
  try {
    const payload = createGzipBuffer('work product');
    const res = await fetch(
      `${env.baseUrl}/api/s/${TEST_RECIPIENT_TOKENS.macmuse}/inbox/my-repo`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/gzip',
        },
        body: payload,
      }
    );
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.error, 'Missing x-base-sha header');
  } finally {
    await env.close();
  }
});

test('Inbox POST: rejects bad repo name with 400', async () => {
  const env = await setupTestServer();
  try {
    const payload = createGzipBuffer('work product');
    const res = await fetch(
      `${env.baseUrl}/api/s/${TEST_RECIPIENT_TOKENS.macmuse}/inbox/INVALID_REPO`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/gzip',
          'x-base-sha': 'sha123',
        },
        body: payload,
      }
    );
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.error, 'Invalid repo name');
  } finally {
    await env.close();
  }
});

test('Inbox POST: rejects oversize body (> 4.5 MB) with 413', async () => {
  const env = await setupTestServer();
  try {
    const oversizePayload = Buffer.alloc(MAX_BODY_SIZE + 1024, 0);
    const res = await fetch(
      `${env.baseUrl}/api/s/${TEST_RECIPIENT_TOKENS.macmuse}/inbox/my-repo`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/gzip',
          'x-base-sha': 'sha123',
          'content-length': String(oversizePayload.length),
        },
        body: oversizePayload,
      }
    );
    assert.strictEqual(res.status, 413);
    const data = await res.json();
    assert.strictEqual(data.error, 'Payload too large');
  } finally {
    await env.close();
  }
});
