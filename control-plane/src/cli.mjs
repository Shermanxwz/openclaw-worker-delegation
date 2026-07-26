import { hashPassword } from './security.mjs';
import { loadConfig, validateConfig } from './config.mjs';

const [command] = process.argv.slice(2);

if (command === 'hash-password') {
  const password = process.env.CONTROL_PASSWORD_INPUT || process.env.CONTROL_PASSWORD || '';
  if (!password) {
    console.error('Set CONTROL_PASSWORD_INPUT and run npm run hash-password');
    process.exit(1);
  }
  console.log(hashPassword(password));
  process.exit(0);
}

if (command === 'doctor') {
  const config = loadConfig();
  const errors = validateConfig(config);
  const checks = {
    node: process.version,
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    publicOriginConfigured: Boolean(config.publicOrigin),
    passwordConfigured: Boolean(config.passwordHash || config.plainPassword),
    agentTokenConfigured: Boolean(config.agentToken),
    errors,
  };
  console.log(JSON.stringify(checks, null, 2));
  process.exit(errors.length ? 1 : 0);
}

console.error('Usage: node src/cli.mjs <hash-password|doctor>');
process.exit(1);
