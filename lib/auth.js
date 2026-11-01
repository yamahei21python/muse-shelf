/**
 * Authentication module for muse-shelf.
 * Supports:
 * 1. Long-lived recipient tokens from env SHELF_TOKENS_JSON
 * 2. Short-lived signed tokens (HMAC-SHA256 with SHELF_SIGNING_SECRET)
 * 3. Admin tokens via x-admin-token header matching SHELF_ADMIN_TOKEN
 * Timing-safe comparisons used; token values never logged.
 */

import crypto from 'node:crypto';

/**
 * Constant-time string equality check.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Mint a short-lived signed token.
 * Format: v1.<exp_unix>.<label_b64url>.<hmac_b64url>
 * @param {string} label
 * @param {number} ttlMinutes (1..1440)
 * @param {string} [secret]
 * @returns {{ token: string, expires_at: string }}
 */
export function mintToken(label, ttlMinutes, secret = process.env.SHELF_SIGNING_SECRET) {
  if (!secret) {
    throw new Error('Signing secret not configured');
  }
  const expUnix = Math.floor(Date.now() / 1000) + ttlMinutes * 60;
  const labelB64 = Buffer.from(label, 'utf8').toString('base64url');
  const payload = `v1.${expUnix}.${labelB64}`;
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');

  const token = `${payload}.${hmac}`;
  const expiresAt = new Date(expUnix * 1000).toISOString();
  return { token, expires_at: expiresAt };
}

/**
 * Verify a short-lived signed token.
 * @param {string} token
 * @param {string} [secret]
 * @returns {{ ok: boolean, label?: string, status?: number, error?: string }}
 */
export function verifySignedToken(token, secret = process.env.SHELF_SIGNING_SECRET) {
  if (!token || typeof token !== 'string') {
    return { ok: false, status: 401, error: 'Unauthorized: missing token' };
  }

  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    return { ok: false, status: 401, error: 'Invalid token format' };
  }

  const [, expStr, labelB64, hmacB64] = parts;
  const expUnix = parseInt(expStr, 10);
  if (Number.isNaN(expUnix) || String(expUnix) !== expStr) {
    return { ok: false, status: 401, error: 'Invalid token expiration' };
  }

  if (!secret) {
    return { ok: false, status: 401, error: 'Signing secret not configured' };
  }

  // Verify HMAC signature first
  const payload = `v1.${expStr}.${labelB64}`;
  const expectedHmac = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');

  if (!safeEqual(expectedHmac, hmacB64)) {
    return { ok: false, status: 401, error: 'Invalid token signature' };
  }

  // Verify expiry
  const nowUnix = Math.floor(Date.now() / 1000);
  if (nowUnix >= expUnix) {
    return { ok: false, status: 401, error: 'Token expired' };
  }

  let label;
  try {
    label = Buffer.from(labelB64, 'base64url').toString('utf8');
  } catch {
    return { ok: false, status: 401, error: 'Invalid token label' };
  }

  return { ok: true, label };
}

/**
 * Authenticate agent token (long-lived or signed).
 * @param {string} token
 * @returns {{ ok: boolean, kind?: 'long'|'signed', name?: string, label?: string, status?: number, error?: string }}
 */
export function authenticateAgent(token) {
  if (!token || typeof token !== 'string') {
    return { ok: false, status: 401, error: 'Unauthorized: missing token' };
  }

  // 1. Check long-lived tokens in SHELF_TOKENS_JSON
  const tokensJson = process.env.SHELF_TOKENS_JSON;
  if (tokensJson) {
    try {
      const parsed = JSON.parse(tokensJson);
      if (parsed && typeof parsed === 'object') {
        for (const [name, validToken] of Object.entries(parsed)) {
          if (typeof validToken === 'string' && safeEqual(token, validToken)) {
            return { ok: true, kind: 'long', name };
          }
        }
      }
    } catch {
      // ignore parse failure, proceed to check signed token
    }
  }

  // 2. Check signed token if formatted as v1.*
  if (token.startsWith('v1.')) {
    const verified = verifySignedToken(token);
    if (verified.ok) {
      return { ok: true, kind: 'signed', label: verified.label };
    }
    return { ok: false, status: verified.status || 401, error: verified.error || 'Invalid token' };
  }

  return { ok: false, status: 401, error: 'Invalid token' };
}

/**
 * Authenticate admin request using header `x-admin-token`.
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ ok: boolean, status?: number, error?: string }}
 */
export function authenticateAdmin(req) {
  const adminSecret = process.env.SHELF_ADMIN_TOKEN;
  if (!adminSecret) {
    return { ok: false, status: 401, error: 'Unauthorized: admin token not configured' };
  }

  const tokenHeader = req.headers['x-admin-token'];
  if (!tokenHeader || typeof tokenHeader !== 'string') {
    return { ok: false, status: 401, error: 'Unauthorized: missing x-admin-token' };
  }

  if (!safeEqual(tokenHeader, adminSecret)) {
    return { ok: false, status: 401, error: 'Unauthorized: invalid admin token' };
  }

  return { ok: true };
}
