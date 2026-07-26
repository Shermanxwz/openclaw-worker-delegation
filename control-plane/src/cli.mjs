import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { generateTotpSecret, hashPassword } from './security.mjs';
import { loadConfig, validateConfig } from './config.mjs';

const [command] = process.argv.slice(2);

if (command === 'hash-password') {
  const password = process.env.CONTROL_PASSWORD_INPUT || process.env.CONTROL_PASSWORD || '';
  if (!password) { console.error('Set CONTROL_PASSWORD_INPUT and run npm run hash-password'); process.exit(1); }
  console.log(await hashPassword(password));
  process.exit(0);
}

if (command === 'generate-token') {
  console.log(crypto.randomBytes(48).toString('base64url'));
  process.exit(0);
}

if (command === 'generate-totp-secret') {
  console.log(generateTotpSecret());
  process.exit(0);
}

if (command === 'doctor') {
  const config = loadConfig();
  const validation = validateConfig(config);
  let dataDirWritable = false;
  try { await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 }); await fs.access(config.dataDir, fsConstants.W_OK); dataDirWritable = true; } catch {}
  const checks = {
    node: process.version,
    nodeEnvironment: config.nodeEnv,
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    dataDirWritable,
    publicOrigin: config.publicOrigin || null,
    cookieSecure: config.cookieSecure,
    passwordHashConfigured: Boolean(config.passwordHash),
    agentTokenConfigured: Boolean(config.agentToken),
    roleMappings: { main: config.mainAgentIds, worker: config.workerAgentIds, verifier: config.verifierAgentIds },
    warnings: validation.warnings,
    errors: [...validation.errors, ...(dataDirWritable ? [] : ['DATA_DIR is not writable'])],
  };
  console.log(JSON.stringify(checks, null, 2));
  process.exit(checks.errors.length ? 1 : 0);
}

console.error('Usage: node src/cli.mjs <hash-password|generate-token|generate-totp-secret|doctor>');
process.exit(1);
