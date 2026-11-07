/**
 * Storage adapter module for muse-shelf.
 * Default production implementation uses @vercel/blob with access: 'private'.
 * Allows injecting an in-memory adapter for network-free testing.
 */

let currentAdapter = null;

/**
 * Extracts the etag from a @vercel/blob `get()` result.
 * The SDK (2.x) returns { statusCode, stream, headers, blob: { ..., etag } }:
 * the etag lives on `blob`, NOT at the top level (reading result.etag
 * silently yields undefined and disables conditional writes — that was
 * the round-2 bug). Falls back to the response ETag header.
 * Exported as a pure function so the SDK shape is pinned by unit tests.
 * @param {any} result
 * @returns {string | undefined}
 */
export function etagFromGetResult(result) {
  if (!result || typeof result !== 'object') return undefined;
  if (typeof result.blob?.etag === 'string' && result.blob.etag) {
    return result.blob.etag;
  }
  const headerEtag = result.headers?.get?.('etag');
  if (typeof headerEtag === 'string' && headerEtag) {
    return headerEtag;
  }
  return undefined;
}

/**
 * Creates an in-memory storage adapter for unit testing.
 * @param {Record<string, Buffer | string | { buffer: Buffer, contentType?: string, etag?: string }>} [initialData]
 */
export function createMemoryAdapter(initialData = {}) {
  const store = new Map();
  const etags = new Map();
  let nextVersion = 1;

  for (const [key, value] of Object.entries(initialData)) {
    const v = String(nextVersion++);
    etags.set(key, v);
    if (Buffer.isBuffer(value)) {
      store.set(key, { buffer: value, contentType: 'application/octet-stream', etag: v });
    } else if (typeof value === 'string') {
      store.set(key, { buffer: Buffer.from(value, 'utf8'), contentType: 'text/plain', etag: v });
    } else if (value && typeof value === 'object' && value.buffer) {
      store.set(key, {
        buffer: Buffer.isBuffer(value.buffer) ? value.buffer : Buffer.from(value.buffer),
        contentType: value.contentType || 'application/octet-stream',
        etag: value.etag || v,
      });
      if (value.etag) {
        etags.set(key, value.etag);
      }
    }
  }

  return {
    async putBuffer(path, buffer, contentType = 'application/octet-stream', opts = {}) {
      const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      const current = store.get(path);
      const currentEtag = current ? current.etag : undefined;

      if (opts.ifMatch !== undefined) {
        if (opts.ifMatch !== currentEtag) {
          const err = new Error('Precondition Failed');
          err.name = 'PreconditionFailed';
          throw err;
        }
      }

      const newEtag = String(nextVersion++);
      etags.set(path, newEtag);
      store.set(path, { buffer: buf, contentType, etag: newEtag });
      return { path, contentType, size: buf.length, etag: newEtag };
    },

    async getBuffer(path) {
      const item = store.get(path);
      if (!item) return null;
      return Buffer.from(item.buffer);
    },

    async getEntry(path) {
      const item = store.get(path);
      if (!item) return null;
      return {
        buffer: Buffer.from(item.buffer),
        etag: item.etag,
      };
    },

    async listPaths(prefix = '') {
      const result = [];
      for (const key of store.keys()) {
        if (!prefix || key.startsWith(prefix)) {
          result.push(key);
        }
      }
      return result.sort();
    },

    /** Test helper to inspect raw store */
    _store: store,
  };
}

/**
 * Production storage adapter backed by @vercel/blob.
 */
