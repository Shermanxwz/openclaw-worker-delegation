import crypto from 'node:crypto';
import net from 'node:net';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

function list(value, fallback) {
  return Array.isArray(value) && value.length ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))] : fallback;
}

function roleFor(agentId, config) {
  if (config.mainAgentIds.includes(agentId)) return 'main';
  if (config.workerAgentIds.includes(agentId)) return 'worker';
  if (config.verifierAgentIds.includes(agentId)) return 'verifier';
  return 'unknown';
}

function sessionIdentity(agentId, ctx = {}) {
  return String(ctx.sessionId || ctx.sessionKey || `${agentId}:unknown`);
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

export default definePluginEntry({
  id: 'delegation-guard',
  name: 'Delegation Guard',
  description: 'Hard-gates OpenClaw tool calls through the delegation control plane.',
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
    let heartbeatTimer = null;

    function token() { return process.env[config.tokenEnv] || ''; }

    function configuredModelFor(agentId) {
      const agent = api.config?.agents?.list?.find?.((candidate) => candidate?.id === agentId);
      const model = agent?.model;
      if (typeof model === 'string') return model;
      if (model && typeof model.primary === 'string') return model.primary;
      return null;
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
        if (!response.ok) throw new Error(`controller returned ${response.status}`);
        return await response.json();
      } finally {
        clearTimeout(timer);
      }
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
        main: mainEntry,
        workers,
        enforcement: { routeWired: true, toolCheckWired: true },
        sessionId: mainEntry.sessionId || null,
        source: 'delegation-guard-plugin',
      };
    }

    async function publishRuntime() {
      try { await request('/api/runtime-status', runtimePayload()); }
      catch (error) { api.logger.warn(`runtime heartbeat failed: ${error.message}`); }
    }

    api.on('before_prompt_build', async (event, ctx) => {
      const agentId = String(ctx.agentId || '');
      if (!agentId) return;
      try {
        const result = await request('/api/route', {
          hook: 'before_prompt_build',
          agentId,
          runId: ctx.runId || event.runId || '',
          sessionId: ctx.sessionId || ctx.sessionKey || '',
          task: String(event.prompt || '').slice(0, 20_000),
        });
        const route = result.route || {};
        return {
          appendSystemContext: `[Delegation control]\nMode: ${route.mode}. Assigned actor: ${route.actor}. Decision: ${route.decision}. Obey the runtime tool gate. When actor=worker, the main agent must delegate execution instead of attempting file, web, or runtime body-work.`,
        };
      } catch (error) {
        api.logger.error(`route check failed: ${error.message}`);
        if (config.failMode === 'closed') {
          return { appendSystemContext: '[Delegation control unavailable]\nFail-closed mode is active. Do not call any tool. Answer without tools or report that controller access must be restored.' };
        }
      }
    }, { priority: 90, timeoutMs: Math.min(15_000, config.requestTimeoutMs + 1500) });

    api.on('before_tool_call', async (event, ctx) => {
      const agentId = String(ctx.agentId || '');
      const tool = String(event.toolName || '');
      try {
        const result = await request('/api/tool-check', {
          hook: 'before_tool_call',
          agentId,
          runId: ctx.runId || event.runId || '',
          sessionId: ctx.sessionId || ctx.sessionKey || '',
          tool,
          toolKind: event.toolKind || ctx.toolKind || null,
          toolInputKind: event.toolInputKind || ctx.toolInputKind || null,
          toolCallId: event.toolCallId || null,
        });
        if (!result.allowed) return { block: true, blockReason: `Delegation control blocked ${tool}: ${result.reason}` };
      } catch (error) {
        api.logger.error(`tool gate failed for ${tool}: ${error.message}`);
        if (config.failMode === 'closed') {
          return { block: true, blockReason: `Delegation control unavailable; fail-closed blocked ${tool}` };
        }
      }
    }, { priority: 100, timeoutMs: Math.min(15_000, config.requestTimeoutMs + 1500) });

    api.on('after_tool_call', async (event, ctx) => {
      try {
        await request('/api/events', {
          type: event.error ? 'tool.failed' : 'tool.completed',
          agentId: ctx.agentId || null,
          role: roleFor(String(ctx.agentId || ''), config),
          tool: event.toolName || null,
          runId: ctx.runId || event.runId || null,
          sessionId: ctx.sessionId || ctx.sessionKey || null,
          durationMs: event.durationMs || null,
        });
      } catch {}
    });

    api.on('model_call_started', async (event, ctx) => {
      const agentId = String(ctx.agentId || 'unknown');
      const key = sessionIdentity(agentId, ctx);
      models.set(key, {
        agentId, id: key, role: roleFor(agentId, config), model: event.model || null,
        configuredModel: configuredModelFor(agentId), provider: event.provider || null,
        status: 'running', sessionId: ctx.sessionId || ctx.sessionKey || null,
      });
      await publishRuntime();
    });

    api.on('model_call_ended', async (event, ctx) => {
      const agentId = String(ctx.agentId || 'unknown');
      const key = sessionIdentity(agentId, ctx);
      const existing = models.get(key) || { agentId, id: key, role: roleFor(agentId, config), configuredModel: configuredModelFor(agentId) };
      models.set(key, {
        ...existing, model: event.model || existing.model || null, provider: event.provider || existing.provider || null,
        status: event.outcome === 'error' ? 'error' : 'idle', sessionId: ctx.sessionId || ctx.sessionKey || existing.sessionId || null,
      });
      await publishRuntime();
    });

    api.on('subagent_spawned', async (event) => {
      const key = String(event.childSessionKey || event.runId || crypto.randomUUID());
      const agentId = String(event.agentId || config.workerAgentIds[0]);
      models.set(key, {
        agentId, id: key, role: roleFor(agentId, config) === 'unknown' ? 'worker' : roleFor(agentId, config),
        model: event.resolvedModel || null, configuredModel: configuredModelFor(agentId),
        provider: event.resolvedProvider || null, status: 'running', sessionId: event.childSessionKey || null,
      });
      await publishRuntime();
    });

    api.on('subagent_ended', async (event) => {
      const key = String(event.targetSessionKey || '');
      const existing = models.get(key);
      if (existing) models.set(key, { ...existing, status: event.outcome === 'error' ? 'error' : 'ended' });
      await publishRuntime();
    });

    api.on('gateway_start', async () => {
      await publishRuntime();
      heartbeatTimer = setInterval(publishRuntime, config.heartbeatSeconds * 1000);
      heartbeatTimer.unref?.();
    });

    api.on('gateway_stop', () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    });
  },
});
