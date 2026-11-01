/**
 * Test helpers for muse-shelf.
 * Spawns a local offline HTTP test server using the in-memory store adapter.
 */

import http from 'node:http';
import zlib from 'node:zlib';
import { handleRequest } from '../lib/router.js';
import { setStorageAdapter, createMemoryAdapter } from '../lib/store.js';

export const TEST_ADMIN_TOKEN = 'dummy-admin-token-for-tests';
export const TEST_SIGNING_SECRET = 'dummy-signing-secret-for-tests-key-123';
export const TEST_RECIPIENT_TOKENS = {
  macmuse: 'long-token-macmuse-abc123xyz',
  xmuse: 'long-token-xmuse-def456uvw',
};

/**
 * Creates dummy gzip buffer.
 * @param {string|Buffer} content
 * @returns {Buffer}
 */
export function createGzipBuffer(content = 'dummy repository content') {
  return zlib.gzipSync(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
}

/**
 * Setup test environment variables and in-memory adapter.
 * @param {Record<string, any>} [initialStorage]
 */
export async function setupTestServer(initialStorage = {}) {
  process.env.SHELF_ADMIN_TOKEN = TEST_ADMIN_TOKEN;
  process.env.SHELF_SIGNING_SECRET = TEST_SIGNING_SECRET;
  process.env.SHELF_TOKENS_JSON = JSON.stringify(TEST_RECIPIENT_TOKENS);

  const memoryStore = createMemoryAdapter(initialStorage);
  setStorageAdapter(memoryStore);

  const server = http.createServer((req, res) => {
    handleRequest(req, res);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    port,
    baseUrl,
    memoryStore,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
