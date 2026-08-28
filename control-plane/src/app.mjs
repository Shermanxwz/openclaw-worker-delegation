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

function taskPath(pathname) {
  const match = pathname.match(/^\/api\/worker-tasks\/([^/]+)(?:\/(action))?$/);
  return match ? { id: decodeURIComponent(match[1]), action: match[2] === 'action' } : null;
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

  function isForbiddenStaticName(name) {
    if (!name) return false;
    const segments = name.split('/');
    for (const segment of segments) {
      if (!segment) continue;
      if (segment.startsWith('.')) return true;
      if (/\.bak(?:[.\-].*)?$/i.test(segment)) return true;
      if (/\.old(?:[.\-].*)?$/i.test(segment)) return true;
      if (/\.swp(?:[.\-].*)?$/i.test(segment)) return true;
      if (/\.tmp(?:[.\-].*)?$/i.test(segment)) return true;
      if (/\.orig(?:[.\-].*)?$/i.test(segment)) return true;
      if (/~$/.test(segment)) return true;
    }
    return false;
  }

  async function serveStatic(res, pathname) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return false; }
    const requested = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    if (!requested || requested.includes('\0')) return false;
    if (isForbiddenStaticName(requested)) return false;
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
      const workerTaskPath = taskPath(pathname);

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
      if (pathname === '/api/registry' && req.method === 'GET') {
        if (!requireBrowserAuth(req, res)) return;
        return json(res, 200, { registry: store.registrySnapshot(), routingProfiles: store.routingSnapshot() });
      }
      if (pathname === '/api/routing' && req.method === 'PUT') {
        if (!requireBrowserAuth(req, res, { csrf: true })) return;
        const body = await readJson(req, 64 * 1024);
        const profile = await store.setRoutingProfile({ mode: body.mode, role: body.role, modelRef: body.modelRef, thinking: body.thinking, actor: 'web' });
        return json(res, 200, { ok: true, profile, routingProfiles: store.routingSnapshot() });
      }
      if (pathname === '/api/worker-tasks' && req.method === 'GET') {
        if (!requireBrowserAuth(req, res)) return;
        return json(res, 200, { tasks: store.listWorkerTasks({ limit: url.searchParams.get('limit'), activeOnly: url.searchParams.get('active') === '1' }) });
      }
      if (workerTaskPath && !workerTaskPath.action && req.method === 'GET') {
        if (!requireBrowserAuth(req, res)) return;
        const task = store.getWorkerTask(workerTaskPath.id);
        return task ? json(res, 200, { task }) : json(res, 404, { error: 'worker_task_not_found' });
      }
      if (workerTaskPath?.action && req.method === 'POST') {
        if (!requireBrowserAuth(req, res, { csrf: true })) return;
        const body = await readJson(req, 32 * 1024);
        const expected = body.action === 'cancel' ? 'CANCEL_TASK' : body.action === 'extend' ? 'EXTEND_TASK' : '';
        if (!expected || body.confirmation !== expected) return json(res, 400, { error: 'task_action_confirmation_required' });
        if (!(await verifyControlCredential(body.reauthPassword || '', body.reauthTotp || ''))) return json(res, 403, { error: 'reauthentication_required' });
        const task = await store.rootTaskAction({ id: workerTaskPath.id, action: body.action, minutes: body.minutes, actor: 'root-control' });
        return json(res, 200, { ok: true, task });
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
      if (pathname === '/api/registry-sync' && req.method === 'POST') {
        if (!requireAgent(req, res)) return;
        const body = redact(await readJson(req, 512 * 1024));
        const registry = await store.updateRegistry(body);
        return json(res, 200, { ok: true, registryRevision: registry.revision, routingProfiles: store.routingSnapshot() });
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
          if (body.confirmation !== 'ENABLE_MAIN' && body.confirmation !== 'ENABLE_MAIN_PERSISTENT') return json(res, 400, { error: 'main_confirmation_required' });
          if (!(await verifyControlCredential(body.reauthPassword || '', body.reauthTotp || ''))) return json(res, 403, { error: 'reauthentication_required' });
          const wantsPersistent = body.ttlMinutes === 0 && body.confirmation === 'ENABLE_MAIN_PERSISTENT';
          if (wantsPersistent && !config.mainAllowPersistent) return json(res, 403, { error: 'persistent_main_disabled' });
          const defaultTtl = scope === 'task' ? config.taskOverrideDefaultTtlMinutes : config.mainModeDefaultTtlMinutes;
          const maxTtl = scope === 'task' ? Math.min(config.taskOverrideMaxTtlMinutes, config.mainModeMaxTtlMinutes) : config.mainModeMaxTtlMinutes;
          ttlMinutes = wantsPersistent ? 0 : Math.min(ttlMinutes || defaultTtl, maxTtl);
        } else if (scope === 'task') {
          ttlMinutes = Math.min(ttlMinutes || config.taskOverrideDefaultTtlMinutes, config.taskOverrideMaxTtlMinutes);
        } else {
          ttlMinutes = 0;
        }
        const entry = await store.setMode({ scope, id, mode, ttlMinutes, actor: 'web', persistent: mode === 'main' && ttlMinutes === 0 });
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
        const route = routeTask({ task: body.task, mode: resolved.mode, properties: body.properties });
        const policy = buildPolicy({ mode: resolved.mode, role: 'main', routeActor: route.actor, workerExtraTools: config.workerExtraTools, verifierExtraTools: config.verifierExtraTools });
        return json(res, 200, { route, policy, modelRoute: store.resolveRouteConfig(resolved.mode, 'main'), modeSource: resolved.source, preview: true });
      }

      if (pathname === '/api/route' && req.method === 'POST') {
        if (!requireAgent(req, res)) return;
        const body = await readJson(req);
        const agentId = validateIdentifier(body.agentId, 'agent_id', { required: true });
        const runId = validateIdentifier(body.runId || '', 'run_id', { required: true });
        const sessionId = validateIdentifier(body.sessionId || '', 'session_id');
        const role = resolveAgentRole(agentId, config);
        if (role === 'unknown') return json(res, 403, { error: 'unknown_agent_id' });
        const existingBinding = store.getRouteDecision(runId);
        let resolved;
        let route;
        let task = null;

        if (existingBinding) {
          const binding = store.validateRouteBinding(runId, agentId, sessionId);
          if (!binding.valid) return json(res, 409, { error: binding.reason });
          route = binding.decision.route;
          resolved = { mode: route.mode, source: binding.decision.modeSource || 'run-binding' };
          if (binding.decision.taskId) task = store.getWorkerTask(binding.decision.taskId);
        } else if (role === 'main') {
          resolved = await store.consumeMode({ sessionId, projectId: body.projectId });
          route = routeTask({ task: body.task, mode: resolved.mode, properties: body.properties });
        } else {
          const taskId = validateIdentifier(body.taskId || '', 'task_id', { required: true });
          const ownerEpoch = Number(body.ownerEpoch);
          const lease = store.validateWorkerLease({ id: taskId, ownerEpoch, agentId, runId: '', sessionId: '' });
          if (!lease.valid) return json(res, 409, { error: lease.reason });
          task = await store.bindWorkerTask({
            id: taskId, ownerEpoch, agentId, runId, sessionId, sessionKey: body.sessionKey,
            threadId: body.threadId, turnId: body.turnId, pluginInstanceId: body.instanceId,
          });
          resolved = { mode: task.route.mode, source: 'worker-task' };
          route = {
            mode: task.route.mode,
            actor: role,
            decision: 'durable-worker-task',
            score: null,
            confidence: 1,
            properties: task.properties || {},
            reasons: [],
            taskId,
          };
        }

        await store.markRouteObserved({
          instanceId: body.instanceId,
          runId,
          agentId,
          route,
          modeSource: resolved.source,
          sessionId,
          projectId: body.projectId,
          taskId: task?.id || body.taskId,
          ownerEpoch: task?.ownerEpoch ?? (Number.isInteger(Number(body.ownerEpoch)) ? Number(body.ownerEpoch) : null),
        });
        const policy = buildPolicy({ mode: resolved.mode, role, routeActor: route.actor, workerExtraTools: config.workerExtraTools, verifierExtraTools: config.verifierExtraTools });
        const modelRoute = store.resolveRouteConfig(resolved.mode, role);
        const event = await store.appendEvent({ type: 'route.decided', ...redact(route), role, agentId, modeSource: resolved.source, sessionId: sessionId || null, projectId: body.projectId || null, taskId: task?.id || null });
        return json(res, 200, { route, policy, modelRoute, role, modeSource: resolved.source, task, eventId: event.id });
      }

      if (pathname === '/api/tasks/prepare' && req.method === 'POST') {
        if (!requireAgent(req, res)) return;
        const body = await readJson(req, 128 * 1024);
        const parentAgentId = validateIdentifier(body.parentAgentId, 'parent_agent_id', { required: true });
        if (resolveAgentRole(parentAgentId, config) !== 'main') return json(res, 403, { error: 'only_main_can_prepare_worker' });
        const parentRunId = validateIdentifier(body.parentRunId, 'parent_run_id', { required: true });
        const parentBinding = store.validateRouteBinding(parentRunId, parentAgentId, body.parentSessionId || '');
        if (!parentBinding.valid) return json(res, 409, { error: parentBinding.reason });
        if (parentBinding.decision.route?.actor !== 'worker') return json(res, 409, { error: 'parent_route_not_delegated' });
        const targetAgentId = validateIdentifier(body.targetAgentId, 'target_agent_id', { required: true });
        const targetRole = resolveAgentRole(targetAgentId, config);
        if (!['worker', 'verifier'].includes(targetRole)) return json(res, 409, { error: 'target_agent_not_worker_or_verifier' });
        const properties = parentBinding.decision.route?.properties || {};
        const task = await store.prepareWorkerTask({
          kind: body.kind === 'quick' ? 'quick' : store.inferTaskKind(properties),
          role: targetRole,
          mode: parentBinding.decision.route.mode,
          targetAgentId,
          task: body.task,
          properties,
          parent: {
            agentId: parentAgentId,
            runId: parentRunId,
            sessionId: body.parentSessionId,
            sessionKey: body.parentSessionKey,
            projectId: parentBinding.decision.projectId,
          },
          provenance: {
            pluginInstanceId: body.instanceId,
            toolCallId: body.toolCallId,
            createdBy: 'main',
            openclawVersion: body.openclawVersion,
          },
        });
        const hardSeconds = Math.max(1, Math.floor((Date.parse(task.lease.hardDeadline) - Date.now()) / 1000));
        return json(res, 201, {
          task,
          spawn: {
            agentId: task.route.targetAgentId,
            model: task.route.modelRef || undefined,
            thinking: task.route.thinking && task.route.thinking !== 'auto' ? task.route.thinking : undefined,
            runTimeoutSeconds: hardSeconds,
          },
        });
      }

      if (pathname === '/api/tasks/bind' && req.method === 'POST') {
        if (!requireAgent(req, res)) return;
        const body = await readJson(req, 64 * 1024);
        const task = await store.bindWorkerTask({
          id: body.taskId, ownerEpoch: Number(body.ownerEpoch), agentId: body.agentId, runId: body.runId,
          sessionId: body.sessionId, sessionKey: body.sessionKey, threadId: body.threadId, turnId: body.turnId,
          pluginInstanceId: body.instanceId,
        });
        return json(res, 200, { ok: true, task });
      }

      if (pathname === '/api/tasks/heartbeat' && req.method === 'POST') {
        if (!requireAgent(req, res)) return;
        const body = redact(await readJson(req, 64 * 1024));
        const task = await store.heartbeatWorkerTask({
          id: body.taskId, ownerEpoch: Number(body.ownerEpoch), agentId: body.agentId, runId: body.runId,
          sessionId: body.sessionId, meaningful: body.meaningful === true, phase: body.phase, summary: body.summary, eventType: body.eventType,
        });
        return json(res, 200, { ok: true, task });
      }

      if (pathname === '/api/tasks/terminal' && req.method === 'POST') {
        if (!requireAgent(req, res)) return;
        const body = redact(await readJson(req, 64 * 1024));
        const task = await store.finishWorkerTask({ id: body.taskId, ownerEpoch: Number(body.ownerEpoch), outcome: body.outcome, error: body.error, reviewPoint: body.reviewPoint });
        return json(res, 200, { ok: true, task });
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
          : binding.decision?.modeSource === 'worker-task'
            ? { mode: binding.decision.route.mode, source: 'worker-task' }
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

        if (role === 'worker' || role === 'verifier') {
          const taskId = body.taskId || binding.decision?.taskId;
          const ownerEpoch = body.ownerEpoch ?? binding.decision?.ownerEpoch;
          const lease = store.validateWorkerLease({ id: taskId, ownerEpoch, agentId, runId: body.runId, sessionId: body.sessionId || '' });
          if (!lease.valid) {
            const denied = { allowed: false, reason: lease.reason, normalizedTool: String(body.tool || '').toLowerCase(), taskId };
            await store.appendEvent({ type: 'tool.blocked', role, agentId, tool: denied.normalizedTool, runId: body.runId || null, taskId, reason: denied.reason });
            return json(res, 200, denied);
          }
        }

        const effectiveSessionId = binding.decision?.sessionId || body.sessionId;
        const effectiveProjectId = binding.decision?.projectId || body.projectId;
        const baseResolved = store.resolveMode({ sessionId: effectiveSessionId, projectId: effectiveProjectId, includeTask: false });
        const resolved = binding.decision?.modeSource === 'task'
          ? { mode: binding.decision.route.mode, source: 'task-run-binding' }
          : binding.decision?.modeSource === 'worker-task'
            ? { mode: binding.decision.route.mode, source: 'worker-task' }
            : baseResolved;
        const routeActor = binding.decision?.route?.actor || (resolved.mode === 'main' ? 'main' : role === 'main' ? 'worker' : role);
        const policy = buildPolicy({ mode: resolved.mode, role, routeActor, workerExtraTools: config.workerExtraTools, verifierExtraTools: config.verifierExtraTools });
        const decision = toolDecision(policy, body.tool);
        if (body.hook === 'before_tool_call') await store.markToolCheckObserved({ instanceId: body.instanceId });
        if (!decision.allowed || config.auditAllowedTools) {
          await store.appendEvent({ type: decision.allowed ? 'tool.allowed' : 'tool.blocked', role, agentId, tool: decision.normalizedTool, mode: resolved.mode, runId: body.runId || null, sessionId: effectiveSessionId || null, taskId: binding.decision?.taskId || null, reason: decision.reason });
        }
        return json(res, 200, { ...decision, policy, role, routeActor, mode: resolved.mode, modeSource: resolved.source, taskId: binding.decision?.taskId || null });
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
