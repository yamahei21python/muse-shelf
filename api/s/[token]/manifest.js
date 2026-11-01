import { authenticateAgent } from '../../../lib/auth.js';
import { sendJson, sendError } from '../../../lib/http.js';
import { listPaths, getBuffer } from '../../../lib/store.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, 'Method not allowed');
  }

  // Extract token from query or URL
  let token = req.query?.token;
  if (!token && req.url) {
    const match = req.url.match(/\/api\/s\/([^/?#]+)\/manifest/);
    if (match) {
      token = match[1];
    }
  }

  const auth = authenticateAgent(token);
  if (!auth.ok) {
    return sendError(res, auth.status || 401, auth.error || 'Unauthorized');
  }

  try {
    const paths = await listPaths('meta/');
    const repos = [];

    for (const path of paths) {
      if (!path.endsWith('.json')) continue;
      const buf = await getBuffer(path);
      if (!buf) continue;
      try {
        const meta = JSON.parse(buf.toString('utf8'));
        if (meta && typeof meta === 'object') {
          repos.push(meta);
        }
      } catch {
        // Skip corrupt meta files
      }
    }

    repos.sort((a, b) => String(a.repo || '').localeCompare(String(b.repo || '')));

    return sendJson(res, 200, { repos });
  } catch (err) {
    return sendError(res, 500, 'Internal server error');
  }
}
