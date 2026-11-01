import { authenticateAdmin } from '../../../lib/auth.js';
import { parseBody, sendJson, sendError, HttpError } from '../../../lib/http.js';
import { putBuffer } from '../../../lib/store.js';
import { isValidRepo, MAX_BODY_SIZE } from '../../../lib/validation.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'PUT') {
    return sendError(res, 405, 'Method not allowed');
  }

  const auth = authenticateAdmin(req);
  if (!auth.ok) {
    return sendError(res, auth.status || 401, auth.error || 'Unauthorized');
  }

  let repo = req.query?.repo;
  if (!repo && req.url) {
    const match = req.url.match(/\/api\/admin\/snapshot\/([^/?#]+)/);
    if (match) {
      repo = match[1];
    }
  }

  if (!isValidRepo(repo)) {
    return sendError(res, 400, 'Invalid repo name');
  }

  const sha = req.headers['x-sha'];
  if (!sha || typeof sha !== 'string' || !sha.trim()) {
    return sendError(res, 400, 'Missing x-sha header');
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
    // 1. Store snapshot bytes
    const snapshotPath = `snapshots/${repo}.tar.gz`;
    await putBuffer(snapshotPath, bodyBuffer, 'application/gzip');

    // 2. Store meta
    const meta = {
      repo,
      sha: sha.trim(),
      size_bytes: bodyBuffer.length,
      updated_at: new Date().toISOString(),
    };
    const metaPath = `meta/${repo}.json`;
    await putBuffer(
      metaPath,
      Buffer.from(JSON.stringify(meta, null, 2)),
      'application/json'
    );

    return sendJson(res, 200, {
      ok: true,
      repo,
      sha: sha.trim(),
      size_bytes: bodyBuffer.length,
    });
  } catch (err) {
    return sendError(res, 500, 'Internal server error');
  }
}
