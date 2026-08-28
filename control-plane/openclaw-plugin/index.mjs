import crypto from 'node:crypto';
import net from 'node:net';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { resolveHookAgentId, resolveHookModel, resolveHookSessionId } from './runtime-identity.mjs';

const TASK_MARKER = /\[\[OCWD_TASK:([a-zA-Z0-9_\-]+):(\d+)\]\]/;

function list(value, fallback) {
  return Array.isArray(value) && value.length ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))] : fallback;
}

function roleFor(agentId, config) {
  if (config.mainAgentIds.includes(agentId)) return 'main';
  if (config.workerAgentIds.includes(agentId)) return 'worker';
  if (config.verifierAgentIds.includes(agentId)) return 'verifier';
  return 'unknown';
}

function isLoopbackController(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && (url.hostname === 'localhost' || url.hostname === '::1' || (net.isIP(url.hostname) === 4 && url.hostname.startsWith('127.')));
  } catch {
    return false;
  }
}

function firstString(...values) {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

function modelParts(modelRef = '') {
  const text = String(modelRef || '').trim();
  const slash = text.indexOf('/');
  if (slash <= 0) return { provider: '', model: text };
  return { provider: text.slice(0, slash), model: text.slice(slash + 1) };
}

function configuredAgent(cfg, agentId) {
  const entries = cfg?.agents?.entries;
  if (entries && !Array.isArray(entries) && typeof entries === 'object') return entries[agentId] || null;
  const legacy = cfg?.agents?.list;
  return Array.isArray(legacy) ? legacy.find((candidate) => candidate?.id === agentId) || null : null;
}

function configuredModel(agent) {
  const model = agent?.model;
  if (typeof model === 'string') return model;
  if (model && typeof model.primary === 'string') return model.primary;
  return null;
}

function parseTaskMarker(text = '') {
  const match = TASK_MARKER.exec(String(text || ''));
  return match ? { taskId: match[1], ownerEpoch: Number(match[2]) } : null;
}

function safeError(error) {
  return { code: firstString(error?.code, error?.name, 'runtime_error').slice(0, 120), message: firstString(error?.message, String(error || 'runtime error')).slice(0, 500) };
}

function deepField(value, names, depth = 0) {
  if (depth > 5 || value == null) return '';
  if (typeof value === 'string') {
    try { return deepField(JSON.parse(value), names, depth + 1); } catch { return ''; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepField(item, names, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  for (const name of names) {
    if (typeof value[name] === 'string' && value[name].trim()) return value[name].trim();
  }
  for (const child of Object.values(value)) {
    const found = deepField(child, names, depth + 1);
    if (found) return found;
  }
  return '';
}

export default definePluginEntry({
  id: 'delegation-guard',
  name: 'Delegation Guard',
  description: 'Native OpenClaw routing, model selection, lease fencing and task provenance bridge.',
  register(api) {
    const raw = api.pluginConfig || {};
    const config = {
      controllerUrl: String(raw.controllerUrl || 'http://127.0.0.1:8787').replace(/\/$/, ''),
      tokenEnv: String(raw.tokenEnv || 'OCWD_AGENT_TOKEN'),
      failMode: raw.failMode === 'open' ? 'open' : 'closed',
      allowRemoteController: raw.allowRemoteController === true,
      requestTimeoutMs: Math.min(10_000, Math.max(250, Number(raw.requestTimeoutMs) || 2500)),
      heartbeatSeconds: Math.min(300, Math.max(10, Number(raw.heartbeatSeconds) || 30)),
      mainAgentIds: list(raw.mainAgentIds, ['main']),
      workerAgentIds: list(raw.workerAgentIds, ['body-worker', 'worker']),
      verifierAgentIds: list(raw.verifierAgentIds, ['verifier']),
    };
    if (!config.allowRemoteController && !isLoopbackController(config.controllerUrl)) {
      throw new Error('delegation-guard controllerUrl must be loopback unless allowRemoteController=true');
    }

    const instanceId = crypto.randomUUID();
    const models = new Map();
    const routes = new Map();
    const runAliasBySession = new Map();
    const taskByRun = new Map();
    const taskBySession = new Map();
    const pendingSpawns = new Map();
    let heartbeatTimer = null;
    let registryFingerprint = '';

    function token() { return process.env[config.tokenEnv] || ''; }
    function runtimeConfig() { return api.runtime?.config?.current?.() || api.config || {}; }
    function openclawVersion() { return firstString(api.runtime?.version, 'unknown'); }

    function sessionKey(event = {}, ctx = {}) {
      return firstString(ctx.sessionKey, event.sessionKey, ctx.sessionId, event.sessionId);
    }

    function effectiveRunId(event = {}, ctx = {}) {
      const key = sessionKey(event, ctx);
      if (key && runAliasBySession.has(key)) return runAliasBySession.get(key);
      const hostRun = firstString(ctx.runId, event.runId);
      if (hostRun) return hostRun;
      const alias = `ocwd_${crypto.randomUUID().replaceAll('-', '')}`;
      if (key) runAliasBySession.set(key, alias);
      return alias;
    }

    function configuredModelFor(agentId) {
      return configuredModel(configuredAgent(runtimeConfig(), agentId));
    }

    function taskBinding(event = {}, ctx = {}, prompt = '') {
      const runId = effectiveRunId(event, ctx);
      const key = sessionKey(event, ctx);
      const marker = parseTaskMarker(prompt || event.prompt || '');
      if (marker) {
        taskByRun.set(runId, marker);
        if (key) taskBySession.set(key, marker);
        return marker;
      }
      return taskByRun.get(runId) || (key ? taskBySession.get(key) : null) || null;
    }

    async function request(path, body) {
      const secret = token();
      if (!secret) throw new Error(`${config.tokenEnv} is not configured`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
      timer.unref?.();
      try {
        const response = await fetch(`${config.controllerUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
          body: JSON.stringify({ ...body, instanceId }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || `controller returned ${response.status}`);
        }
        return await response.json();
      } finally {
        clearTimeout(timer);
      }
    }

    function buildRegistry() {
      const cfg = runtimeConfig();
      const providers = [];
      const modelsByRef = new Map();
      const providerConfig = cfg?.models?.providers || {};
      for (const [providerId, provider] of Object.entries(providerConfig)) {
        providers.push({ id: providerId, name: firstString(provider?.name, providerId) });
        for (const model of Array.isArray(provider?.models) ? provider.models : []) {
          const modelId = firstString(model?.id, model?.model, model?.name);
          if (!modelId) continue;
          const ref = `${providerId}/${modelId}`;
          modelsByRef.set(ref, { ref, provider: providerId, model: modelId, name: firstString(model?.name, modelId), configured: true });
        }
      }
      for (const ref of Object.keys(cfg?.agents?.defaults?.models || {})) {
        if (!modelsByRef.has(ref)) {
          const parts = modelParts(ref);
          modelsByRef.set(ref, { ref, provider: parts.provider, model: parts.model, name: parts.model, configured: true });
        }
      }

      const agentIds = [...new Set([...config.mainAgentIds, ...config.workerAgentIds, ...config.verifierAgentIds])];
      const agents = agentIds.map((agentId) => {
        const agent = configuredAgent(cfg, agentId);
        const modelRef = configuredModel(agent);
        if (modelRef && !modelsByRef.has(modelRef)) {
          const parts = modelParts(modelRef);
          modelsByRef.set(modelRef, { ref: modelRef, provider: parts.provider, model: parts.model, name: parts.model, configured: true });
        }
        const parts = modelParts(modelRef || '');
        let thinkingDefault = null;
        try {
          thinkingDefault = api.runtime?.agent?.resolveThinkingDefault?.({ cfg, provider: parts.provider, model: parts.model }) || null;
        } catch {}
        return { agentId, role: roleFor(agentId, config), configuredModel: modelRef, provider: parts.provider || null, model: parts.model || null, thinkingDefault };
      });

      for (const runtimeEntry of models.values()) {
        if (!runtimeEntry.provider || !runtimeEntry.model) continue;
        const ref = `${runtimeEntry.provider}/${runtimeEntry.model}`;
        if (!modelsByRef.has(ref)) modelsByRef.set(ref, { ref, provider: runtimeEntry.provider, model: runtimeEntry.model, name: runtimeEntry.model, configured: true });
      }

      const registryModels = [...modelsByRef.values()].map((entry) => {
        let policy = null;
        try { policy = api.runtime?.agent?.resolveThinkingPolicy?.({ provider: entry.provider, model: entry.model }) || null; } catch {}
        const thinkingLevels = Array.isArray(policy?.levels)
          ? policy.levels.map((level) => ({ id: firstString(level?.id, level), label: firstString(level?.label, level?.id, level) })).filter((level) => level.id)
          : [];
        const rawDefault = policy?.default?.id ?? policy?.default ?? policy?.defaultLevel ?? null;
        return { ...entry, thinkingLevels, thinkingDefault: typeof rawDefault === 'string' ? rawDefault : null };
      }).sort((a, b) => a.ref.localeCompare(b.ref));

      const payload = { source: 'openclaw-runtime', openclawVersion: openclawVersion(), providers, models: registryModels, agents };
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24);
      return { ...payload, revision: fingerprint };
    }

    async function publishRegistry({ force = false } = {}) {
      const registry = buildRegistry();
      if (!force && registry.revision === registryFingerprint) return;
      const response = await request('/api/registry-sync', registry);
      registryFingerprint = registry.revision;
      return response;
    }

    function runtimePayload() {
      const entries = [...models.values()];
      const mainEntry = entries.find((entry) => entry.role === 'main') || {
        agentId: config.mainAgentIds[0], id: config.mainAgentIds[0], role: 'main',
        configuredModel: configuredModelFor(config.mainAgentIds[0]), status: 'unknown',
      };
      const workers = entries.filter((entry) => entry.role === 'worker' || entry.role === 'verifier');
      return {
        instanceId,
        pluginLoaded: true,
        openclawVersion: openclawVersion(),
        main: mainEntry,
        workers,
        enforcement: { routeWired: true, toolCheckWired: true },
        sessionId: mainEntry.sessionId || null,
        source: 'delegation-guard-plugin',
      };
    }

    async function publishRuntime() {
      try {
        await request('/api/runtime-status', runtimePayload());
        await publishRegistry();
      } catch (error) {
        api.logger.warn(`runtime heartbeat failed: ${error.message}`);
      }
    }

    async function routeFor(event, ctx, prompt = '') {
      const agentId = resolveHookAgentId(event, ctx);
      if (!agentId) throw new Error('agent identity unavailable');
      const runId = effectiveRunId(event, ctx);
      const key = sessionKey(event, ctx);
      const binding = taskBinding(event, ctx, prompt);
      const result = await request('/api/route', {
        hook: 'before_model_resolve',
        agentId,
        runId,
        sessionId: resolveHookSessionId(event, ctx, agentId),
        sessionKey: key,
        projectId: firstString(ctx.projectId, event.projectId),
        task: String(prompt || event.prompt || '').slice(0, 20_000),
        taskId: binding?.taskId || '',
        ownerEpoch: binding?.ownerEpoch ?? null,
      });
      routes.set(runId, result);
      if (binding) {
        taskByRun.set(runId, binding);
        if (key) taskBySession.set(key, binding);
      }
      return { runId, agentId, binding, result };
    }

    api.on('before_model_resolve', async (event, ctx) => {
      try {
        const { result } = await routeFor(event, ctx, event.prompt || '');
        const modelRoute = result.modelRoute || {};
        if (!modelRoute.model) return;
        return {
          ...(modelRoute.provider ? { providerOverride: modelRoute.provider } : {}),
          modelOverride: modelRoute.model,
        };
      } catch (error) {
        api.logger.error(`route/model resolution failed: ${error.message}`);
        // before_model_resolve cannot block. before_agent_run and the tool gate
        // provide the actual fail-closed boundary for this turn.
      }
    }, { priority: 100, timeoutMs: Math.min(15_000, config.requestTimeoutMs + 1500) });

    api.on('before_prompt_build', async (event, ctx) => {
      const agentId = resolveHookAgentId(event, ctx);
      if (!agentId) return;
      const runId = effectiveRunId(event, ctx);
      try {
        const cached = routes.get(runId);
        const result = cached || (await routeFor(event, ctx, event.prompt || '')).result;
        const route = result.route || {};
        const task = result.task || null;
        const base = `[Delegation control]\nMode: ${route.mode}. Assigned actor: ${route.actor}. Decision: ${route.decision}.`;
        if (result.role === 'main' && route.actor === 'worker') {
          return { appendSystemContext: `${base}\nYou are the autonomous coordinator. Do not perform body-work yourself. Decompose as needed and use sessions_spawn with an allowed Worker agent. The control plugin will select the configured Worker model/thinking and hard timeout. After the Worker returns, independently inspect/review the result; use the verifier agent for risky or mutating work. Do not ask the user to choose whether delegation should happen.` };
        }
        if (result.role === 'worker') {
          return { appendSystemContext: `${base}\nDurable task: ${task?.id || route.taskId || 'unknown'}. You are body-worker execution. Work autonomously within the assigned task, report concrete progress, never spawn another agent, and stop if the lease/tool gate rejects an action.` };
        }
        if (result.role === 'verifier') {
          return { appendSystemContext: `${base}\nDurable task: ${task?.id || route.taskId || 'unknown'}. You are the independent verifier. Review evidence and output a concise pass/fail finding. Do not mutate state.` };
        }
        return { appendSystemContext: `${base}\nMain may answer this lightweight task directly. Obey the runtime tool gate.` };
      } catch (error) {
        api.logger.error(`prompt route context failed: ${error.message}`);
        if (config.failMode === 'closed') {
          return { appendSystemContext: '[Delegation control unavailable]\nFail-closed mode is active. Do not call tools or claim execution succeeded.' };
        }
      }
    }, { priority: 90, timeoutMs: Math.min(15_000, config.requestTimeoutMs + 1500) });

    api.on('before_agent_run', async (event, ctx) => {
      if (config.failMode !== 'closed') return;
      const runId = effectiveRunId(event, ctx);
      if (!routes.has(runId)) {
        return { outcome: 'block', reason: 'delegation_route_unavailable', message: 'Delegation control is unavailable; the run was stopped fail-closed.' };
      }
    }, { priority: 100 });

    api.on('before_tool_call', async (event, ctx) => {
      const agentId = resolveHookAgentId(event, ctx);
      const tool = String(event.toolName || '');
      const runId = effectiveRunId(event, ctx);
      const key = sessionKey(event, ctx);
      const binding = taskBinding(event, ctx);
      try {
        const gate = await request('/api/tool-check', {
          hook: 'before_tool_call',
          agentId,
          runId,
          sessionId: resolveHookSessionId(event, ctx, agentId),
          sessionKey: key,
          tool,
          toolKind: event.toolKind || ctx.toolKind || null,
          toolInputKind: event.toolInputKind || ctx.toolInputKind || null,
          toolCallId: event.toolCallId || null,
          taskId: binding?.taskId || '',
          ownerEpoch: binding?.ownerEpoch ?? null,
        });
        if (!gate.allowed) return { block: true, blockReason: `Delegation control blocked ${tool}: ${gate.reason}` };

        if (tool === 'sessions_spawn' && roleFor(agentId, config) === 'main') {
          const params = event.params && typeof event.params === 'object' ? event.params : {};
          const requestedTarget = firstString(params.agentId, config.workerAgentIds[0]);
          const targetRole = roleFor(requestedTarget, config);
          if (!['worker', 'verifier'].includes(targetRole)) {
            return { block: true, blockReason: `Delegation control rejected target agent ${requestedTarget}` };
          }
          const prepared = await request('/api/tasks/prepare', {
            parentAgentId: agentId,
            parentRunId: runId,
            parentSessionId: resolveHookSessionId(event, ctx, agentId),
            parentSessionKey: key,
            targetAgentId: requestedTarget,
            task: String(params.task || '').slice(0, 20_000),
            kind: params.kind === 'quick' ? 'quick' : undefined,
            toolCallId: event.toolCallId || null,
            openclawVersion: openclawVersion(),
          });
          const task = prepared.task;
          const marker = `[[OCWD_TASK:${task.id}:${task.ownerEpoch}]]`;
          const pendingKey = firstString(event.toolCallId, `${runId}:${task.id}`);
          pendingSpawns.set(pendingKey, task);
          return {
            params: {
              ...params,
              agentId: prepared.spawn?.agentId || requestedTarget,
              task: `${marker}\n${String(params.task || '')}`,
              ...(prepared.spawn?.model ? { model: prepared.spawn.model } : {}),
              ...(prepared.spawn?.thinking ? { thinking: prepared.spawn.thinking } : {}),
              runTimeoutSeconds: prepared.spawn?.runTimeoutSeconds || (task.kind === 'quick' ? 600 : 3600),
            },
          };
        }
      } catch (error) {
        api.logger.error(`tool gate failed for ${tool}: ${error.message}`);
        if (config.failMode === 'closed') return { block: true, blockReason: `Delegation control unavailable; fail-closed blocked ${tool}` };
      }
    }, { priority: 100, timeoutMs: Math.min(15_000, config.requestTimeoutMs + 1500) });

    api.on('after_tool_call', async (event, ctx) => {
      const agentId = resolveHookAgentId(event, ctx);
      const runId = effectiveRunId(event, ctx);
      const key = sessionKey(event, ctx);
      const binding = taskBinding(event, ctx);
      const toolCallKey = firstString(event.toolCallId);
      try {
        if (event.toolName === 'sessions_spawn' && toolCallKey && pendingSpawns.has(toolCallKey)) {
          const task = pendingSpawns.get(toolCallKey);
          pendingSpawns.delete(toolCallKey);
          if (event.error) {
            await request('/api/tasks/terminal', { taskId: task.id, ownerEpoch: task.ownerEpoch, outcome: 'failed', error: safeError(event.error) });
          } else {
            const childRunId = deepField(event.result, ['runId', 'run_id']);
            const childSessionKey = deepField(event.result, ['childSessionKey', 'sessionKey', 'child_session_key']);
            const childSessionId = deepField(event.result, ['sessionId', 'session_id']) || childSessionKey;
            const childBinding = { taskId: task.id, ownerEpoch: task.ownerEpoch };
            if (childRunId) taskByRun.set(childRunId, childBinding);
            if (childSessionKey) taskBySession.set(childSessionKey, childBinding);
            await request('/api/tasks/bind', {
              taskId: task.id,
              ownerEpoch: task.ownerEpoch,
              agentId: task.route?.targetAgentId,
              runId: childRunId,
              sessionId: childSessionId,
              sessionKey: childSessionKey,
            });
          }
        } else if (binding) {
          await request('/api/tasks/heartbeat', {
            taskId: binding.taskId,
            ownerEpoch: binding.ownerEpoch,
            agentId,
            runId,
            sessionId: resolveHookSessionId(event, ctx, agentId),
            meaningful: !event.error,
            phase: event.error ? 'tool-error' : 'tool-complete',
            eventType: event.error ? 'tool_failed' : 'tool_completed',
          });
        }
        await request('/api/events', {
          type: event.error ? 'tool.failed' : 'tool.completed',
          agentId: agentId || null,
          role: roleFor(agentId, config),
          tool: event.toolName || null,
          runId,
          sessionId: resolveHookSessionId(event, ctx, agentId) || null,
          taskId: binding?.taskId || null,
          durationMs: event.durationMs || null,
        });
      } catch (error) {
        api.logger.warn(`after_tool_call telemetry failed: ${error.message}`);
      }
    });

    api.on('model_call_started', async (event, ctx) => {
      const agentId = resolveHookAgentId(event, ctx);
      const sid = resolveHookSessionId(event, ctx, agentId);
      const key = sessionKey(event, ctx) || sid || `${agentId || 'unknown'}:${event.runId || event.callId || crypto.randomUUID()}`;
      const identity = resolveHookModel(event, ctx);
      const binding = taskBinding(event, ctx);
      models.set(key, {
        agentId: agentId || null,
        id: key,
        role: roleFor(agentId, config),
        model: identity.model || null,
        configuredModel: agentId ? configuredModelFor(agentId) : null,
        provider: identity.provider || null,
        status: 'running',
        sessionId: sid || null,
        taskId: binding?.taskId || null,
      });
      if (binding) {
        request('/api/tasks/heartbeat', { taskId: binding.taskId, ownerEpoch: binding.ownerEpoch, agentId, runId: effectiveRunId(event, ctx), sessionId: sid, meaningful: false, phase: 'model-running', eventType: 'model_started' }).catch(() => {});
      }
      await publishRuntime();
    });

    api.on('model_call_ended', async (event, ctx) => {
      const agentId = resolveHookAgentId(event, ctx);
      const sid = resolveHookSessionId(event, ctx, agentId);
      const key = sessionKey(event, ctx) || sid || `${agentId || 'unknown'}:${event.runId || event.callId || crypto.randomUUID()}`;
      const identity = resolveHookModel(event, ctx);
      const binding = taskBinding(event, ctx);
      const existing = models.get(key) || { agentId: agentId || null, id: key, role: roleFor(agentId, config), configuredModel: agentId ? configuredModelFor(agentId) : null };
      models.set(key, {
        ...existing,
        model: identity.model || existing.model || null,
        provider: identity.provider || existing.provider || null,
        status: event.outcome === 'error' ? 'error' : 'idle',
        sessionId: sid || existing.sessionId || null,
        taskId: binding?.taskId || existing.taskId || null,
      });
      if (binding) {
        request('/api/tasks/heartbeat', { taskId: binding.taskId, ownerEpoch: binding.ownerEpoch, agentId, runId: effectiveRunId(event, ctx), sessionId: sid, meaningful: event.outcome !== 'error', phase: event.outcome === 'error' ? 'model-error' : 'model-complete', eventType: 'model_ended' }).catch(() => {});
      }
      await publishRuntime();
    });

    api.on('subagent_spawned', async (event) => {
      const key = String(event.childSessionKey || event.runId || crypto.randomUUID());
      const agentId = String(event.agentId || config.workerAgentIds[0]);
      const binding = (event.runId ? taskByRun.get(String(event.runId)) : null) || taskBySession.get(key) || null;
      if (binding) {
        if (event.runId) taskByRun.set(String(event.runId), binding);
        taskBySession.set(key, binding);
      }
      models.set(key, {
        agentId,
        id: key,
        role: roleFor(agentId, config) === 'unknown' ? 'worker' : roleFor(agentId, config),
        model: event.resolvedModel || null,
        configuredModel: configuredModelFor(agentId),
        provider: event.resolvedProvider || null,
        status: 'running',
        sessionId: event.childSessionKey || null,
        taskId: binding?.taskId || null,
      });
      await publishRuntime();
    });

    api.on('subagent_ended', async (event) => {
      const key = String(event.targetSessionKey || '');
      const binding = taskBySession.get(key) || (event.runId ? taskByRun.get(String(event.runId)) : null) || null;
      const existing = models.get(key);
      if (existing) models.set(key, { ...existing, status: event.outcome === 'error' ? 'error' : 'ended' });
      if (binding) {
        const outcome = event.outcome === 'ok' ? 'succeeded'
          : ['killed', 'reset', 'deleted'].includes(event.outcome) ? 'cancelled'
            : event.outcome === 'timeout' ? 'expired' : 'failed';
        try {
          await request('/api/tasks/terminal', { taskId: binding.taskId, ownerEpoch: binding.ownerEpoch, outcome, error: event.error ? safeError(event.error) : null });
        } catch (error) {
          api.logger.warn(`task terminal update failed: ${error.message}`);
        }
        taskBySession.delete(key);
        if (event.runId) taskByRun.delete(String(event.runId));
      }
      await publishRuntime();
    });

    api.on('agent_end', async (event, ctx) => {
      const key = sessionKey(event, ctx);
      const runId = effectiveRunId(event, ctx);
      routes.delete(runId);
      if (key) runAliasBySession.delete(key);
    });

    async function heartbeatTasks() {
      const unique = new Map();
      for (const [runId, binding] of taskByRun) unique.set(`${binding.taskId}:${binding.ownerEpoch}`, { binding, runId });
      for (const { binding, runId } of unique.values()) {
        const runtimeEntry = [...models.values()].find((entry) => entry.taskId === binding.taskId);
        try {
          await request('/api/tasks/heartbeat', {
            taskId: binding.taskId,
            ownerEpoch: binding.ownerEpoch,
            agentId: runtimeEntry?.agentId || null,
            runId,
            sessionId: runtimeEntry?.sessionId || null,
            meaningful: false,
            phase: runtimeEntry?.status === 'running' ? 'running' : 'heartbeat',
            eventType: 'heartbeat',
          });
        } catch (error) {
          api.logger.warn(`task heartbeat failed for ${binding.taskId}: ${error.message}`);
        }
      }
    }

    api.on('gateway_start', async () => {
      await publishRuntime();
      await publishRegistry({ force: true }).catch((error) => api.logger.warn(`registry sync failed: ${error.message}`));
      heartbeatTimer = setInterval(async () => {
        await publishRuntime();
        await heartbeatTasks();
      }, config.heartbeatSeconds * 1000);
      heartbeatTimer.unref?.();
    });

    api.on('gateway_stop', () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    });
  },
});
