/**
 * Storage adapter module for muse-shelf.
 * Default production implementation uses @vercel/blob with access: 'private'.
 * Allows injecting an in-memory adapter for network-free testing.
 */

let currentAdapter = null;

/**
 * Creates an in-memory storage adapter for unit testing.
 * @param {Record<string, Buffer | string | { buffer: Buffer, contentType?: string }>} [initialData]
 */
export function createMemoryAdapter(initialData = {}) {
  const store = new Map();

  for (const [key, value] of Object.entries(initialData)) {
    if (Buffer.isBuffer(value)) {
      store.set(key, { buffer: value, contentType: 'application/octet-stream' });
    } else if (typeof value === 'string') {
      store.set(key, { buffer: Buffer.from(value, 'utf8'), contentType: 'text/plain' });
    } else if (value && typeof value === 'object' && value.buffer) {
      store.set(key, {
        buffer: Buffer.isBuffer(value.buffer) ? value.buffer : Buffer.from(value.buffer),
        contentType: value.contentType || 'application/octet-stream',
      });
    }
  }

  return {
    async putBuffer(path, buffer, contentType = 'application/octet-stream') {
      const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      store.set(path, { buffer: buf, contentType });
      return { path, contentType, size: buf.length };
    },

    async getBuffer(path) {
      const item = store.get(path);
      if (!item) return null;
      return Buffer.from(item.buffer);
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
    async putBuffer(path, buffer, contentType = 'application/octet-stream') {
      const { put } = await import('@vercel/blob');
      const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      await put(path, buf, {
        access: 'private',
        contentType,
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      return { path, contentType, size: buf.length };
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
    currentAdapter = createVercelBlobAdapter();
  }
  return currentAdapter;
}

/**
 * Put a buffer into the blob store at path.
 * @param {string} path
 * @param {Buffer | Uint8Array | string} buffer
 * @param {string} [contentType]
 */
export async function putBuffer(path, buffer, contentType = 'application/octet-stream') {
  return getStorageAdapter().putBuffer(path, buffer, contentType);
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
 * List all blob paths matching the given prefix.
 * @param {string} [prefix]
 * @returns {Promise<string[]>}
 */
export async function listPaths(prefix = '') {
  return getStorageAdapter().listPaths(prefix);
}
