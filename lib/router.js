/**
 * Router / Dispatcher module.
 * Routes incoming HTTP requests to corresponding API handlers,
 * populating `req.query` to mirror Vercel's serverless function behavior.
 */

import { sendError } from './http.js';
import healthHandler from '../api/health.js';
import manifestHandler from '../api/s/[token]/manifest.js';
import dlHandler from '../api/s/[token]/dl/[repo].js';
import inboxPostHandler from '../api/s/[token]/inbox/[repo].js';
import snapshotHandler from '../api/admin/snapshot/[repo].js';
import inboxListHandler from '../api/admin/inbox.js';
import inboxFileHandler from '../api/admin/inbox-file.js';
import mintHandler from '../api/admin/mint.js';

export async function handleRequest(req, res) {
  try {
    const host = req.headers.host || 'localhost';
    const parsedUrl = new URL(req.url, `http://${host}`);
    const pathname = parsedUrl.pathname;

    // Initialize query dictionary from searchParams
    const query = {};
    for (const [key, value] of parsedUrl.searchParams.entries()) {
      query[key] = value;
    }
    req.query = query;

    // 1. Health: GET /api/health
    if (/^\/api\/health\/?$/.test(pathname)) {
      return await healthHandler(req, res);
    }

    // 2. Manifest: GET /api/s/<token>/manifest
    const manifestMatch = pathname.match(/^\/api\/s\/([^/]+)\/manifest\/?$/);
    if (manifestMatch) {
      req.query.token = decodeURIComponent(manifestMatch[1]);
      return await manifestHandler(req, res);
    }

    // 3. Download: GET /api/s/<token>/dl/<repo>
    const dlMatch = pathname.match(/^\/api\/s\/([^/]+)\/dl\/([^/]+)\/?$/);
    if (dlMatch) {
      req.query.token = decodeURIComponent(dlMatch[1]);
      req.query.repo = decodeURIComponent(dlMatch[2]);
      return await dlHandler(req, res);
    }

    // 4. Inbox post: POST /api/s/<token>/inbox/<repo>
    const inboxPostMatch = pathname.match(/^\/api\/s\/([^/]+)\/inbox\/([^/]+)\/?$/);
    if (inboxPostMatch) {
      req.query.token = decodeURIComponent(inboxPostMatch[1]);
      req.query.repo = decodeURIComponent(inboxPostMatch[2]);
      return await inboxPostHandler(req, res);
    }

    // 5. Admin Snapshot: PUT /api/admin/snapshot/<repo>
    const snapshotMatch = pathname.match(/^\/api\/admin\/snapshot\/([^/]+)\/?$/);
    if (snapshotMatch) {
      req.query.repo = decodeURIComponent(snapshotMatch[1]);
      return await snapshotHandler(req, res);
    }

    // 6. Admin Inbox list: GET /api/admin/inbox
    if (/^\/api\/admin\/inbox\/?$/.test(pathname)) {
      return await inboxListHandler(req, res);
    }

    // 7. Admin Inbox file: GET /api/admin/inbox-file
    if (/^\/api\/admin\/inbox-file\/?$/.test(pathname)) {
      return await inboxFileHandler(req, res);
    }

    // 8. Admin Mint: POST /api/admin/mint
    if (/^\/api\/admin\/mint\/?$/.test(pathname)) {
      return await mintHandler(req, res);
    }

    return sendError(res, 404, 'Not found');
  } catch (err) {
    return sendError(res, 500, 'Internal server error');
  }
}
