import { authenticateAgent } from '../../../../lib/auth.js';
import { sendBuffer, sendError } from '../../../../lib/http.js';
import { getBuffer } from '../../../../lib/store.js';
import { isValidRepo } from '../../../../lib/validation.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, 'Method not allowed');
  }

  // Extract token and repo from query or URL
  let token = req.query?.token;
  let repo = req.query?.repo;

  if ((!token || !repo) && req.url) {
    const match = req.url.match(/\/api\/s\/([^/?#]+)\/dl\/([^/?#]+)/);
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

  try {
    const blobPath = `snapshots/${repo}.tar.gz`;
    const snapshotBuffer = await getBuffer(blobPath);
    if (!snapshotBuffer) {
      return sendError(res, 404, 'Repository snapshot not found');
    }

    return sendBuffer(res, 200, snapshotBuffer, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${repo}.tar.gz"`,
    });
  } catch (err) {
    return sendError(res, 500, 'Internal server error');
  }
}
