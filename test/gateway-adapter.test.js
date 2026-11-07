import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGatewayAdapter } from '../lib/store.js';

function fakeResponse({ status = 200, headers = {}, body = null, json = null }) {
  return {
    status,
    headers: {
      get(name) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
    async arrayBuffer() {
      const buf = body ?? Buffer.alloc(0);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    async json() {
      return json;
    },
  };
}

test('gateway adapter: putBuffer sends bearer + encoded key, returns etag', async () => {
  const calls = [];
  const adapter = createGatewayAdapter({
    baseUrl: 'https://gw.example',
    token: 'sekret',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return fakeResponse({ status: 200, headers: { etag: '"abc123"' } });
    },
  });
  const out = await adapter.putBuffer('meta/my repo.json', Buffer.from('{}'), 'application/json');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://gw.example/' + encodeURIComponent('meta/my repo.json'));
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sekret');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers['If-Match'], undefined);
  assert.equal(out.etag, '"abc123"');
  assert.equal(out.size, 2);
});

test('gateway adapter: putBuffer maps 412 to PreconditionFailed and sends If-Match', async () => {
  const calls = [];
  const adapter = createGatewayAdapter({
    baseUrl: 'https://gw.example',
    token: 't',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return fakeResponse({ status: 412 });
    },
  });
  await assert.rejects(
    adapter.putBuffer('k', Buffer.from('x'), 'text/plain', { ifMatch: '"e1"' }),
    (err) => err.name === 'PreconditionFailed'
  );
  assert.equal(calls[0].init.headers['If-Match'], '"e1"');
});

test('gateway adapter: getBuffer 404 -> null, 200 -> bytes', async () => {
  const missing = createGatewayAdapter({
    baseUrl: 'https://gw.example',
    token: 't',
    fetchImpl: async () => fakeResponse({ status: 404 }),
  });
  assert.equal(await missing.getBuffer('nope'), null);

  const present = createGatewayAdapter({
    baseUrl: 'https://gw.example',
    token: 't',
    fetchImpl: async () => fakeResponse({ status: 200, body: Buffer.from('hello') }),
  });
  assert.equal((await present.getBuffer('k'))?.toString(), 'hello');
});

test('gateway adapter: getEntry combines HEAD etag with GET body', async () => {
  const adapter = createGatewayAdapter({
    baseUrl: 'https://gw.example',
    token: 't',
    fetchImpl: async (url, init) => {
      if (init.method === 'HEAD') {
        return fakeResponse({ status: 200, headers: { etag: '"etag-9"' } });
      }
      return fakeResponse({ status: 200, body: Buffer.from('data') });
    },
  });
  const entry = await adapter.getEntry('meta/x.json');
  assert.equal(entry.etag, '"etag-9"');
  assert.equal(entry.buffer.toString(), 'data');

  const gone = createGatewayAdapter({
    baseUrl: 'https://gw.example',
    token: 't',
    fetchImpl: async () => fakeResponse({ status: 404 }),
  });
  assert.equal(await gone.getEntry('meta/x.json'), null);
});

test('gateway adapter: listPaths paginates and sorts', async () => {
  const pages = [
    { objects: [{ key: 'inbox/b.json' }], truncated: true, cursor: 'c1' },
    { objects: [{ key: 'inbox/a.json' }], truncated: false, cursor: null },
  ];
  let i = 0;
  const urls = [];
  const adapter = createGatewayAdapter({
    baseUrl: 'https://gw.example',
    token: 't',
    fetchImpl: async (url) => {
      urls.push(url);
      return fakeResponse({ status: 200, json: pages[i++] });
    },
  });
  const paths = await adapter.listPaths('inbox/');
  assert.deepEqual(paths, ['inbox/a.json', 'inbox/b.json']);
  assert.match(urls[0], /prefix=inbox%2F/);
  assert.match(urls[1], /cursor=c1/);
});
