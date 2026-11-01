import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestServer, TEST_RECIPIENT_TOKENS, createGzipBuffer } from './helpers.js';

test('Download: hit returns 200 with snapshot bytes and correct headers', async () => {
  const dummyGzip = createGzipBuffer('my-sample-repo-content');
  const initialStorage = {
    'snapshots/test-repo.tar.gz': dummyGzip,
  };

  const env = await setupTestServer(initialStorage);
  try {
    const res = await fetch(`${env.baseUrl}/api/s/${TEST_RECIPIENT_TOKENS.macmuse}/dl/test-repo`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/gzip');
    assert.strictEqual(
      res.headers.get('content-disposition'),
      'attachment; filename="test-repo.tar.gz"'
    );
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepStrictEqual(buf, dummyGzip);
  } finally {
    await env.close();
  }
});

test('Download: returns 404 when repo snapshot is unknown', async () => {
  const env = await setupTestServer();
  try {
    const res = await fetch(`${env.baseUrl}/api/s/${TEST_RECIPIENT_TOKENS.macmuse}/dl/nonexistent`);
    assert.strictEqual(res.status, 404);
    const data = await res.json();
    assert.strictEqual(data.error, 'Repository snapshot not found');
  } finally {
    await env.close();
  }
});

test('Download: rejects invalid repo name with 400', async () => {
  const env = await setupTestServer();
  try {
    // Upper case not allowed
    const resUpper = await fetch(`${env.baseUrl}/api/s/${TEST_RECIPIENT_TOKENS.macmuse}/dl/BadRepo`);
    assert.strictEqual(resUpper.status, 400);
    const dataUpper = await resUpper.json();
    assert.strictEqual(dataUpper.error, 'Invalid repo name');

    // Starting with hyphen/underscore/dot not allowed
    const resHyphen = await fetch(`${env.baseUrl}/api/s/${TEST_RECIPIENT_TOKENS.macmuse}/dl/-badrepo`);
    assert.strictEqual(resHyphen.status, 400);

    // Path traversal characters
    const resTraversal = await fetch(`${env.baseUrl}/api/s/${TEST_RECIPIENT_TOKENS.macmuse}/dl/bad..repo`);
    // 'bad..repo' matches ^[a-z0-9][a-z0-9._-]*$, but let's check non-matching chars like slashes or symbols:
    const resSlash = await fetch(`${env.baseUrl}/api/s/${TEST_RECIPIENT_TOKENS.macmuse}/dl/bad%2Frepo`);
    assert.strictEqual(resSlash.status, 400);
  } finally {
    await env.close();
  }
});

test('Download: rejects invalid agent token with 401', async () => {
  const env = await setupTestServer();
  try {
    const res = await fetch(`${env.baseUrl}/api/s/invalid-token/dl/some-repo`);
    assert.strictEqual(res.status, 401);
  } finally {
    await env.close();
  }
});
