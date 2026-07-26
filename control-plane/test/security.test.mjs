import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTotp, hashPassword, isValidTotpSecret, parseCookies, verifyPassword, verifyTotp } from '../src/security.mjs';

test('new password hashes verify and reject wrong passwords', async () => {
  const password = 'this-is-a-long-test-password';
  const hash = await hashPassword(password);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword(`${password}!`, hash), false);
});

test('password verifier rejects hostile scrypt parameters', async () => {
  const hostile = 'scrypt$2$1073741824$8$1$YWJj$YWJj';
  assert.equal(await verifyPassword('anything', hostile), false);
});

test('TOTP supports a standard Base32 secret and time window', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const now = 1_700_000_000_000;
  const code = generateTotp(secret, { now });
  assert.equal(isValidTotpSecret(secret), true);
  assert.equal(verifyTotp(code, secret, { now }), true);
  assert.equal(verifyTotp('000000', secret, { now }), code === '000000');
  assert.equal(verifyTotp(code, secret, { now: now + 120_000 }), false);
});

test('malformed cookie encoding does not crash', () => {
  assert.deepEqual(parseCookies('ok=1; bad=%E0%A4%A'), { ok: '1', bad: '' });
});
