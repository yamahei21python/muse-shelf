import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestServer, TEST_ADMIN_TOKEN, createGzipBuffer } from './helpers.js';
import { MAX_BODY_SIZE } from '../lib/validation.js';

test('Snapshot PUT: stores snapshot bytes and writes meta JSON', async () => {
  const env = await setupTestServer();
  try {
    const snapshotBytes = createGzipBuffer('repository source at commit abc');
    const res = await fetch(`${env.baseUrl}/api/admin/snapshot/project-a`, {
      method: 'PUT',
      headers: {
        'x-admin-token': TEST_ADMIN_TOKEN,
        'x-sha': '0123456789abcdef0123456789abcdef01234567',
        'content-type': 'application/gzip',
      },
      body: snapshotBytes,
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.deepStrictEqual(data, {
      ok: true,
      repo: 'project-a',
      sha: '0123456789abcdef0123456789abcdef01234567',
      size_bytes: snapshotBytes.length,
    });

    // Verify snapshot file in store (versioned path, meta points at it)
    const versionedPath = 'snapshots/project-a@0123456789abcdef0123456789abcdef01234567.tar.gz';
    const storedSnapshot = await env.memoryStore.getBuffer(versionedPath);
    assert.deepStrictEqual(storedSnapshot, snapshotBytes);

    // Verify meta file in store
    const storedMetaBuf = await env.memoryStore.getBuffer('meta/project-a.json');
    assert.ok(storedMetaBuf);
    const meta = JSON.parse(storedMetaBuf.toString('utf8'));
    assert.strictEqual(meta.repo, 'project-a');
    assert.strictEqual(meta.sha, '0123456789abcdef0123456789abcdef01234567');
    assert.strictEqual(meta.path, versionedPath);
    assert.strictEqual(meta.size_bytes, snapshotBytes.length);
    assert.ok(meta.updated_at);
    assert.strictEqual(new Date(meta.updated_at).toISOString(), meta.updated_at);
  } finally {
    await env.close();
  }
});

test('Snapshot PUT: rejects missing x-sha with 400', async () => {
  const env = await setupTestServer();
  try {
    const snapshotBytes = createGzipBuffer('sample');
    const res = await fetch(`${env.baseUrl}/api/admin/snapshot/project-a`, {
      method: 'PUT',
      headers: {
        'x-admin-token': TEST_ADMIN_TOKEN,
        'content-type': 'application/gzip',
      },
      body: snapshotBytes,
    });

    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.error, 'Missing x-sha header');
  } finally {
    await env.close();
  }
});

test('Snapshot PUT: rejects invalid repo name with 400', async () => {
  const env = await setupTestServer();
  try {
    const snapshotBytes = createGzipBuffer('sample');
    const res = await fetch(`${env.baseUrl}/api/admin/snapshot/Invalid_Name`, {
      method: 'PUT',
      headers: {
        'x-admin-token': TEST_ADMIN_TOKEN,
        'x-sha': 'abc1234',
      },
      body: snapshotBytes,
    });

    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.error, 'Invalid repo name');
  } finally {
    await env.close();
  }
});

test('Snapshot PUT: rejects oversize body with 413', async () => {
  const env = await setupTestServer();
  try {
    const oversizePayload = Buffer.alloc(MAX_BODY_SIZE + 2048, 1);
    const res = await fetch(`${env.baseUrl}/api/admin/snapshot/project-a`, {
      method: 'PUT',
      headers: {
        'x-admin-token': TEST_ADMIN_TOKEN,
        'x-sha': 'abc1234',
        'content-length': String(oversizePayload.length),
      },
      body: oversizePayload,
    });

    assert.strictEqual(res.status, 413);
    const data = await res.json();
    assert.strictEqual(data.error, 'Payload too large');
  } finally {
    await env.close();
  }
});

test('Snapshot PUT: rejects unauthenticated call with 401', async () => {
  const env = await setupTestServer();
  try {
    const res = await fetch(`${env.baseUrl}/api/admin/snapshot/project-a`, {
      method: 'PUT',
      headers: {
        'x-sha': 'abc1234',
      },
      body: 'foo',
    });
    assert.strictEqual(res.status, 401);
  } finally {
    await env.close();
  }
});

test('Snapshot PUT: stores created_by from x-created-by header (sanitised)', async () => {
  const env = await setupTestServer();
  try {
    const snapshotBytes = createGzipBuffer('with creator');
    const res = await fetch(`${env.baseUrl}/api/admin/snapshot/project-a`, {
      method: 'PUT',
      headers: {
        'x-admin-token': TEST_ADMIN_TOKEN,
        'x-sha': '0123456789abcdef0123456789abcdef01234567',
        'x-created-by': 'MacMuse',
        'content-type': 'application/gzip',
      },
      body: snapshotBytes,
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.created_by, 'macmuse');
    const storedMetaBuf = await env.memoryStore.getBuffer('meta/project-a.json');
    const meta = JSON.parse(storedMetaBuf.toString('utf8'));
    assert.strictEqual(meta.created_by, 'macmuse');
  } finally {
    await env.close();
  }
});

test('Snapshot PUT: rejects invalid x-created-by with 400', async () => {
  const env = await setupTestServer();
  try {
    const snapshotBytes = createGzipBuffer('bad creator');
    const res = await fetch(`${env.baseUrl}/api/admin/snapshot/project-a`, {
      method: 'PUT',
      headers: {
        'x-admin-token': TEST_ADMIN_TOKEN,
        'x-sha': 'abc1234',
        'x-created-by': '!!!',
        'content-type': 'application/gzip',
      },
      body: snapshotBytes,
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.error, 'Invalid x-created-by header');
  } finally {
    await env.close();
  }
});

test('Snapshot PUT: without x-created-by, meta has no created_by (legacy)', async () => {
  const env = await setupTestServer();
  try {
    const snapshotBytes = createGzipBuffer('no creator');
    const res = await fetch(`${env.baseUrl}/api/admin/snapshot/project-a`, {
      method: 'PUT',
      headers: {
        'x-admin-token': TEST_ADMIN_TOKEN,
        'x-sha': 'abc1234',
        'content-type': 'application/gzip',
      },
      body: snapshotBytes,
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(!('created_by' in data));
    const storedMetaBuf = await env.memoryStore.getBuffer('meta/project-a.json');
    const meta = JSON.parse(storedMetaBuf.toString('utf8'));
    assert.ok(!('created_by' in meta));
  } finally {
    await env.close();
  }
});
