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
 * Legacy entries recorded in `inbox/index.json` are still listed
 * first, with their stored seq values; sidecar entries follow,
 * ordered by received_at, with seq continuing after the legacy
 * count. Seqs are assigned at read time and are stable as long as
 * nothing is deleted.
 */

import { getBuffer, listPaths } from './store.js';

export async function listInboxEntries() {
  const entries = [];

  try {
    const buf = await getBuffer('inbox/index.json');
    if (buf) {
      const idx = JSON.parse(buf.toString('utf8'));
      if (Array.isArray(idx.entries)) {
        entries.push(...idx.entries);
      }
    }
  } catch {
    // Legacy index unreadable: list sidecars only.
  }
  const legacyCount = entries.length;

  const paths = (await listPaths('inbox/'))
    .filter((p) => p.endsWith('.tar.gz.json'))
    .sort();

  const sidecars = [];
  for (const p of paths) {
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
    entries.push({ ...e, seq: legacyCount + i + 1 });
  });

  return entries;
}
