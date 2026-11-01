import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestServer, TEST_ADMIN_TOKEN, createGzipBuffer } from './helpers.js';

test('Mint: produces a signed token that verifies and accesses agent routes', async () => {
  const dummyGzip = createGzipBuffer('seeded code');
  const env = await setupTestServer({
    'snapshots/my-repo.tar.gz': dummyGzip,
  });

  try {
    // 1. Call mint endpoint as admin
    const mintRes = await fetch(`${env.baseUrl}/api/admin/mint`, {
      method: 'POST',
      headers: {
        'x-admin-token': TEST_ADMIN_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ttl_minutes: 30,
        label: 'agent-mint-test',
      }),
    });

    assert.strictEqual(mintRes.status, 200);
    const mintData = await mintRes.json();
    assert.ok(mintData.token);
    assert.ok(mintData.expires_at);
    assert.strictEqual(mintData.token.startsWith('v1.'), true);

    const mintedToken = mintData.token;

    // 2. Use minted token to fetch manifest
    const manifestRes = await fetch(`${env.baseUrl}/api/s/${mintedToken}/manifest`);
    assert.strictEqual(manifestRes.status, 200);

    // 3. Use minted token to download snapshot
    const dlRes = await fetch(`${env.baseUrl}/api/s/${mintedToken}/dl/my-repo`);
    assert.strictEqual(dlRes.status, 200);
    const dlBytes = Buffer.from(await dlRes.arrayBuffer());
    assert.deepStrictEqual(dlBytes, dummyGzip);

    // 4. Use minted token to post to inbox (verifying label is default from)
    const inboxRes = await fetch(`${env.baseUrl}/api/s/${mintedToken}/inbox/my-repo`, {
      method: 'POST',
      headers: {
        'x-base-sha': '0123456789abcdef0123456789abcdef01234567',
      },
      body: createGzipBuffer('minted agent work'),
    });
    assert.strictEqual(inboxRes.status, 201);
    const inboxData = await inboxRes.json();
    assert.strictEqual(inboxData.ok, true);

    // Verify index has from = 'agent-mint-test'
    const indexBuf = await env.memoryStore.getBuffer('inbox/index.json');
    const index = JSON.parse(indexBuf.toString('utf8'));
    assert.strictEqual(index.entries[0].from, 'agent-mint-test');
  } finally {
    await env.close();
  }
});

test('Mint: input validation for ttl_minutes and label', async () => {
  const env = await setupTestServer();
  try {
    // ttl_minutes <= 0
    const resLow = await fetch(`${env.baseUrl}/api/admin/mint`, {
      method: 'POST',
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl_minutes: 0, label: 'bot' }),
    });
    assert.strictEqual(resLow.status, 400);

    // ttl_minutes > 1440
    const resHigh = await fetch(`${env.baseUrl}/api/admin/mint`, {
      method: 'POST',
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl_minutes: 1441, label: 'bot' }),
    });
    assert.strictEqual(resHigh.status, 400);

    // ttl_minutes not integer
    const resFloat = await fetch(`${env.baseUrl}/api/admin/mint`, {
      method: 'POST',
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl_minutes: 10.5, label: 'bot' }),
    });
    assert.strictEqual(resFloat.status, 400);

    // missing label
    const resNoLabel = await fetch(`${env.baseUrl}/api/admin/mint`, {
      method: 'POST',
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl_minutes: 60 }),
    });
    assert.strictEqual(resNoLabel.status, 400);

    // empty label
    const resEmptyLabel = await fetch(`${env.baseUrl}/api/admin/mint`, {
      method: 'POST',
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl_minutes: 60, label: '   ' }),
    });
    assert.strictEqual(resEmptyLabel.status, 400);
  } finally {
    await env.close();
  }
});
