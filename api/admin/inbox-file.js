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

  if (!filePath || typeof filePath !== 'string') {
    return sendError(res, 400, 'Invalid path');
  }

  // Item 3: Strict traversal guard and shape check: inbox/<seg>/<file>.tar.gz (exactly 3 segments)
  // Reject backslashes, NUL, any segment that is exactly '.' or '..'
  if (filePath.includes('\\') || filePath.includes('\0')) {
    return sendError(res, 400, 'Invalid path');
  }

  const parts = filePath.split('/');
  if (parts.length !== 3 || parts[0] !== 'inbox') {
    return sendError(res, 400, 'Invalid path');
  }

  for (const seg of parts) {
    if (seg === '.' || seg === '..') {
      return sendError(res, 400, 'Invalid path');
    }
  }

  if (!parts[2].endsWith('.tar.gz')) {
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
