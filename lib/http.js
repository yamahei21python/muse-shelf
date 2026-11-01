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

    function onData(chunk) {
      totalSize += chunk.length;
      if (totalSize > limit) {
        cleanup();
        req.destroy();
        reject(new HttpError(413, 'Payload too large'));
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      cleanup();
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
 * Sends a JSON response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {any} data
 */
export function sendJson(res, statusCode, data) {
  const jsonStr = JSON.stringify(data);
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    return res.status(statusCode).json(data);
  }

  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(jsonStr),
  });
  res.end(jsonStr);
}

/**
 * Sends a raw binary buffer response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {Buffer} buffer
 * @param {Record<string, string>} [headers]
 */
export function sendBuffer(res, statusCode, buffer, headers = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (typeof res.status === 'function' && typeof res.setHeader === 'function' && typeof res.send === 'function') {
    for (const [k, v] of Object.entries(headers)) {
      res.setHeader(k, v);
    }
    return res.status(statusCode).send(buf);
  }

  res.writeHead(statusCode, {
    ...headers,
    'Content-Length': buf.length,
  });
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
