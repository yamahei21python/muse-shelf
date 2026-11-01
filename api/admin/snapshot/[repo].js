import { authenticateAdmin } from '../../../lib/auth.js';
import { parseBody, sendJson, sendError, HttpError } from '../../../lib/http.js';
import { putBuffer } from '../../../lib/store.js';
import { isValidRepo, isValidSha, MAX_BODY_SIZE } from '../../../lib/validation.js';

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
  if (!isValidSha(sha.trim())) {
    return sendError(res, 400, 'Invalid x-sha header');
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

  // Item 9: Check gzip magic bytes 0x1f 0x8b
  if (bodyBuffer.length < 2 || bodyBuffer[0] !== 0x1f || bodyBuffer[1] !== 0x8b) {
    return sendError(res, 400, 'Body is not gzip');
  }

  try {
    // Versioned bytes + pointer meta. The bytes for a given SHA are
    // written under their own path first; the meta write is the
    // commit point. If the meta write fails, the previous meta still
    // points at the previous complete bytes (the new bytes are an
    // unreferenced orphan), so the manifest can never describe bytes
    // that belong to a different SHA. The pre-versioning canonical
    // path is no longer written; downloads fall back to it when a
    // meta has no `path` (snapshots published before this change).
    const shaTrimmed = sha.trim();
    const snapshotPath = `snapshots/${repo}@${shaTrimmed}.tar.gz`;
    await putBuffer(snapshotPath, bodyBuffer, 'application/gzip');

    const meta = {
      repo,
      sha: shaTrimmed,
      size_bytes: bodyBuffer.length,
      updated_at: new Date().toISOString(),
      path: snapshotPath,
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
