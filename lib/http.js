/**
 * HTTP helper utilities for request parsing and response formatting.
 * Compatible with Node standard http and Vercel serverless functions.
 */

import { MAX_BODY_SIZE } from './validation.js';

/**
 * Custom error with HTTP status code.
 */
export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Reads the request body as a Buffer, enforcing a size limit.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit=MAX_BODY_SIZE]
 * @returns {Promise<Buffer>}
 */
export async function parseBody(req, limit = MAX_BODY_SIZE) {
  // If body is already parsed by Vercel / middleware
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length > limit) {
      throw new HttpError(413, 'Payload too large');
    }
    return req.body;
  }

  if (typeof req.body === 'string') {
    const buf = Buffer.from(req.body, 'utf8');
    if (buf.length > limit) {
      throw new HttpError(413, 'Payload too large');
    }
    return buf;
  }

  // Pre-check Content-Length header if available
  const contentLength = req.headers['content-length'];
  if (contentLength) {
    const parsedLength = parseInt(contentLength, 10);
    if (!Number.isNaN(parsedLength) && parsedLength > limit) {
      throw new HttpError(413, 'Payload too large');
    }
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;
    let overflow = false;

    function onData(chunk) {
      totalSize += chunk.length;
      if (totalSize > limit) {
        // Item 5: mark overflow and keep draining (discarding) until
        // the client finishes. Rejecting and responding mid-upload
        // makes Node destroy the socket, and the client then never
        // receives the 413 (verified by the raw-socket regression
        // test: response bytes lost to a reset). Draining first keeps
        // the socket intact so the error is actually delivered. The
        // exposure is time only (memory stays flat); the hosting
        // platform's own body-size limit and timeouts are the
        // backstop for a client that never stops sending.
        overflow = true;
        chunks.length = 0;
        return;
      }
      if (!overflow) {
        chunks.push(chunk);
      }
    }

    function onEnd() {
      cleanup();
      if (overflow) {
        reject(new HttpError(413, 'Payload too large'));
        return;
      }
      resolve(Buffer.concat(chunks));
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    function cleanup() {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * Parses JSON body from request.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
export async function parseJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  const raw = await parseBody(req, 1024 * 1024); // max 1MB for JSON bodies
  const text = raw.toString('utf8').trim();
  if (!text) {
    throw new HttpError(400, 'Empty JSON body');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

/**
 * Sends a JSON response with Cache-Control headers (Item 10).
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {any} data
 */
export function sendJson(res, statusCode, data) {
  const jsonStr = JSON.stringify(data);
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    if (!res.getHeader?.('Cache-Control')) {
      res.setHeader('Cache-Control', 'private, no-store');
    }
    return res.status(statusCode).json(data);
  }

  const existingCacheControl = res.getHeader ? res.getHeader('Cache-Control') : null;
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(jsonStr),
  };
  if (!existingCacheControl) {
    headers['Cache-Control'] = 'private, no-store';
  }

  res.writeHead(statusCode, headers);
  res.end(jsonStr);
}

/**
 * Sends a raw binary buffer response with Cache-Control headers (Item 10).
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {Buffer} buffer
 * @param {Record<string, string>} [headers]
 */
export function sendBuffer(res, statusCode, buffer, headers = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const existingCacheControl = headers['cache-control'] || headers['Cache-Control'] || (typeof res.getHeader === 'function' && res.getHeader('Cache-Control'));

  const finalHeaders = {
    ...headers,
    'Content-Length': buf.length,
  };
  if (!existingCacheControl) {
    finalHeaders['Cache-Control'] = 'private, no-store';
  }

  if (typeof res.status === 'function' && typeof res.setHeader === 'function' && typeof res.send === 'function') {
    for (const [k, v] of Object.entries(finalHeaders)) {
      res.setHeader(k, v);
    }
    return res.status(statusCode).send(buf);
  }

  res.writeHead(statusCode, finalHeaders);
  res.end(buf);
}

/**
 * Sends a JSON error response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {string} message
 */
export function sendError(res, statusCode, message) {
  return sendJson(res, statusCode, { error: message });
}
