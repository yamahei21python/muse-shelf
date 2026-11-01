import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestServer, TEST_ADMIN_TOKEN, createGzipBuffer } from './helpers.js';

test('Admin Inbox list: filters by since parameter', async () => {
  const indexData = {
    seq: 4,
    entries: [
      { seq: 1, from: 'agent-a', repo: 'repo1', base_sha: 's1', size_bytes: 10, path: 'inbox/agent-a/f1.tar.gz' },
      { seq: 2, from: 'agent-b', repo: 'repo1', base_sha: 's2', size_bytes: 20, path: 'inbox/agent-b/f2.tar.gz' },
      { seq: 3, from: 'agent-c', repo: 'repo2', base_sha: 's3', size_bytes: 30, path: 'inbox/agent-c/f3.tar.gz' },
      { seq: 4, from: 'agent-d', repo: 'repo2', base_sha: 's4', size_bytes: 40, path: 'inbox/agent-d/f4.tar.gz' },
    ],
  };

  const env = await setupTestServer({
    'inbox/index.json': JSON.stringify(indexData),
  });

  try {
    // 1. List all (no since parameter)
    const resAll = await fetch(`${env.baseUrl}/api/admin/inbox`, {
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
    });
    assert.strictEqual(resAll.status, 200);
    const dataAll = await resAll.json();
    assert.strictEqual(dataAll.seq, 4);
    assert.strictEqual(dataAll.entries.length, 4);

    // 2. List with since=2
    const resSince2 = await fetch(`${env.baseUrl}/api/admin/inbox?since=2`, {
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
    });
    assert.strictEqual(resSince2.status, 200);
    const dataSince2 = await resSince2.json();
    assert.strictEqual(dataSince2.seq, 4);
    assert.strictEqual(dataSince2.entries.length, 2);
    assert.deepStrictEqual(dataSince2.entries.map((e) => e.seq), [3, 4]);

    // 3. List with since=4 (none newer)
    const resSince4 = await fetch(`${env.baseUrl}/api/admin/inbox?since=4`, {
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
    });
    assert.strictEqual(resSince4.status, 200);
    const dataSince4 = await resSince4.json();
    assert.strictEqual(dataSince4.entries.length, 0);

    // 4. Reject invalid since
    const resBadSince = await fetch(`${env.baseUrl}/api/admin/inbox?since=invalid`, {
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
    });
    assert.strictEqual(resBadSince.status, 400);
  } finally {
    await env.close();
  }
});

test('Admin Inbox file: downloads stored inbox blob', async () => {
  const dummyGzip = createGzipBuffer('inbox file content');
  const filePath = 'inbox/agent-1/20261101-120000-repo-x.tar.gz';

  const env = await setupTestServer({
    [filePath]: dummyGzip,
  });

  try {
    // Download success
    const res = await fetch(`${env.baseUrl}/api/admin/inbox-file?path=${encodeURIComponent(filePath)}`, {
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/gzip');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepStrictEqual(bytes, dummyGzip);

    // Missing file -> 404
    const res404 = await fetch(`${env.baseUrl}/api/admin/inbox-file?path=inbox/agent-1/missing.tar.gz`, {
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
    });
    assert.strictEqual(res404.status, 404);
    const data404 = await res404.json();
    assert.strictEqual(data404.error, 'File not found');

    // Invalid path (not starting with inbox/) -> 400
    const resNotInbox = await fetch(`${env.baseUrl}/api/admin/inbox-file?path=snapshots/repo-x.tar.gz`, {
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
    });
    assert.strictEqual(resNotInbox.status, 400);
    const dataNotInbox = await resNotInbox.json();
    assert.strictEqual(dataNotInbox.error, 'Invalid path');

    // Path traversal -> 400
    const resTraversal = await fetch(`${env.baseUrl}/api/admin/inbox-file?path=inbox/../meta/repo.json`, {
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
    });
    assert.strictEqual(resTraversal.status, 400);
  } finally {
    await env.close();
  }
});
