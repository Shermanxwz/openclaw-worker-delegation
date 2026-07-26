import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { isValidTotpSecret } from './security.mjs';

const dirname = path.dirname(fileURLToPath(import.meta.url));

const asInt = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const asBool = (value, fallback = false) => {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const asCsv = (value, fallback = []) => {
  if (value == null || value === '') return [...fallback];
  return [...new Set(String(value).split(',').map((part) => part.trim()).filter(Boolean))];
};

export function isLoopbackHost(host) {
  if (host === 'localhost' || host === '::1') return true;
  if (net.isIP(host) === 4) return host.startsWith('127.');
  return false;
}

export function loadConfig(env = process.env) {
  const defaultMode = ['worker', 'auto', 'main'].includes(env.DEFAULT_MODE) ? env.DEFAULT_MODE : 'auto';
  const nodeEnv = env.NODE_ENV || 'development';
  return {
    nodeEnv,
    host: env.HOST || '127.0.0.1',
    port: asInt(env.PORT, 8787, 1, 65535),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    publicDir: path.resolve(dirname, '../public'),
    publicOrigin: (env.PUBLIC_ORIGIN || '').replace(/\/$/, ''),
    cookieSecure: asBool(env.COOKIE_SECURE, nodeEnv === 'production'),
    trustProxy: asBool(env.TRUST_PROXY, true),
    sessionTtlMinutes: asInt(env.SESSION_TTL_MINUTES, 480, 15, 1440),
    passwordHash: env.CONTROL_PASSWORD_HASH || '',
    plainPassword: env.CONTROL_PASSWORD || '',
    allowPlainPassword: asBool(env.ALLOW_PLAIN_PASSWORD, false),
    agentToken: env.AGENT_INGEST_TOKEN || '',
    totpSecret: env.CONTROL_TOTP_SECRET || '',
    maxPasswordChecks: asInt(env.MAX_PASSWORD_CHECKS, 2, 1, 8),
    defaultMode,
    mainModeDefaultTtlMinutes: asInt(env.MAIN_MODE_DEFAULT_TTL_MINUTES, 30, 5, 240),
    mainModeMaxTtlMinutes: asInt(env.MAIN_MODE_MAX_TTL_MINUTES, 120, 5, 1440),
    taskOverrideDefaultTtlMinutes: asInt(env.TASK_OVERRIDE_DEFAULT_TTL_MINUTES, 30, 5, 240),
    taskOverrideMaxTtlMinutes: asInt(env.TASK_OVERRIDE_MAX_TTL_MINUTES, 120, 5, 1440),
    maxEvents: asInt(env.MAX_EVENTS, 2000, 100, 100_000),
    maxSseClients: asInt(env.MAX_SSE_CLIENTS, 8, 1, 100),
    runtimeStaleSeconds: asInt(env.RUNTIME_STALE_SECONDS, 90, 15, 3600),
    routeDecisionTtlSeconds: asInt(env.ROUTE_DECISION_TTL_SECONDS, 900, 30, 86_400),
    auditAllowedTools: asBool(env.AUDIT_ALLOWED_TOOLS, true),
    devInsecure: asBool(env.DEV_INSECURE, false),
    mainAgentIds: asCsv(env.MAIN_AGENT_IDS, ['main']),
    workerAgentIds: asCsv(env.WORKER_AGENT_IDS, ['body-worker', 'worker']),
    verifierAgentIds: asCsv(env.VERIFIER_AGENT_IDS, ['verifier']),
    workerExtraTools: asCsv(env.WORKER_EXTRA_TOOLS),
    verifierExtraTools: asCsv(env.VERIFIER_EXTRA_TOOLS),
  };
}

export function validateConfig(config) {
  const errors = [];
  const warnings = [];
  if (!isLoopbackHost(config.host)) errors.push('HOST must be loopback-only (127.0.0.1, ::1, or localhost)');
  if (!config.devInsecure && !config.passwordHash && !config.plainPassword) {
    errors.push('CONTROL_PASSWORD_HASH is required');
  }
  if (config.plainPassword && !config.allowPlainPassword) {
    errors.push('Plain CONTROL_PASSWORD is disabled; set CONTROL_PASSWORD_HASH instead');
  }
  if (config.totpSecret && !isValidTotpSecret(config.totpSecret)) errors.push('CONTROL_TOTP_SECRET must be a valid Base32 secret with at least 16 characters');
  if (!config.devInsecure && config.agentToken.length < 32) {
    errors.push('AGENT_INGEST_TOKEN must contain at least 32 characters');
  }
  if (config.nodeEnv === 'production') {
    if (config.devInsecure) errors.push('DEV_INSECURE cannot be enabled in production');
    if (!config.cookieSecure) errors.push('COOKIE_SECURE must be true in production');
    if (!config.publicOrigin) errors.push('PUBLIC_ORIGIN is required in production');
  }
  if (config.publicOrigin) {
    try {
      const origin = new URL(config.publicOrigin);
      if (origin.origin !== config.publicOrigin) errors.push('PUBLIC_ORIGIN must be an origin without a path');
      if (config.nodeEnv === 'production' && origin.protocol !== 'https:') errors.push('PUBLIC_ORIGIN must use https in production');
    } catch {
      errors.push('PUBLIC_ORIGIN must be a valid absolute origin');
    }
  }
  if (config.mainModeDefaultTtlMinutes > config.mainModeMaxTtlMinutes) {
    errors.push('MAIN_MODE_DEFAULT_TTL_MINUTES cannot exceed MAIN_MODE_MAX_TTL_MINUTES');
  }
  if (config.taskOverrideDefaultTtlMinutes > config.taskOverrideMaxTtlMinutes) {
    errors.push('TASK_OVERRIDE_DEFAULT_TTL_MINUTES cannot exceed TASK_OVERRIDE_MAX_TTL_MINUTES');
  }
  const roleEntries = [
    ...config.mainAgentIds.map((id) => [id, 'main']),
    ...config.workerAgentIds.map((id) => [id, 'worker']),
    ...config.verifierAgentIds.map((id) => [id, 'verifier']),
  ];
  const seen = new Map();
  for (const [id, role] of roleEntries) {
    if (seen.has(id) && seen.get(id) !== role) errors.push(`Agent id ${id} appears in multiple role lists`);
    seen.set(id, role);
  }
  if (!config.publicOrigin) warnings.push('PUBLIC_ORIGIN is unset; strict browser Origin validation is disabled');
  if (config.nodeEnv === 'production' && !config.totpSecret) warnings.push('CONTROL_TOTP_SECRET is unset; the public control panel is password-only');
  return { errors, warnings };
}
