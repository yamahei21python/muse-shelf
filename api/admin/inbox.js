import { authenticateAdmin } from '../../lib/auth.js';
import { sendJson, sendError } from '../../lib/http.js';
import { listInboxEntries } from '../../lib/inbox.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, 'Method not allowed');
  }

  const auth = authenticateAdmin(req);
  if (!auth.ok) {
    return sendError(res, auth.status || 401, auth.error || 'Unauthorized');
  }

  let sinceParam = req.query?.since;
  if (sinceParam === undefined && req.url) {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      if (parsed.searchParams.has('since')) {
        sinceParam = parsed.searchParams.get('since');
      }
    } catch {}
  }

  let filterSince = null;
  if (sinceParam !== undefined && sinceParam !== null) {
    const parsed = Number(sinceParam);
    if (!Number.isInteger(parsed)) {
      return sendError(res, 400, 'Invalid since parameter');
    }
    filterSince = parsed;
  }

  try {
    const allEntries = await listInboxEntries();
    const currentSeq = allEntries.length ? allEntries[allEntries.length - 1].seq : 0;
    const entries = filterSince !== null
      ? allEntries.filter((e) => Number.isInteger(e.seq) && e.seq > filterSince)
      : allEntries;

    return sendJson(res, 200, { seq: currentSeq, entries });
  } catch (err) {
    return sendError(res, 500, 'Internal server error');
  }
}
