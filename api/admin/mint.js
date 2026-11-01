import { authenticateAdmin, mintToken } from '../../lib/auth.js';
import { parseJsonBody, sendJson, sendError, HttpError } from '../../lib/http.js';
import { sanitizeFrom } from '../../lib/validation.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendError(res, 405, 'Method not allowed');
  }

  const auth = authenticateAdmin(req);
  if (!auth.ok) {
    return sendError(res, auth.status || 401, auth.error || 'Unauthorized');
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    if (err instanceof HttpError) {
      return sendError(res, err.statusCode, err.message);
    }
    return sendError(res, 400, 'Invalid JSON body');
  }

  const { ttl_minutes, label } = body || {};

  if (!Number.isInteger(ttl_minutes) || ttl_minutes < 1 || ttl_minutes > 1440) {
    return sendError(res, 400, 'Invalid ttl_minutes (must be integer between 1 and 1440)');
  }

  if (typeof label !== 'string' || !label.trim()) {
    return sendError(res, 400, 'Invalid label');
  }

  // Item 8: Require sanitizeFrom(label) !== null
  if (sanitizeFrom(label.trim()) === null) {
    return sendError(res, 400, 'Invalid label for inbox posting');
  }

  if (!process.env.SHELF_SIGNING_SECRET) {
    return sendError(res, 500, 'Signing secret not configured');
  }

  try {
    const { token, expires_at } = mintToken(label.trim(), ttl_minutes);
    return sendJson(res, 200, { token, expires_at });
  } catch (err) {
    return sendError(res, 500, 'Internal server error');
  }
}
