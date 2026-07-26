import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);
const LEGACY_SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SCRYPT_OPTIONS = { N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export async function hashPassword(password) {
  if (!password || password.length < 14) throw new Error('Password must contain at least 14 characters');
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, 32, SCRYPT_OPTIONS);
  return `scrypt$2$${SCRYPT_OPTIONS.N}$${SCRYPT_OPTIONS.r}$${SCRYPT_OPTIONS.p}$${salt.toString('base64url')}$${Buffer.from(hash).toString('base64url')}`;
}

function safeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function validScryptParams({ N, r, p }) {
  return Number.isInteger(N) && N >= 16_384 && N <= 262_144 && (N & (N - 1)) === 0
    && Number.isInteger(r) && r >= 1 && r <= 16
    && Number.isInteger(p) && p >= 1 && p <= 8;
}

export async function verifyPassword(password, passwordHash, plainPassword = '') {
  try {
    if (passwordHash?.startsWith('scrypt$2$')) {
      const [, , nText, rText, pText, saltText, expectedText] = passwordHash.split('$');
      const options = { N: Number(nText), r: Number(rText), p: Number(pText), maxmem: 512 * 1024 * 1024 };
      if (!saltText || !expectedText || !validScryptParams(options)) return false;
      const expected = Buffer.from(expectedText, 'base64url');
      if (expected.length < 16 || expected.length > 64) return false;
      const actual = await scryptAsync(password, Buffer.from(saltText, 'base64url'), expected.length, options);
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    }
    if (passwordHash?.startsWith('scrypt$')) {
      const [, saltText, expectedText] = passwordHash.split('$');
      if (!saltText || !expectedText) return false;
      const expected = Buffer.from(expectedText, 'base64url');
      const actual = await scryptAsync(password, Buffer.from(saltText, 'base64url'), expected.length, LEGACY_SCRYPT_OPTIONS);
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    }
    return plainPassword ? safeEqualText(password, plainPassword) : false;
  } catch {
    return false;
  }
}

function normalizeBase32(secret) {
  return String(secret || '').toUpperCase().replace(/[\s=-]/g, '');
}

function decodeBase32(secret) {
  const normalized = normalizeBase32(secret);
  let bits = '';
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error('invalid base32');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  return Buffer.from(bytes);
}


export function generateTotpSecret(bytes = 20) {
  const input = crypto.randomBytes(Math.max(10, Math.min(64, Number(bytes) || 20)));
  let bits = '';
  for (const byte of input) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let offset = 0; offset < bits.length; offset += 5) {
    output += BASE32_ALPHABET[Number.parseInt(bits.slice(offset, offset + 5).padEnd(5, '0'), 2)];
  }
  return output;
}

export function isValidTotpSecret(secret) {
  try { return normalizeBase32(secret).length >= 16 && decodeBase32(secret).length >= 10; }
  catch { return false; }
}

export function generateTotp(secret, { now = Date.now(), stepSeconds = 30, digits = 6 } = {}) {
  const key = decodeBase32(secret);
  const counter = BigInt(Math.floor(now / 1000 / stepSeconds));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const digest = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

export function verifyTotp(code, secret, { now = Date.now(), window = 1 } = {}) {
  if (!secret) return true;
  const normalizedCode = String(code || '').trim();
  if (!/^\d{6}$/.test(normalizedCode) || !isValidTotpSecret(secret)) return false;
  for (let offset = -window; offset <= window; offset += 1) {
    if (safeEqualText(normalizedCode, generateTotp(secret, { now: now + offset * 30_000 }))) return true;
  }
  return false;
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf('=');
    const key = index === -1 ? trimmed : trimmed.slice(0, index);
    const raw = index === -1 ? '' : trimmed.slice(index + 1);
    try { cookies[key] = decodeURIComponent(raw); } catch { cookies[key] = ''; }
  }
  return cookies;
}

export class SessionManager {
  constructor({ ttlMinutes = 480, maxSessions = 32, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMinutes * 60_000;
    this.maxSessions = maxSessions;
    this.now = now;
    this.sessions = new Map();
  }

  cleanup() {
    const now = this.now();
    for (const [token, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(token);
    while (this.sessions.size > this.maxSessions) this.sessions.delete(this.sessions.keys().next().value);
  }

  create(ip = '') {
    this.cleanup();
    const session = { token: crypto.randomBytes(32).toString('base64url'), csrf: crypto.randomBytes(24).toString('base64url'), ip, createdAt: this.now(), expiresAt: this.now() + this.ttlMs };
    this.sessions.set(session.token, session);
    this.cleanup();
    return session;
  }

  get(token) { this.cleanup(); return token ? this.sessions.get(token) || null : null; }
  delete(token) { if (token) this.sessions.delete(token); }
}

export class LoginRateLimiter {
  constructor({ maxAttempts = 6, windowMs = 10 * 60_000, blockMs = 15 * 60_000, maxEntries = 5000, now = () => Date.now() } = {}) {
    this.maxAttempts = maxAttempts; this.windowMs = windowMs; this.blockMs = blockMs; this.maxEntries = maxEntries; this.now = now; this.entries = new Map();
  }
  cleanup() {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.blockedUntil <= now && now - entry.windowStartedAt > this.windowMs) this.entries.delete(key);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }
  status(key) {
    this.cleanup(); const now = this.now(); const entry = this.entries.get(key);
    if (!entry) return { blocked: false, retryAfterSeconds: 0 };
    if (entry.blockedUntil > now) return { blocked: true, retryAfterSeconds: Math.ceil((entry.blockedUntil - now) / 1000) };
    return { blocked: false, retryAfterSeconds: 0 };
  }
  fail(key) {
    const now = this.now(); const previous = this.entries.get(key);
    const entry = !previous || now - previous.windowStartedAt > this.windowMs ? { attempts: 0, windowStartedAt: now, blockedUntil: 0 } : previous;
    entry.attempts += 1; if (entry.attempts >= this.maxAttempts) entry.blockedUntil = now + this.blockMs;
    this.entries.set(key, entry); this.cleanup();
  }
  success(key) { this.entries.delete(key); }
}

const sensitiveKey = /password|secret|token|authorization|cookie|api[-_]?key|environment|env|credential|totp/i;
export function redact(value, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, sensitiveKey.test(key) ? '[redacted]' : redact(item, depth + 1)]));
  return value;
}

export function isAgentAuthorized(req, expectedToken) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ') || !expectedToken) return false;
  return safeEqualText(header.slice(7), expectedToken);
}
