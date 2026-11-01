import { sendJson, sendError } from '../lib/http.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, 'Method not allowed');
  }
  return sendJson(res, 200, { ok: true });
}
