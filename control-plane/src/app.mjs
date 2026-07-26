import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { StateStore } from './store.mjs';
import { routeTask } from './router.mjs';
import { buildPolicy, resolveAgentRole, toolDecision } from './policy.mjs';
import { isAgentAuthorized, LoginRateLimiter, parseCookies, redact, SessionManager, verifyPassword, verifyTotp } from './security.mjs';

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const isLoopbackAddress = (address = '') => address === '::1' || address.startsWith('127.') || address === '::ffff:127.0.0.1';

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

function json(res, status, body, extraHeaders = {}) {
  setSecurityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(body));
}

async function readJson(req, maxBytes = 256 * 1024) {
  if (req.headers['content-type'] && !String(req.headers['content-type']).toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('content_type_must_be_application_json'), { statusCode: 415 });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('request_body_too_large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid_json'), { statusCode: 400 }); }
}

function validateIdentifier(value, field, { required = false, max = 200 } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw Object.assign(new Error(`${field}_required`), { statusCode: 400 });
  if (text.length > max) throw Object.assign(new Error(`${field}_too_long`), { statusCode: 400 });
  return text;
}

export async function createControlPlane(config) {
  const store = new StateStore(config);
  await store.init();
  const sessions = new SessionManager({ ttlMinutes: config.sessionTtlMinutes });
  const loginLimiter = new LoginRateLimiter();
  const sseClients = new Set();
  let activePasswordChecks = 0;
  const cookieName = config.cookieSecure ? '__Host-ocwd_session' : 'ocwd_session';

  function requestIp(req) {
    const socketIp = req.socket.remoteAddress || 'unknown';
    if (config.trustProxy && isLoopbackAddress(socketIp)) {
      const candidate = String(req.headers['x-real-ip'] || '').trim();
      if (net.isIP(candidate)) return candidate;
    }
    return socketIp;
  }

  function browserSession(req) {
    return sessions.get(parseCookies(req.headers.cookie)[cookieName]);
  }

  function requireBrowserAuth(req, res, { csrf = false } = {}) {
    const session = browserSession(req);
    if (!session) { json(res, 401, { error: 'authentication_required' }); return null; }
    if (csrf && req.headers['x-csrf-token'] !== session.csrf) { json(res, 403, { error: 'invalid_csrf_token' }); return null; }
    if (csrf && config.publicOrigin && req.headers.origin !== config.publicOrigin) { json(res, 403, { error: 'invalid_origin' }); return null; }
    return session;
  }

  function requireAgent(req, res) {
    if (!isAgentAuthorized(req, config.agentToken)) { json(res, 401, { error: 'invalid_agent_token' }); return false; }
    return true;
  }

  async function verifyControlCredential(password, totp) {
    if (activePasswordChecks >= config.maxPasswordChecks) throw Object.assign(new Error('authentication_busy'), { statusCode: 503 });
    activePasswordChecks += 1;
    try {
      const passwordValid = config.devInsecure || await verifyPassword(password || '', config.passwordHash, config.plainPassword);
      return passwordValid && verifyTotp(totp, config.totpSecret);
    } finally {
      activePasswordChecks -= 1;
    }
  }

  function modeContext(url) {
    return { sessionId: validateIdentifier(url.searchParams.get('sessionId') || '', 'session_id'), projectId: validateIdentifier(url.searchParams.get('projectId') || '', 'project_id') };
  }

  async function serveStatic(res, pathname) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return false; }
    const requested = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    if (!requested || requested.includes('\0')) return false;
    const absolute = path.resolve(config.publicDir, requested);
    const relative = path.relative(config.publicDir, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
    try {
      const data = await fs.readFile(absolute);
      setSecurityHeaders(res);
      res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(absolute)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
      return true;
    } catch { return false; }
  }

  function publishSse(event) {
    const line = `event: control\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of [...sseClients]) {
      try { client.write(line); } catch { sseClients.delete(client); }
    }
  }
  const unsubscribe = store.subscribe(publishSse);
  const expiryTimer = setInterval(() => store.purgeExpired().catch((error) => console.error({ error, source: 'expiry-purge' })), 60_000);
  expiryTimer.unref?.();

  const server = http.createServer(async (req, res) => {
    const requestId = crypto.randomUUID?.() || Math.random().toString(36).slice(2);
    res.setHeader('X-Request-Id', requestId);
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const { pathname } = url;

      if ((pathname === '/health' || pathname === '/health/live') && req.method === 'GET') return json(res, 200, { ok: true });
      if (pathname === '/health/ready' && req.method === 'GET') return json(res, 200, { ok: true, storeReady: true });

      if (pathname === '/api/login-config' && req.method === 'GET') return json(res, 200, { totpRequired: Boolean(config.totpSecret) });

      if (pathname === '/api/login' && req.method === 'POST') {
        const ip = requestIp(req);
        const limit = loginLimiter.status(ip);
        if (limit.blocked) return json(res, 429, { error: 'login_temporarily_blocked', retryAfterSeconds: limit.retryAfterSeconds }, { 'Retry-After': String(limit.retryAfterSeconds) });
        const { password = '', totp = '' } = await readJson(req, 16 * 1024);
        if (!(await verifyControlCredential(password, totp))) {
          loginLimiter.fail(ip);
          await store.appendEvent({ type: 'auth.failed', ip });
          return json(res, 401, { error: 'invalid_credentials' });
        }
        loginLimiter.success(ip);
        const session = sessions.create(ip);
        const cookie = [`${cookieName}=${encodeURIComponent(session.token)}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${config.sessionTtlMinutes * 60}`, ...(config.cookieSecure ? ['Secure'] : [])].join('; ');
        await store.appendEvent({ type: 'auth.succeeded', ip });
        return json(res, 200, { ok: true, csrfToken: session.csrf }, { 'Set-Cookie': cookie });
      }

      if (pathname === '/api/logout' && req.method === 'POST') {
        const session = requireBrowserAuth(req, res, { csrf: true });
        if (!session) return;
        sessions.delete(session.token);
        const clearCookie = [`${cookieName}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0', ...(config.cookieSecure ? ['Secure'] : [])].join('; ');
        return json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
      }

      if (pathname === '/api/session' && req.method === 'GET') {
        const session = requireBrowserAuth(req, res); if (!session) return;
        return json(res, 200, { authenticated: true, csrfToken: session.csrf, totpEnabled: Boolean(config.totpSecret) });
      }
      if (pathname === '/api/status' && req.method === 'GET') {
        if (!requireBrowserAuth(req, res)) return;
        return json(res, 200, store.snapshot(modeContext(url)));
      }
      if (pathname === '/api/events' && req.method === 'GET') {
        if (!requireBrowserAuth(req, res)) return;
        return json(res, 200, { events: store.listEvents(url.searchParams.get('limit')) });
      }
      if (pathname === '/api/events' && req.method === 'POST') {
        if (!requireAgent(req, res)) return;
        const body = redact(await readJson(req));
        if (!body.type || typeof body.type !== 'string') return json(res, 400, { error: 'event_type_required' });
        const event = await store.appendEvent(body);
        return json(res, 202, { accepted: true, eventId: event.id });
      }
      if (pathname === '/api/runtime-status' && req.method === 'POST') {
        if (!requireAgent(req, res)) return;
        const body = redact(await readJson(req, 128 * 1024));
        const runtimeStatus = await store.updateRuntimeStatus(body);
        return json(res, 200, { ok: true, runtimeStatus });
      }
      if (pathname === '/api/stream' && req.method === 'GET') {
        if (!requireBrowserAuth(req, res)) return;
        if (sseClients.size >= config.maxSseClients) return json(res, 503, { error: 'too_many_stream_clients' });
        setSecurityHeaders(res);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('event: ready\ndata: {}\n\n');
        sseClients.add(res);
        const timer = setInterval(() => res.write(': heartbeat\n\n'), 20_000);
        timer.unref?.();
        req.on('close', () => { clearInterval(timer); sseClients.delete(res); });
        return;
      }

      if (pathname === '/api/mode' && req.method === 'PUT') {
        if (!requireBrowserAuth(req, res, { csrf: true })) return;
        const body = await readJson(req);
        const scope = body.scope || 'session';
        const mode = body.mode;
        const id = validateIdentifier(body.id || '', 'scope_id', { required: scope !== 'global' });
        let ttlMinutes = Number(body.ttlMinutes || 0);
        if (!Number.isFinite(ttlMinutes) || ttlMinutes < 0) return json(res, 400, { error: 'invalid_ttl' });
        if (mode === 'main') {
          if (body.confirmation !== 'ENABLE_MAIN') return json(res, 400, { error: 'main_confirmation_required' });
          if (!(await verifyControlCredential(body.reauthPassword || '', body.reauthTotp || ''))) return json(res, 403, { error: 'reauthentication_required' });
          const defaultTtl = scope === 'task' ? config.taskOverrideDefaultTtlMinutes : config.mainModeDefaultTtlMinutes;
          const maxTtl = scope === 'task'
            ? Math.min(config.taskOverrideMaxTtlMinutes, config.mainModeMaxTtlMinutes)
            : config.mainModeMaxTtlMinutes;
          ttlMinutes = Math.min(ttlMinutes || defaultTtl, maxTtl);
        } else if (scope === 'task') {
          ttlMinutes = Math.min(ttlMinutes || config.taskOverrideDefaultTtlMinutes, config.taskOverrideMaxTtlMinutes);
        } else {
          ttlMinutes = 0;
        }
        const entry = await store.setMode({ scope, id, mode, ttlMinutes, actor: 'web' });
        return json(res, 200, { ok: true, entry, resolved: store.resolveMode({ sessionId: scope === 'session' || scope === 'task' ? id : '', projectId: scope === 'project' ? id : '' }) });
      }
      if (pathname === '/api/mode' && req.method === 'DELETE') {
        if (!requireBrowserAuth(req, res, { csrf: true })) return;
        const body = await readJson(req);
        await store.clearMode({ scope: body.scope, id: validateIdentifier(body.id, 'scope_id', { required: true }), actor: 'web' });
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/route-preview' && req.method === 'POST') {
        if (!requireBrowserAuth(req, res, { csrf: true })) return;
        const body = await readJson(req);
        const resolved = store.resolveMode({ sessionId: body.sessionId, projectId: body.projectId, taskMode: body.taskMode });
        const route = routeTask({ task: body.task, mode: resolved.mode, properties: body.properties, workerAll: body.workerAll });
        const policy = buildPolicy({ mode: resolved.mode, role: 'main', routeActor: route.actor, workerExtraTools: config.workerExtraTools, verifierExtraTools: config.verifierExtraTools });
        return json(res, 200, { route, policy, modeSource: resolved.source, preview: true });
      }

      if (pathname === '/api/route' && req.method === 'POST') {
        if (!requireAgent(req, res)) return;
        const body = await readJson(req);
        const agentId = validateIdentifier(body.agentId, 'agent_id', { required: true });
        const runId = validateIdentifier(body.runId || '', 'run_id');
        const role = resolveAgentRole(agentId, config);
        if (role === 'unknown') return json(res, 403, { error: 'unknown_agent_id' });
        const existingBinding = runId ? store.getRouteDecision(runId) : null;
        let resolved;
        let route;
        if (existingBinding) {
          const binding = store.validateRouteBinding(runId, agentId, body.sessionId || '');
          if (!binding.valid) return json(res, 409, { error: binding.reason });
          route = binding.decision.route;
          resolved = { mode: route.mode, source: binding.decision.modeSource || 'run-binding' };
        } else {
          resolved = role === 'main'
            ? await store.consumeMode({ sessionId: body.sessionId, projectId: body.projectId })
            : store.resolveMode({ sessionId: body.sessionId, projectId: body.projectId, includeTask: false });
          route = role === 'main'
            ? routeTask({ task: body.task, mode: resolved.mode, properties: body.properties, workerAll: body.workerAll })
            : { mode: resolved.mode, actor: role === 'worker' ? 'worker' : 'verifier', decision: 'role-bound', score: null, confidence: 1, properties: {}, reasons: [] };
        }
        if (body.hook === 'before_prompt_build') await store.markRouteObserved({ instanceId: body.instanceId, runId, agentId, route, modeSource: resolved.source, sessionId: body.sessionId, projectId: body.projectId });
        else if (runId && !existingBinding) await store.markRouteObserved({ instanceId: '', runId, agentId, route, modeSource: resolved.source, sessionId: body.sessionId, projectId: body.projectId });
        const policy = buildPolicy({ mode: resolved.mode, role, routeActor: route.actor, workerExtraTools: config.workerExtraTools, verifierExtraTools: config.verifierExtraTools });
        const event = await store.appendEvent({ type: 'route.decided', ...redact(route), role, agentId, modeSource: resolved.source, sessionId: body.sessionId || null, projectId: body.projectId || null });
        return json(res, 200, { route, policy, role, modeSource: resolved.source, eventId: event.id });
      }

      if (pathname === '/api/policy' && req.method === 'POST') {
        if (!requireAgent(req, res)) return;
        const body = await readJson(req);
        const agentId = validateIdentifier(body.agentId, 'agent_id', { required: true });
        const role = resolveAgentRole(agentId, config);
        if (role === 'unknown') return json(res, 403, { error: 'unknown_agent_id' });
        const binding = store.validateRouteBinding(body.runId, agentId, body.sessionId || '');
        if (!binding.valid) return json(res, 409, { error: binding.reason });
        const effectiveSessionId = binding.decision?.sessionId || body.sessionId;
        const effectiveProjectId = binding.decision?.projectId || body.projectId;
        const baseResolved = store.resolveMode({ sessionId: effectiveSessionId, projectId: effectiveProjectId, includeTask: false });
        const resolved = binding.decision?.modeSource === 'task'
          ? { mode: binding.decision.route.mode, source: 'task-run-binding' }
          : baseResolved;
        const routeActor = binding.decision?.route?.actor || (resolved.mode === 'main' ? 'main' : role === 'main' ? 'worker' : role);
        const policy = buildPolicy({ mode: resolved.mode, role, routeActor, workerExtraTools: config.workerExtraTools, verifierExtraTools: config.verifierExtraTools });
        return json(res, 200, { mode: resolved.mode, modeSource: resolved.source, role, routeActor, policy });
      }

      if (pathname === '/api/tool-check' && req.method === 'POST') {
        if (!requireAgent(req, res)) return;
        const body = await readJson(req);
        const agentId = validateIdentifier(body.agentId, 'agent_id', { required: true });
        const role = resolveAgentRole(agentId, config);
        if (role === 'unknown') return json(res, 403, { error: 'unknown_agent_id' });
        const binding = store.validateRouteBinding(body.runId, agentId, body.sessionId || '');
        if (!binding.valid) {
          const denied = { allowed: false, reason: binding.reason, normalizedTool: String(body.tool || '').toLowerCase() };
          await store.appendEvent({ type: 'tool.blocked', role, agentId, tool: denied.normalizedTool, runId: body.runId || null, reason: denied.reason });
          return json(res, 200, denied);
        }
        const effectiveSessionId = binding.decision?.sessionId || body.sessionId;
        const effectiveProjectId = binding.decision?.projectId || body.projectId;
        const baseResolved = store.resolveMode({ sessionId: effectiveSessionId, projectId: effectiveProjectId, includeTask: false });
        const resolved = binding.decision?.modeSource === 'task'
          ? { mode: binding.decision.route.mode, source: 'task-run-binding' }
          : baseResolved;
        const routeActor = binding.decision?.route?.actor || (resolved.mode === 'main' ? 'main' : role === 'main' ? 'worker' : role);
        const policy = buildPolicy({ mode: resolved.mode, role, routeActor, workerExtraTools: config.workerExtraTools, verifierExtraTools: config.verifierExtraTools });
        const decision = toolDecision(policy, body.tool);
        if (body.hook === 'before_tool_call') await store.markToolCheckObserved({ instanceId: body.instanceId });
        if (!decision.allowed || config.auditAllowedTools) {
          await store.appendEvent({ type: decision.allowed ? 'tool.allowed' : 'tool.blocked', role, agentId, tool: decision.normalizedTool, mode: resolved.mode, runId: body.runId || null, sessionId: effectiveSessionId || null, reason: decision.reason });
        }
        return json(res, 200, { ...decision, policy, role, routeActor, mode: resolved.mode, modeSource: resolved.source });
      }

      if (req.method === 'GET' && await serveStatic(res, pathname)) return;
      json(res, 404, { error: 'not_found' });
    } catch (error) {
      console.error({ requestId, error });
      json(res, error.statusCode || 500, { error: error.statusCode ? error.message : 'internal_error', requestId });
    }
  });

  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;

  async function close() {
    unsubscribe();
    clearInterval(expiryTimer);
    for (const client of sseClients) client.end();
    await new Promise((resolve) => server.close(resolve));
  }
  return { server, store, close };
}
