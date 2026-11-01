import { authenticateAdmin } from '../../lib/auth.js';
import { sendJson, sendError } from '../../lib/http.js';
import { getBuffer } from '../../lib/store.js';

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
    const indexBuf = await getBuffer('inbox/index.json');
    let index = { seq: 0, entries: [] };
    if (indexBuf) {
      try {
        index = JSON.parse(indexBuf.toString('utf8'));
      } catch {
        index = { seq: 0, entries: [] };
      }
    }

    const currentSeq = Number.isInteger(index.seq) ? index.seq : 0;
    const allEntries = Array.isArray(index.entries) ? index.entries : [];
    const entries = filterSince !== null
      ? allEntries.filter((e) => Number.isInteger(e.seq) && e.seq > filterSince)
      : allEntries;

    return sendJson(res, 200, { seq: currentSeq, entries });
  } catch (err) {
    return sendError(res, 500, 'Internal server error');
  }
}
