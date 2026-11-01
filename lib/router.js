/**
 * Router / Dispatcher module.
 * Routes incoming HTTP requests to corresponding API handlers,
 * populating `req.query` to mirror Vercel's serverless function behavior.
 */

import { sendError, HttpError } from './http.js';
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
    let parsedUrl;
    try {
      parsedUrl = new URL(req.url, `http://${host}`);
    } catch {
      throw new HttpError(400, 'Malformed URL');
    }

    const pathname = parsedUrl.pathname;

    // Initialize query dictionary from searchParams. URLSearchParams
    // values are ALREADY percent-decoded by the URL parser; decoding
    // them again would corrupt legitimate values (a literal "%20" in
    // a value, sent as %2520, would collapse to a space) and reject
    // valid ones ("%25nothex" -> "%nothex" -> URIError). Path
    // segments, by contrast, arrive still encoded and are decoded
    // exactly once via safeDecode below.
    const query = {};
    for (const [key, val] of parsedUrl.searchParams.entries()) {
      query[key] = val;
    }
    req.query = query;

    function safeDecode(str) {
      try {
        return decodeURIComponent(str);
      } catch {
        throw new HttpError(400, 'Malformed percent-encoding');
      }
    }

    // 1. Health: GET /api/health
    if (/^\/api\/health\/?$/.test(pathname)) {
      return await healthHandler(req, res);
    }

    // 2. Manifest: GET /api/s/<token>/manifest
    const manifestMatch = pathname.match(/^\/api\/s\/([^/]+)\/manifest\/?$/);
    if (manifestMatch) {
      req.query.token = safeDecode(manifestMatch[1]);
      return await manifestHandler(req, res);
    }

    // 3. Download: GET /api/s/<token>/dl/<repo>
    const dlMatch = pathname.match(/^\/api\/s\/([^/]+)\/dl\/([^/]+)\/?$/);
    if (dlMatch) {
      req.query.token = safeDecode(dlMatch[1]);
      req.query.repo = safeDecode(dlMatch[2]);
      return await dlHandler(req, res);
    }

    // 4. Inbox post: POST /api/s/<token>/inbox/<repo>
    const inboxPostMatch = pathname.match(/^\/api\/s\/([^/]+)\/inbox\/([^/]+)\/?$/);
    if (inboxPostMatch) {
      req.query.token = safeDecode(inboxPostMatch[1]);
      req.query.repo = safeDecode(inboxPostMatch[2]);
      return await inboxPostHandler(req, res);
    }

    // 5. Admin Snapshot: PUT /api/admin/snapshot/<repo>
    const snapshotMatch = pathname.match(/^\/api\/admin\/snapshot\/([^/]+)\/?$/);
    if (snapshotMatch) {
      req.query.repo = safeDecode(snapshotMatch[1]);
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
    // Item 7: Preserve HttpError status code and message
    if (err instanceof HttpError) {
      return sendError(res, err.statusCode, err.message);
    }
    return sendError(res, 500, 'Internal server error');
  }
}
