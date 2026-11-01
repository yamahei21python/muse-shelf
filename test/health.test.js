import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestServer } from './helpers.js';

test('Health endpoint GET /api/health returns 200 { ok: true }', async () => {
  const env = await setupTestServer();
  try {
    const res = await fetch(`${env.baseUrl}/api/health`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type')?.includes('application/json'), true);
    const data = await res.json();
    assert.deepStrictEqual(data, { ok: true });
  } finally {
    await env.close();
  }
});

test('Health endpoint rejects non-GET/HEAD methods with 405', async () => {
  const env = await setupTestServer();
  try {
    const res = await fetch(`${env.baseUrl}/api/health`, { method: 'POST' });
    assert.strictEqual(res.status, 405);
    const data = await res.json();
    assert.strictEqual(data.error, 'Method not allowed');
  } finally {
    await env.close();
  }
});
