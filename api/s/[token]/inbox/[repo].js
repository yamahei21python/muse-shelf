import { authenticateAgent } from '../../../../lib/auth.js';
import { parseBody, sendJson, sendError, HttpError } from '../../../../lib/http.js';
import { putBuffer } from '../../../../lib/store.js';
import { listInboxEntries } from '../../../../lib/inbox.js';
import { isValidRepo, sanitizeFrom, inboxBlobPath, isValidSha, MAX_BODY_SIZE } from '../../../../lib/validation.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendError(res, 405, 'Method not allowed');
  }

  // Extract token and repo from query or URL
  let token = req.query?.token;
  let repo = req.query?.repo;

  if ((!token || !repo) && req.url) {
    const match = req.url.match(/\/api\/s\/([^/?#]+)\/inbox\/([^/?#]+)/);
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

  const baseSha = req.headers['x-base-sha'];
  if (!baseSha || typeof baseSha !== 'string' || !baseSha.trim()) {
    return sendError(res, 400, 'Missing x-base-sha header');
  }
  if (!isValidSha(baseSha.trim())) {
    return sendError(res, 400, 'Invalid x-base-sha header');
  }

  // Item 4: Pin identity to the token (auth.name for long-lived, auth.label for signed).
  // The SANITISED form is what gets stored and used in blob paths: a raw
  // label like "Worker One/x" would otherwise produce a multi-segment
  // path that the strict inbox-file guard (item 3) can never return.
  const from = sanitizeFrom(auth.name || auth.label || '');
  if (!from) {
    return sendError(res, 400, 'Invalid from identifier');
  }

  const rawFrom = req.headers['x-from'];
  let fromClaimed;
  if (rawFrom && typeof rawFrom === 'string' && rawFrom.trim()) {
    const sanitizedClaimed = sanitizeFrom(rawFrom);
    if (sanitizedClaimed && sanitizedClaimed !== from) {
      fromClaimed = sanitizedClaimed;
    }
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

  const blobPath = inboxBlobPath(from, repo);

  try {
    await putBuffer(blobPath, bodyBuffer, 'application/gzip');

    // Item 2 (final design): the entry is a sidecar JSON written next
    // to the payload. No shared mutable state is touched, so
    // concurrent submissions cannot lose each other. (The previous
    // read-modify-write of inbox/index.json, even with etag/ifMatch
    // optimistic concurrency, lost entries in production: the etag
    // and the body come from separate reads against an eventually
    // consistent store and can belong to different versions.)
    const meta = {
      from,
      repo,
      base_sha: baseSha.trim(),
      size_bytes: bodyBuffer.length,
      path: blobPath,
      received_at: new Date().toISOString(),
    };
    if (fromClaimed) {
      meta.from_claimed = fromClaimed;
    }
    await putBuffer(
      `${blobPath}.json`,
      Buffer.from(JSON.stringify(meta, null, 2)),
      'application/json'
    );

    // seq is assigned at read time (see lib/inbox.js); the value in
    // this response is the entry's position as of just after this
    // write, on a best-effort basis.
    let seq = 0;
    try {
      seq = (await listInboxEntries()).length;
    } catch {
      seq = 0;
    }

    return sendJson(res, 201, { ok: true, seq });
  } catch (err) {
    if (err instanceof HttpError) {
      return sendError(res, err.statusCode, err.message);
    }
    return sendError(res, 500, 'Internal server error');
  }
}
