import crypto from 'node:crypto';

const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };

export function hashPassword(password) {
  if (!password || password.length < 12) {
    throw new Error('Password must contain at least 12 characters');
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, SCRYPT_OPTIONS);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function safeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function verifyPassword(password, passwordHash, plainPassword = '') {
  if (passwordHash?.startsWith('scrypt$')) {
    const [, saltText, expectedText] = passwordHash.split('$');
    if (!saltText || !expectedText) return false;
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(expectedText, 'base64url');
    const actual = crypto.scryptSync(password, salt, expected.length, SCRYPT_OPTIONS);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  return plainPassword ? safeEqualText(password, plainPassword) : false;
}

export function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        if (index === -1) return [part, ''];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

export class SessionManager {
  constructor({ ttlMinutes = 480, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMinutes * 60_000;
    this.now = now;
    this.sessions = new Map();
  }

  create(ip = '') {
    const token = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(24).toString('base64url');
    const session = {
      token,
      csrf,
      ip,
      createdAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
    };
    this.sessions.set(token, session);
    return session;
  }

  get(token) {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  delete(token) {
    this.sessions.delete(token);
  }
}

export class LoginRateLimiter {
  constructor({ maxAttempts = 6, windowMs = 10 * 60_000, blockMs = 15 * 60_000, now = () => Date.now() } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.blockMs = blockMs;
    this.now = now;
    this.entries = new Map();
  }

  status(key) {
    const now = this.now();
    const entry = this.entries.get(key);
    if (!entry) return { blocked: false, retryAfterSeconds: 0 };
    if (entry.blockedUntil > now) {
      return { blocked: true, retryAfterSeconds: Math.ceil((entry.blockedUntil - now) / 1000) };
    }
    if (now - entry.windowStartedAt > this.windowMs) this.entries.delete(key);
    return { blocked: false, retryAfterSeconds: 0 };
  }

  fail(key) {
    const now = this.now();
    const previous = this.entries.get(key);
    const entry = !previous || now - previous.windowStartedAt > this.windowMs
      ? { attempts: 0, windowStartedAt: now, blockedUntil: 0 }
      : previous;
    entry.attempts += 1;
    if (entry.attempts >= this.maxAttempts) entry.blockedUntil = now + this.blockMs;
    this.entries.set(key, entry);
  }

  success(key) {
    this.entries.delete(key);
  }
}

const sensitiveKey = /password|secret|token|authorization|cookie|api[-_]?key|environment|env/i;

export function redact(value, depth = 0) {
  if (depth > 5) return '[truncated]';
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, item]) => [key, sensitiveKey.test(key) ? '[redacted]' : redact(item, depth + 1)]),
    );
  }
  return value;
}

export function isAgentAuthorized(req, expectedToken) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ') || !expectedToken) return false;
  return safeEqualText(header.slice(7), expectedToken);
}