export function createVercelBlobAdapter() {
  return {
    async putBuffer(path, buffer, contentType = 'application/octet-stream', opts = {}) {
      const { put } = await import('@vercel/blob');
      const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      const putOpts = {
        access: 'private',
        contentType,
        addRandomSuffix: false,
        allowOverwrite: true,
      };
      if (opts.ifMatch !== undefined) {
        putOpts.ifMatch = opts.ifMatch;
      }
      try {
        const result = await put(path, buf, putOpts);
        return { path, contentType, size: buf.length, etag: result.etag };
      } catch (err) {
        // Normalise precondition failures to the adapter contract
        // (name === 'PreconditionFailed', same as the memory adapter).
        // The SDK's BlobPreconditionFailedError does not reliably
        // carry that name at runtime (it surfaces as plain 'Error'
        // in the bundled serverless build), so match on the message.
        if (/precondition failed/i.test(err?.message || '') || (err?.name || '').includes('Precondition')) {
          const normalised = new Error(err.message || 'Precondition failed');
          normalised.name = 'PreconditionFailed';
          throw normalised;
        }
        throw err;
      }
    },

    async getBuffer(path) {
      const { get } = await import('@vercel/blob');
      try {
        const result = await get(path, { access: 'private' });
        if (!result || !result.stream) return null;
        const arrayBuffer = await new Response(result.stream).arrayBuffer();
        return Buffer.from(arrayBuffer);
      } catch (err) {
        if (
          err?.name === 'BlobNotFoundError' ||
          err?.statusCode === 404 ||
          err?.status === 404
        ) {
          return null;
        }
        throw err;
      }
    },

    async getEntry(path) {
      const { get, head } = await import('@vercel/blob');
      // The etag used for conditional writes must come from head()
      // (the metadata API). The etag on the download path (get()'s
      // blob.etag, i.e. the edge response's ETag header) does NOT
      // satisfy put's precondition — verified live: a quiescent
      // sequential write still failed with "ETag mismatch".
      let headEtag;
      try {
        const meta = await head(path);
        if (!meta) return null;
        headEtag = meta.etag;
      } catch (err) {
        if (
          err?.name === 'BlobNotFoundError' ||
          err?.statusCode === 404 ||
          err?.status === 404
        ) {
          return null;
        }
        throw err;
      }
      try {
        const result = await get(path, { access: 'private' });
        if (!result || !result.stream) return null;
        const arrayBuffer = await new Response(result.stream).arrayBuffer();
        return {
          buffer: Buffer.from(arrayBuffer),
          etag: headEtag || etagFromGetResult(result),
        };
      } catch (err) {
        if (
          err?.name === 'BlobNotFoundError' ||
          err?.statusCode === 404 ||
          err?.status === 404
        ) {
          return null;
        }
        throw err;
      }
    },

    async listPaths(prefix = '') {
      const { list } = await import('@vercel/blob');
      const paths = [];
      let cursor;
      do {
        const result = await list({
          prefix: prefix || undefined,
          cursor,
        });
        if (result?.blobs) {
          for (const blob of result.blobs) {
            paths.push(blob.pathname);
          }
        }
        cursor = result?.hasMore ? result.cursor : null;
      } while (cursor);
      return paths.sort();
    },
  };
}

/**
 * Production storage adapter backed by the muse-shelf-r2 gateway
 * Worker (Cloudflare R2 bucket "muse-shelf"). This became the
 * production backend on 2026-11-06 after the Vercel Blob Hobby
 * advanced-operations cap (2,000/month, burned mainly by list()
 * polling) froze the Blob store. The gateway speaks a small
 * Bearer-authenticated HTTP protocol (PUT/GET/HEAD/DELETE per key,
 * GET /__list for enumeration, If-Match honoured as R2 onlyIf) and
 * returns R2 httpEtags, which this adapter passes through opaquely —
 * the same contract the Blob adapter exposes.
 *
 * Selected when SHELF_GATEWAY_TOKEN is set (see getStorageAdapter);
 * the gateway URL defaults to the production Worker and can be
 * overridden with SHELF_GATEWAY_URL. Removing the token env var
 * rolls back to the Vercel Blob adapter.
 */
const DEFAULT_GATEWAY_URL = 'https://muse-shelf-r2.yamahei21python.workers.dev';

