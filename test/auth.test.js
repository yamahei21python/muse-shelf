import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupTestServer, TEST_RECIPIENT_TOKENS, TEST_SIGNING_SECRET, TEST_ADMIN_TOKEN } from './helpers.js';
import { mintToken, verifySignedToken, authenticateAgent, authenticateAdmin } from '../lib/auth.js';

test('Auth: long-lived recipient token accept and reject', async () => {
  const env = await setupTestServer();
  try {
    // Valid long token macmuse
    const resMac = await fetch(`${env.baseUrl}/api/s/${TEST_RECIPIENT_TOKENS.macmuse}/manifest`);
    assert.strictEqual(resMac.status, 200);

    // Valid long token xmuse
    const resX = await fetch(`${env.baseUrl}/api/s/${TEST_RECIPIENT_TOKENS.xmuse}/manifest`);
    assert.strictEqual(resX.status, 200);

    // Invalid long token
    const resBad = await fetch(`${env.baseUrl}/api/s/invalid-token-12345/manifest`);
    assert.strictEqual(resBad.status, 401);
    const badData = await resBad.json();
    assert.strictEqual(badData.error, 'Invalid token');
  } finally {
    await env.close();
  }
});

test('Auth: signed token accept, expired reject, and tampered signature reject', async () => {
  const env = await setupTestServer();
  try {
    // 1. Valid signed token
    const valid = mintToken('ci-agent', 60, TEST_SIGNING_SECRET);
    const resValid = await fetch(`${env.baseUrl}/api/s/${valid.token}/manifest`);
    assert.strictEqual(resValid.status, 200);

    // 2. Expired signed token (ttl = -10 minutes, simulated manually)
    const pastExp = Math.floor(Date.now() / 1000) - 600;
    const labelB64 = Buffer.from('ci-agent').toString('base64url');
    const expiredPayload = `v1.${pastExp}.${labelB64}`;
    const expiredHmac = crypto
      .createHmac('sha256', TEST_SIGNING_SECRET)
      .update(expiredPayload)
      .digest('base64url');
    const expiredToken = `${expiredPayload}.${expiredHmac}`;

    const resExpired = await fetch(`${env.baseUrl}/api/s/${expiredToken}/manifest`);
    assert.strictEqual(resExpired.status, 401);
    const expiredData = await resExpired.json();
    assert.strictEqual(expiredData.error, 'Token expired');

    // 3. Tampered signature
    const parts = valid.token.split('.');
    const tamperedSig = parts[3].slice(0, -2) + (parts[3].endsWith('a') ? 'b' : 'a');
    const tamperedToken = `${parts[0]}.${parts[1]}.${parts[2]}.${tamperedSig}`;

    const resTampered = await fetch(`${env.baseUrl}/api/s/${tamperedToken}/manifest`);
    assert.strictEqual(resTampered.status, 401);
    const tamperedData = await resTampered.json();
    assert.strictEqual(tamperedData.error, 'Invalid token signature');

    // 4. Malformed v1 token (bad exp)
    const malformedToken = `v1.notanumber.${labelB64}.${parts[3]}`;
    const resMalformed = await fetch(`${env.baseUrl}/api/s/${malformedToken}/manifest`);
    assert.strictEqual(resMalformed.status, 401);
  } finally {
    await env.close();
  }
});

test('Auth: admin auth accept and reject', async () => {
  const env = await setupTestServer();
  try {
    // Accept valid header
    const resValid = await fetch(`${env.baseUrl}/api/admin/inbox`, {
      headers: { 'x-admin-token': TEST_ADMIN_TOKEN },
    });
    assert.strictEqual(resValid.status, 200);

    // Reject missing header
    const resMissing = await fetch(`${env.baseUrl}/api/admin/inbox`);
    assert.strictEqual(resMissing.status, 401);
    const missingData = await resMissing.json();
    assert.strictEqual(missingData.error, 'Unauthorized: missing x-admin-token');

    // Reject invalid header
    const resInvalid = await fetch(`${env.baseUrl}/api/admin/inbox`, {
      headers: { 'x-admin-token': 'wrong-admin-token' },
    });
    assert.strictEqual(resInvalid.status, 401);
    const invalidData = await resInvalid.json();
    assert.strictEqual(invalidData.error, 'Unauthorized: invalid admin token');
  } finally {
    await env.close();
  }
});
