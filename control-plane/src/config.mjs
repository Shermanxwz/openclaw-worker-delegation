import path from 'node:path';

const asInt = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const asBool = (value, fallback = false) => {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

export function loadConfig(env = process.env) {
  const defaultMode = ['worker', 'auto', 'main'].includes(env.DEFAULT_MODE)
    ? env.DEFAULT_MODE
    : 'auto';

  return {
    host: env.HOST || '127.0.0.1',
    port: asInt(env.PORT, 8787),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    publicDir: path.resolve(new URL('../public', import.meta.url).pathname),
    publicOrigin: env.PUBLIC_ORIGIN || '',
    cookieSecure: asBool(env.COOKIE_SECURE, true),
    sessionTtlMinutes: asInt(env.SESSION_TTL_MINUTES, 480),
    passwordHash: env.CONTROL_PASSWORD_HASH || '',
    plainPassword: env.CONTROL_PASSWORD || '',
    agentToken: env.AGENT_INGEST_TOKEN || '',
    defaultMode,
    mainModeDefaultTtlMinutes: asInt(env.MAIN_MODE_DEFAULT_TTL_MINUTES, 30),
    mainModeMaxTtlMinutes: asInt(env.MAIN_MODE_MAX_TTL_MINUTES, 120),
    maxEvents: asInt(env.MAX_EVENTS, 1000),
    devInsecure: asBool(env.DEV_INSECURE, false),
  };
}

export function validateConfig(config) {
  const errors = [];
  if (!config.devInsecure && !config.passwordHash && !config.plainPassword) {
    errors.push('CONTROL_PASSWORD_HASH (preferred) or CONTROL_PASSWORD is required');
  }
  if (!config.devInsecure && !config.agentToken) {
    errors.push('AGENT_INGEST_TOKEN is required');
  }
  if (config.host === '0.0.0.0') {
    errors.push('HOST must not be 0.0.0.0; expose only the reverse proxy publicly');
  }
  return errors;
}