export function createGatewayAdapter({ baseUrl, token, fetchImpl } = {}) {
  const base = (
    baseUrl ||
    process.env.SHELF_GATEWAY_URL ||
    DEFAULT_GATEWAY_URL
  ).replace(/\/$/, '');
  const tok = token || process.env.SHELF_GATEWAY_TOKEN;
  const doFetch = fetchImpl || fetch;

  function keyPath(path) {
    // The gateway decodes the whole pathname, so encode the key as a
    // single segment (keys contain "/" and "@").
    return '/' + encodeURIComponent(path);
  }

  async function call(method, path, { body, contentType, ifMatch } = {}) {
    const headers = { Authorization: `Bearer ${tok}` };
    if (contentType) headers['Content-Type'] = contentType;
    if (ifMatch !== undefined) headers['If-Match'] = ifMatch;
    return doFetch(base + path, { method, headers, body });
  }

  return {
    async putBuffer(path, buffer, contentType = 'application/octet-stream', opts = {}) {
      const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      const res = await call('PUT', keyPath(path), {
        body: buf,
        contentType,
        ifMatch: opts.ifMatch,
      });
      if (res.status === 412) {
        const err = new Error('Precondition Failed');
        err.name = 'PreconditionFailed';
        throw err;
      }
      if (res.status !== 200) {
        throw new Error(`gateway PUT ${path} failed: HTTP ${res.status}`);
      }
      return { path, contentType, size: buf.length, etag: res.headers.get('etag') };
    },

    async getBuffer(path) {
      const res = await call('GET', keyPath(path));
      if (res.status === 404) return null;
      if (res.status !== 200) {
        throw new Error(`gateway GET ${path} failed: HTTP ${res.status}`);
      }
      return Buffer.from(await res.arrayBuffer());
    },

    async getEntry(path) {
      const head = await call('HEAD', keyPath(path));
      if (head.status === 404) return null;
      if (head.status !== 200) {
        throw new Error(`gateway HEAD ${path} failed: HTTP ${head.status}`);
      }
      const etag = head.headers.get('etag');
      const buf = await this.getBuffer(path);
      if (!buf) return null;
      return { buffer: buf, etag };
    },

    async listPaths(prefix = '') {
      const paths = [];
      let cursor;
      do {
        const qs = new URLSearchParams();
        if (prefix) qs.set('prefix', prefix);
        if (cursor) qs.set('cursor', cursor);
        const res = await call('GET', '/__list?' + qs.toString());
        if (res.status !== 200) {
          throw new Error(`gateway LIST failed: HTTP ${res.status}`);
        }
        const page = await res.json();
        for (const obj of page.objects || []) {
          paths.push(obj.key);
        }
        cursor = page.truncated ? page.cursor : null;
      } while (cursor);
      return paths.sort();
    },
  };
}

/**
 * Set the current storage adapter (used by tests to inject memory adapter).
 */
export function setStorageAdapter(adapter) {
  currentAdapter = adapter;
}

/**
 * Reset storage adapter to default.
 */
export function resetStorageAdapter() {
  currentAdapter = null;
}

/**
 * Get the active storage adapter.
 */
export function getStorageAdapter() {
  if (!currentAdapter) {
    currentAdapter = process.env.SHELF_GATEWAY_TOKEN
      ? createGatewayAdapter()
      : createVercelBlobAdapter();
  }
  return currentAdapter;
}

/**
 * Put a buffer into the blob store at path.
 * @param {string} path
 * @param {Buffer | Uint8Array | string} buffer
 * @param {string} [contentType]
 * @param {object} [opts]
 */
export async function putBuffer(path, buffer, contentType = 'application/octet-stream', opts = {}) {
  return getStorageAdapter().putBuffer(path, buffer, contentType, opts);
}

/**
 * Get a buffer from the blob store at path. Returns null if missing.
 * @param {string} path
 * @returns {Promise<Buffer | null>}
 */
export async function getBuffer(path) {
  return getStorageAdapter().getBuffer(path);
}

/**
 * Get entry ({ buffer, etag }) from store. Returns null if missing.
 * @param {string} path
 * @returns {Promise<{ buffer: Buffer, etag: string } | null>}
 */
export async function getEntry(path) {
  const adapter = getStorageAdapter();
  if (typeof adapter.getEntry === 'function') {
    return adapter.getEntry(path);
  }
  const buf = await adapter.getBuffer(path);
  if (!buf) return null;
  return { buffer: buf, etag: 'legacy' };
}

/**
 * List all blob paths matching the given prefix.
 * @param {string} [prefix]
 * @returns {Promise<string[]>}
 */
export async function listPaths(prefix = '') {
  return getStorageAdapter().listPaths(prefix);
}
