/**
 * Inbox listing.
 *
 * Current writes are one sidecar JSON per return
 * (`inbox/<from>/<file>.tar.gz.json`) next to the payload blob, so a
 * submission touches no shared mutable state and concurrent returns
 * cannot overwrite each other. (The earlier design kept a single
 * `inbox/index.json` updated by read-modify-write; optimistic
 * concurrency on it proved unreliable against the real Blob store —
 * the etag and the body come from different reads and can skew, and
 * the download-path etag does not satisfy put preconditions.)
 *
 * Entry identity and ordering:
 * - Every entry carries a stable `id`: its payload blob path. The
 *   path is unique per submission and never changes.
 * - `seq` is only a display ordinal within one listing response. It
 *   is NOT a durable cursor: a sidecar that becomes visible late
 *   (store propagation delay, clock skew) can sort before entries
 *   that were already listed, renumbering them. Consumers that poll
 *   for new returns MUST diff by `id` against their own seen set
 *   (the notification hook does exactly this). `?since=` filtering
 *   is kept for convenience only and can miss such late insertions.
 *
 * Legacy entries recorded in `inbox/index.json` are listed first,
 * with their stored seq values; sidecar entries follow, ordered by
 * received_at, with seq continuing after the legacy count.
 */

import { getBuffer, listPaths } from './store.js';

async function readLegacyEntries() {
  try {
    const buf = await getBuffer('inbox/index.json');
    if (buf) {
      const idx = JSON.parse(buf.toString('utf8'));
      if (Array.isArray(idx.entries)) {
        return idx.entries;
      }
    }
  } catch {
    // Legacy index unreadable: no legacy entries.
  }
  return [];
}

async function listSidecarPaths() {
  return (await listPaths('inbox/'))
    .filter((p) => p.endsWith('.tar.gz.json'))
    .sort();
}

export async function listInboxEntries() {
  const legacy = await readLegacyEntries();
  const entries = legacy.map((e) => ({ ...e, id: e.path }));
  const legacyCount = entries.length;

  const sidecars = [];
  for (const p of await listSidecarPaths()) {
    try {
      const buf = await getBuffer(p);
      if (buf) {
        sidecars.push(JSON.parse(buf.toString('utf8')));
      }
    } catch {
      // Skip an unreadable sidecar rather than failing the listing.
    }
  }
  sidecars.sort(
    (a, b) =>
      String(a.received_at || '').localeCompare(String(b.received_at || '')) ||
      String(a.path || '').localeCompare(String(b.path || ''))
  );
  sidecars.forEach((e, i) => {
    entries.push({ ...e, id: e.path, seq: legacyCount + i + 1 });
  });

  return entries;
}

/**
 * Count entries without fetching sidecar bodies: one list call plus
 * at most one read of the legacy index. Used by the submission
 * handler for its advisory response seq, so posting stays O(1) reads
 * regardless of inbox size.
 */
export async function countInboxEntries() {
  const [legacy, paths] = await Promise.all([
    readLegacyEntries(),
    listSidecarPaths(),
  ]);
  return legacy.length + paths.length;
}
