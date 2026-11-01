import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidRepo, sanitizeFrom, formatTimestamp, MAX_BODY_SIZE } from '../lib/validation.js';
import { createMemoryAdapter } from '../lib/store.js';
import { mintToken, verifySignedToken, safeEqual } from '../lib/auth.js';

test('Unit: validation and sanitization', () => {
  // Valid repo names
  assert.strictEqual(isValidRepo('repo'), true);
  assert.strictEqual(isValidRepo('repo-1'), true);
  assert.strictEqual(isValidRepo('repo.js'), true);
  assert.strictEqual(isValidRepo('repo_name'), true);
  assert.strictEqual(isValidRepo('0abc'), true);

  // Invalid repo names
  assert.strictEqual(isValidRepo(''), false);
  assert.strictEqual(isValidRepo('Repo'), false);
  assert.strictEqual(isValidRepo('-repo'), false);
  assert.strictEqual(isValidRepo('_repo'), false);
  assert.strictEqual(isValidRepo('.repo'), false);
  assert.strictEqual(isValidRepo('repo/sub'), false);
  assert.strictEqual(isValidRepo(null), false);
  assert.strictEqual(isValidRepo(123), false);

  // From sanitization
  assert.strictEqual(sanitizeFrom('macmuse'), 'macmuse');
  assert.strictEqual(sanitizeFrom('Mac-Muse'), 'mac-muse');
  assert.strictEqual(sanitizeFrom('  AGENT_007  '), 'agent_007');
  assert.strictEqual(sanitizeFrom('Agent!@#$Special'), 'agent----special');
  assert.strictEqual(sanitizeFrom('---bad-leading'), 'bad-leading');
  assert.strictEqual(sanitizeFrom('---'), null);
  assert.strictEqual(sanitizeFrom(''), null);
  assert.strictEqual(sanitizeFrom(null), null);

  // Timestamp format: YYYYMMDD-HHMMSS
  const ts = formatTimestamp(new Date('2026-11-01T15:30:45Z'));
  assert.strictEqual(ts, '20261101-153045');
  assert.strictEqual(/^\d{8}-\d{6}$/.test(formatTimestamp()), true);

  // MAX_BODY_SIZE is 4.5 MB
  assert.strictEqual(MAX_BODY_SIZE, 4.5 * 1024 * 1024);
});

test('Unit: in-memory store adapter', async () => {
  const store = createMemoryAdapter({
    'initial/test.txt': 'hello',
  });

  // getBuffer hit
  const buf = await store.getBuffer('initial/test.txt');
  assert.ok(buf);
  assert.strictEqual(buf.toString('utf8'), 'hello');

  // getBuffer miss returns null
  const missing = await store.getBuffer('initial/missing.txt');
  assert.strictEqual(missing, null);

  // putBuffer
  await store.putBuffer('new/path.bin', Buffer.from([1, 2, 3]), 'application/octet-stream');
  const newBuf = await store.getBuffer('new/path.bin');
  assert.deepStrictEqual(newBuf, Buffer.from([1, 2, 3]));

  // listPaths
  const initialPaths = await store.listPaths('initial/');
  assert.deepStrictEqual(initialPaths, ['initial/test.txt']);

  const allPaths = await store.listPaths();
  assert.deepStrictEqual(allPaths, ['initial/test.txt', 'new/path.bin']);
});

test('Unit: auth token minting and timing safe equality', () => {
  const secret = 'super-secret-key-1234567890';
  const { token, expires_at } = mintToken('worker-1', 10, secret);

  assert.ok(token.startsWith('v1.'));
  assert.ok(expires_at);

  const verified = verifySignedToken(token, secret);
  assert.strictEqual(verified.ok, true);
  assert.strictEqual(verified.label, 'worker-1');

  // Safe equal
  assert.strictEqual(safeEqual('hello', 'hello'), true);
  assert.strictEqual(safeEqual('hello', 'world'), false);
  assert.strictEqual(safeEqual('hello', 'hello-longer'), false);
  assert.strictEqual(safeEqual(null, 'hello'), false);
});
