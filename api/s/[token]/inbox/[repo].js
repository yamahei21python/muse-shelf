import { authenticateAgent } from '../../../../lib/auth.js';
import { parseBody, sendJson, sendError, HttpError } from '../../../../lib/http.js';
import { getEntry, putBuffer } from '../../../../lib/store.js';
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

  // Item 4: Pin identity to the token (auth.name for long-lived, auth.label for signed)
  const from = auth.name || auth.label;
  if (!from || !sanitizeFrom(from)) {
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

    // Item 2: Read-modify-write race with optimistic concurrency control (ifMatch / retry up to 3 times)
    let retries = 3;
    let nextSeq = 1;

    while (retries > 0) {
      const entryResult = await getEntry('inbox/index.json');
      let index = { seq: 0, entries: [] };
      let currentEtag = undefined;

      if (entryResult) {
        currentEtag = entryResult.etag;
        try {
          index = JSON.parse(entryResult.buffer.toString('utf8'));
        } catch {
          index = { seq: 0, entries: [] };
        }
      }

      if (!Array.isArray(index.entries)) {
        index.entries = [];
      }

      nextSeq = (Number.isInteger(index.seq) ? index.seq : 0) + 1;
      const entry = {
        seq: nextSeq,
        from,
        repo,
        base_sha: baseSha.trim(),
        size_bytes: bodyBuffer.length,
        path: blobPath,
        received_at: new Date().toISOString(),
      };
      if (fromClaimed) {
        entry.from_claimed = fromClaimed;
      }

      index.seq = nextSeq;
      index.entries.push(entry);

      try {
        await putBuffer(
          'inbox/index.json',
          Buffer.from(JSON.stringify(index, null, 2)),
          'application/json',
          { ifMatch: currentEtag }
        );
        break; // Success!
      } catch (err) {
        if (err?.name === 'PreconditionFailed' || err?.name === 'BlobPreconditionFailedError') {
          retries--;
          if (retries === 0) {
            return sendError(res, 500, 'Precondition failed after retries');
          }
          continue;
        }
        throw err;
      }
    }

    return sendJson(res, 201, { ok: true, seq: nextSeq });
  } catch (err) {
    if (err instanceof HttpError) {
      return sendError(res, err.statusCode, err.message);
    }
    return sendError(res, 500, 'Internal server error');
  }
}
