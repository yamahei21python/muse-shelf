import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestServer, TEST_RECIPIENT_TOKENS } from './helpers.js';

test('Manifest: returns empty list when no snapshots seeded', async () => {
  const env = await setupTestServer();
  try {
    const res = await fetch(`${env.baseUrl}/api/s/${TEST_RECIPIENT_TOKENS.macmuse}/manifest`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.deepStrictEqual(data, { repos: [] });
  } finally {
    await env.close();
  }
});

test('Manifest: returns meta objects sorted by repo name', async () => {
  const metaZeta = {
    repo: 'zeta-repo',
    sha: 'sha-zeta-999',
    size_bytes: 512,
    updated_at: '2026-10-30T10:00:00.000Z',
  };
  const metaAlpha = {
    repo: 'alpha-repo',
    sha: 'sha-alpha-111',
    size_bytes: 1024,
    updated_at: '2026-10-31T12:00:00.000Z',
  };
  const metaBeta = {
    repo: 'beta-repo',
    sha: 'sha-beta-222',
    size_bytes: 2048,
    updated_at: '2026-11-01T08:00:00.000Z',
  };

  const initialStorage = {
    'meta/zeta-repo.json': JSON.stringify(metaZeta),
    'meta/alpha-repo.json': JSON.stringify(metaAlpha),
    'meta/beta-repo.json': JSON.stringify(metaBeta),
  };

  const env = await setupTestServer(initialStorage);
  try {
    const res = await fetch(`${env.baseUrl}/api/s/${TEST_RECIPIENT_TOKENS.macmuse}/manifest`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(Array.isArray(data.repos), true);
    assert.strictEqual(data.repos.length, 3);
    assert.deepStrictEqual(
      data.repos.map((r) => r.repo),
      ['alpha-repo', 'beta-repo', 'zeta-repo']
    );
    assert.deepStrictEqual(data.repos[0], metaAlpha);
    assert.deepStrictEqual(data.repos[1], metaBeta);
    assert.deepStrictEqual(data.repos[2], metaZeta);
  } finally {
    await env.close();
  }
});
