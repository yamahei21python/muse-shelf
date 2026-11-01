import { authenticateAdmin } from '../../lib/auth.js';
import { sendBuffer, sendError } from '../../lib/http.js';
import { getBuffer } from '../../lib/store.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, 'Method not allowed');
  }

  const auth = authenticateAdmin(req);
  if (!auth.ok) {
    return sendError(res, auth.status || 401, auth.error || 'Unauthorized');
  }

  let filePath = req.query?.path;
  if (!filePath && req.url) {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      filePath = parsed.searchParams.get('path');
    } catch {}
  }

  if (!filePath || typeof filePath !== 'string' || !filePath.startsWith('inbox/')) {
    return sendError(res, 400, 'Invalid path');
  }

  // Prevent path traversal
  if (filePath.includes('..') || filePath.includes('\\')) {
    return sendError(res, 400, 'Invalid path');
  }

  try {
    const buffer = await getBuffer(filePath);
    if (!buffer) {
      return sendError(res, 404, 'File not found');
    }

    const contentType = filePath.endsWith('.tar.gz')
      ? 'application/gzip'
      : 'application/octet-stream';

    return sendBuffer(res, 200, buffer, {
      'Content-Type': contentType,
    });
  } catch (err) {
    return sendError(res, 500, 'Internal server error');
  }
}
