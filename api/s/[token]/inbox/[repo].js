import { authenticateAgent } from '../../../../lib/auth.js';
import { parseBody, sendJson, sendError, HttpError } from '../../../../lib/http.js';
import { getBuffer, putBuffer } from '../../../../lib/store.js';
import { isValidRepo, sanitizeFrom, formatTimestamp, MAX_BODY_SIZE } from '../../../../lib/validation.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendError(res, 405, 'Method not allowed');
  }

  // Extract token and repo from query or URL
  let token = req.query?.token;
  let repo = req.query?.repo;

  if ((!token || !repo) && req.url) {
    const match = req.url.match(/\/api\/s\/([^/?#]+)\/inbox\/([^/?#]+)/);
    if (match) {
      if (!token) token = match[1];
      if (!repo) repo = match[2];
    }
  }

  const auth = authenticateAgent(token);
  if (!auth.ok) {
    return sendError(res, auth.status || 401, auth.error || 'Unauthorized');
  }

  if (!isValidRepo(repo)) {
    return sendError(res, 400, 'Invalid repo name');
  }

  const baseSha = req.headers['x-base-sha'];
  if (!baseSha || typeof baseSha !== 'string' || !baseSha.trim()) {
    return sendError(res, 400, 'Missing x-base-sha header');
  }

  const rawFrom = req.headers['x-from'] || auth.name || auth.label;
  const from = sanitizeFrom(rawFrom);
  if (!from) {
    return sendError(res, 400, 'Invalid from identifier');
  }

  let bodyBuffer;
  try {
    bodyBuffer = await parseBody(req, MAX_BODY_SIZE);
  } catch (err) {
    if (err instanceof HttpError) {
      return sendError(res, err.statusCode, err.message);
    }
    return sendError(res, 500, 'Internal server error reading body');
  }

  try {
    const timestamp = formatTimestamp();
    const blobPath = `inbox/${from}/${timestamp}-${repo}.tar.gz`;
    await putBuffer(blobPath, bodyBuffer, 'application/gzip');

    // Read and update index.json (known read-modify-write race)
    const indexBuf = await getBuffer('inbox/index.json');
    let index = { seq: 0, entries: [] };
    if (indexBuf) {
      try {
        index = JSON.parse(indexBuf.toString('utf8'));
      } catch {
        index = { seq: 0, entries: [] };
      }
    }

    if (!Array.isArray(index.entries)) {
      index.entries = [];
    }

    const nextSeq = (Number.isInteger(index.seq) ? index.seq : 0) + 1;
    const entry = {
      seq: nextSeq,
      from,
      repo,
      base_sha: baseSha.trim(),
      size_bytes: bodyBuffer.length,
      path: blobPath,
      received_at: new Date().toISOString(),
    };

    index.seq = nextSeq;
    index.entries.push(entry);

    await putBuffer(
      'inbox/index.json',
      Buffer.from(JSON.stringify(index, null, 2)),
      'application/json'
    );

    return sendJson(res, 201, { ok: true, seq: nextSeq });
  } catch (err) {
    return sendError(res, 500, 'Internal server error');
  }
}
