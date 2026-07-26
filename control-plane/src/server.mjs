import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, validateConfig } from './config.mjs';
import { StateStore } from './store.mjs';
import { routeTask } from './router.mjs';
import { buildPolicy, toolDecision } from './policy.mjs';
import {
  isAgentAuthorized,
  LoginRateLimiter,
  parseCookies,
  redact,
  SessionManager,
  verifyPassword,
} from './security.mjs';

const config = loadConfig();
const errors = validateConfig(config);
if (errors.length) {
  console.error(`Configuration error:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
if (config.plainPassword && !config.passwordHash) {
  console.warn('WARNING: CONTROL_PASSWORD is enabled. Prefer CONTROL_PASSWORD_HASH for production.');
}

const store = new StateStore(config);
await store.init();
const sessions = new SessionManager({ ttlMinutes: config.sessionTtlMinutes });
const loginLimiter = new LoginRateLimiter();
const sseClients = new Set();
const cookieName = 'ocwd_session';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

function json(res, status, body, extraHeaders = {}) {
  setSecurityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(body));
}

async function readJson(req, maxBytes = 256 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 });
  }
}

function requestIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

function browserSession(req) {
  return sessions.get(parseCookies(req.headers.cookie)[cookieName]);
}

function requireBrowserAuth(req, res, { csrf = false } = {}) {
  const session = browserSession(req);
  if (!session) {
    json(res, 401, { error: 'authentication_required' });
    return null;
  }
  if (csrf && req.headers['x-csrf-token'] !== session.csrf) {
    json(res, 403, { error: 'invalid_csrf_token' });
    return null;
  }
  if (csrf && config.publicOrigin && req.headers.origin !== config.publicOrigin) {
    json(res, 403, { error: 'invalid_origin' });
    return null;
  }
  return session;
}

function requireAgent(req, res) {
  if (!isAgentAuthorized(req, config.agentToken)) {
    json(res, 401, { error: 'invalid_agent_token' });
    return false;
  }
  return true;
}

function modeContext(url) {
  return {
    sessionId: url.searchParams.get('sessionId') || '',
    projectId: url.searchParams.get('projectId') || '',
  };
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const absolute = path.join(config.publicDir, safePath);
  if (!absolute.startsWith(config.publicDir)) return false;
  try {
    const data = await fs.readFile(absolute);
    setSecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(absolute)] || 'application/octet-stream',
      'Cache-Control': requested === '/index.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function publishSse(event) {
  const line = `event: control\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) client.write(line);
}
store.subscribe(publishSse);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    if (pathname === '/health') return json(res, 200, { ok: true, mode: store.resolveMode().mode });

    if (pathname === '/api/login' && req.method === 'POST') {
      const ip = requestIp(req);
      const limit = loginLimiter.status(ip);
      if (limit.blocked) return json(res, 429, { error: 'login_temporarily_blocked', retryAfterSeconds: limit.retryAfterSeconds });
      const { password = '' } = await readJson(req, 16 * 1024);
      if (!config.devInsecure && !verifyPassword(password, config.passwordHash, config.plainPassword)) {
        loginLimiter.fail(ip);
        await store.appendEvent({ type: 'auth.failed', ip });
        return json(res, 401, { error: 'invalid_credentials' });
      }
      loginLimiter.success(ip);
      const session = sessions.create(ip);
      const cookie = [
        `${cookieName}=${encodeURIComponent(session.token)}`,
        'HttpOnly',
        'SameSite=Strict',
        'Path=/',
        `Max-Age=${config.sessionTtlMinutes * 60}`,
        ...(config.cookieSecure ? ['Secure'] : []),
      ].join('; ');
      await store.appendEvent({ type: 'auth.succeeded', ip });
      return json(res, 200, { ok: true, csrfToken: session.csrf }, { 'Set-Cookie': cookie });
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const session = requireBrowserAuth(req, res, { csrf: true });
      if (!session) return;
      sessions.delete(session.token);
      return json(res, 200, { ok: true }, { 'Set-Cookie': `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }

    if (pathname === '/api/session' && req.method === 'GET') {
      const session = requireBrowserAuth(req, res);
      if (!session) return;
      return json(res, 200, { authenticated: true, csrfToken: session.csrf });
    }

    if (pathname === '/api/status' && req.method === 'GET') {
      if (!requireBrowserAuth(req, res)) return;
      return json(res, 200, store.snapshot(modeContext(url)));
    }

    if (pathname === '/api/events' && req.method === 'GET') {
      if (!requireBrowserAuth(req, res)) return;
      return json(res, 200, { events: store.listEvents(Number(url.searchParams.get('limit') || 100)) });
    }

    if (pathname === '/api/events' && req.method === 'POST') {
      if (!requireAgent(req, res)) return;
      const body = redact(await readJson(req));
      if (!body.type || typeof body.type !== 'string') return json(res, 400, { error: 'event_type_required' });
      const event = await store.appendEvent(body);
      return json(res, 202, { accepted: true, eventId: event.id });
    }

    if (pathname === '/api/stream' && req.method === 'GET') {
      if (!requireBrowserAuth(req, res)) return;
      setSecurityHeaders(res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write('event: ready\ndata: {}\n\n');
      sseClients.add(res);
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 20_000);
      req.on('close', () => {
        clearInterval(timer);
        sseClients.delete(res);
      });
      return;
    }

    if (pathname === '/api/mode' && req.method === 'PUT') {
      const session = requireBrowserAuth(req, res, { csrf: true });
      if (!session) return;
      const body = await readJson(req);
      const scope = body.scope || 'session';
      const mode = body.mode;
      const id = body.id || '';
      let ttlMinutes = Number(body.ttlMinutes || 0);

      if (mode === 'main') {
        if (!verifyPassword(body.reauthPassword || '', config.passwordHash, config.plainPassword) && !config.devInsecure) {
          return json(res, 403, { error: 'reauthentication_required' });
        }
        ttlMinutes = ttlMinutes || config.mainModeDefaultTtlMinutes;
        ttlMinutes = Math.min(ttlMinutes, config.mainModeMaxTtlMinutes);
      }
      const entry = await store.setMode({ scope, id, mode, ttlMinutes, actor: 'web' });
      return json(res, 200, { ok: true, entry, resolved: store.resolveMode({ sessionId: scope === 'session' ? id : '', projectId: scope === 'project' ? id : '' }) });
    }

    if (pathname === '/api/mode' && req.method === 'DELETE') {
      const session = requireBrowserAuth(req, res, { csrf: true });
      if (!session) return;
      const body = await readJson(req);
      await store.clearMode({ scope: body.scope, id: body.id, actor: 'web' });
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/route' && req.method === 'POST') {
      const browser = browserSession(req);
      const agent = isAgentAuthorized(req, config.agentToken);
      if (!browser && !agent) return json(res, 401, { error: 'authentication_required' });
      if (browser && req.headers['x-csrf-token'] !== browser.csrf) return json(res, 403, { error: 'invalid_csrf_token' });
      const body = await readJson(req);
      const resolved = store.resolveMode({ sessionId: body.sessionId, projectId: body.projectId, taskMode: body.taskMode });
      const route = routeTask({ task: body.task, mode: resolved.mode, properties: body.properties, workerAll: body.workerAll });
      const policy = buildPolicy({ mode: resolved.mode, actor: route.actor, role: 'main' });
      const event = await store.appendEvent({ type: 'route.decided', ...redact(route), modeSource: resolved.source, sessionId: body.sessionId || null, projectId: body.projectId || null, task: body.task });
      return json(res, 200, { route, policy, modeSource: resolved.source, eventId: event.id });
    }

    if (pathname === '/api/policy' && req.method === 'POST') {
      if (!requireAgent(req, res)) return;
      const body = await readJson(req);
      const resolved = store.resolveMode({ sessionId: body.sessionId, projectId: body.projectId, taskMode: body.taskMode });
      const route = body.actor
        ? { actor: body.actor }
        : routeTask({ task: body.task, mode: resolved.mode, properties: body.properties, workerAll: body.workerAll });
      const policy = buildPolicy({ mode: resolved.mode, actor: route.actor, role: body.role || 'main' });
      return json(res, 200, { mode: resolved.mode, modeSource: resolved.source, actor: route.actor, policy });
    }

    if (pathname === '/api/tool-check' && req.method === 'POST') {
      if (!requireAgent(req, res)) return;
      const body = await readJson(req);
      const resolved = store.resolveMode({ sessionId: body.sessionId, projectId: body.projectId, taskMode: body.taskMode });
      const policy = buildPolicy({ mode: resolved.mode, actor: body.actor || 'main', role: body.role || 'main' });
      const decision = toolDecision(policy, body.tool);
      if (!decision.allowed) {
        await store.appendEvent({ type: 'tool.blocked', role: body.role || 'main', tool: body.tool, mode: resolved.mode, sessionId: body.sessionId || null, reason: decision.reason });
      }
      return json(res, 200, { ...decision, policy, mode: resolved.mode });
    }

    if (req.method === 'GET' && await serveStatic(req, res, pathname)) return;
    json(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error(error);
    json(res, error.statusCode || 500, { error: error.statusCode ? error.message : 'internal_error' });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`OpenClaw delegation control plane listening on http://${config.host}:${config.port}`);
});
