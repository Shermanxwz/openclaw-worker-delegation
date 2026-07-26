import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, validateConfig } from '../src/config.mjs';

test('production rejects insecure and non-loopback settings', () => {
  const config = loadConfig({
    NODE_ENV: 'production', HOST: '0.0.0.0', COOKIE_SECURE: 'false',
    DEV_INSECURE: 'true', CONTROL_PASSWORD_HASH: 'x', AGENT_INGEST_TOKEN: 'short',
  });
  const { errors } = validateConfig(config);
  assert.ok(errors.some((item) => item.includes('loopback')));
  assert.ok(errors.some((item) => item.includes('DEV_INSECURE')));
  assert.ok(errors.some((item) => item.includes('COOKIE_SECURE')));
});

test('valid production config passes', () => {
  const config = loadConfig({
    NODE_ENV: 'production', HOST: '127.0.0.1', COOKIE_SECURE: 'true',
    PUBLIC_ORIGIN: 'https://203.0.113.10', CONTROL_PASSWORD_HASH: 'scrypt$2$1$1$1$a$b',
    AGENT_INGEST_TOKEN: 'x'.repeat(48),
  });
  assert.deepEqual(validateConfig(config).errors, []);
});

test('MAIN_ALLOW_PERSISTENT defaults to false and toggles from env', () => {
  const defaultConfig = loadConfig({
    NODE_ENV: 'test', HOST: '127.0.0.1', COOKIE_SECURE: 'false',
    CONTROL_PASSWORD_HASH: 'scrypt$2$1$1$1$a$b', AGENT_INGEST_TOKEN: 'x'.repeat(48),
  });
  assert.equal(defaultConfig.mainAllowPersistent, false);
  const enabled = loadConfig({
    NODE_ENV: 'test', HOST: '127.0.0.1', COOKIE_SECURE: 'false',
    CONTROL_PASSWORD_HASH: 'scrypt$2$1$1$1$a$b', AGENT_INGEST_TOKEN: 'x'.repeat(48),
    MAIN_ALLOW_PERSISTENT: 'true',
  });
  assert.equal(enabled.mainAllowPersistent, true);
});
