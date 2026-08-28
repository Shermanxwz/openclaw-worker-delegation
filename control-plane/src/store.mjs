import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const validModes = new Set(['worker', 'auto', 'main']);
const validScopes = new Set(['global', 'project', 'session', 'task']);
const validTaskRoles = new Set(['worker', 'verifier']);
const terminalTaskStates = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const activeTaskStates = new Set(['queued', 'starting', 'running', 'reviewing']);
const clone = (value) => JSON.parse(JSON.stringify(value));
const cleanText = (value, max = 200) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
const isExpired = (entry, now) => Boolean(entry?.expiresAt && Date.parse(entry.expiresAt) <= now);

function emptyRuntimeStatus() {
  return {
    instanceId: null,
    pluginLoaded: false,
    openclawVersion: null,
    main: { model: null, configuredModel: null, provider: null, status: 'unknown', sessionId: null, agentId: null },
    workers: [],
    reportedEnforcement: { routeWired: false, toolCheckWired: false },
    observedEnforcement: { routeAt: null, toolCheckAt: null, instanceId: null },
    sessionId: null,
    projectId: null,
    updatedAt: null,
    source: null,
  };
}

function emptyRegistry() {
  return { revision: null, source: null, openclawVersion: null, providers: [], models: [], agents: [], updatedAt: null };
}

function emptyRoutingProfiles() {
  return {
    worker: { main: {}, worker: {}, verifier: {} },
    auto: { main: {}, worker: {}, verifier: {} },
    main: { main: {} },
  };
}

function sanitizeError(error) {
  if (!error) return null;
  if (typeof error === 'string') return { code: 'runtime_error', message: error.slice(0, 500) };
  return {
    code: cleanText(error.code, 120) || cleanText(error.name, 120) || 'runtime_error',
    message: cleanText(error.message, 500) || 'worker task failed',
  };
}

function splitModelRef(modelRef) {
  const text = cleanText(modelRef, 300);
  if (!text) return { provider: null, model: null, modelRef: null };
  const slash = text.indexOf('/');
  if (slash <= 0 || slash === text.length - 1) return { provider: null, model: text, modelRef: text };
  return { provider: text.slice(0, slash), model: text.slice(slash + 1), modelRef: text };
}

function taskEvent(type, now, data = {}) {
  return { at: new Date(now).toISOString(), type, ...data };
}

export class StateStore {
  constructor({
    dataDir,
    defaultMode = 'auto',
    maxEvents = 4000,
    runtimeStaleSeconds = 90,
    routeDecisionTtlSeconds = 3900,
    workerTaskStandardMaxSeconds = 3600,
    workerTaskQuickMaxSeconds = 600,
    workerTaskLeaseSeconds = 300,
    workerTaskGraceSeconds = 60,
    workerHeartbeatStaleSeconds = 45,
    workerMaxRecords = 2000,
    now = () => Date.now(),
  }) {
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, 'state.json');
    this.eventsPath = path.join(dataDir, 'events.ndjson');
    this.defaultMode = defaultMode;
    this.maxEvents = maxEvents;
    this.runtimeStaleMs = runtimeStaleSeconds * 1000;
    this.routeDecisionTtlMs = routeDecisionTtlSeconds * 1000;
    // Product contracts are hard ceilings even if StateStore is constructed
    // directly without loadConfig().
    this.workerTaskStandardMaxMs = Math.min(3600, Math.max(60, Number(workerTaskStandardMaxSeconds) || 3600)) * 1000;
    this.workerTaskQuickMaxMs = Math.min(600, Math.max(30, Number(workerTaskQuickMaxSeconds) || 600)) * 1000;
    this.workerTaskLeaseMs = Math.min(900, Math.max(30, Number(workerTaskLeaseSeconds) || 300)) * 1000;
    this.workerTaskGraceMs = Math.min(180, Math.max(0, Number(workerTaskGraceSeconds) || 60)) * 1000;
    this.workerHeartbeatStaleMs = Math.min(180, Math.max(10, Number(workerHeartbeatStaleSeconds) || 45)) * 1000;
    this.workerMaxRecords = Math.min(20_000, Math.max(100, Number(workerMaxRecords) || 2000));
    this.now = now;
    this.listeners = new Set();
    this.writeChain = Promise.resolve();
    this.eventWritesSinceCompact = 0;
    this.state = {
      version: 6,
      global: { mode: defaultMode, updatedAt: new Date(now()).toISOString(), actor: 'bootstrap' },
      projects: {},
      sessions: {},
      tasks: {},
      routeDecisions: {},
      workerTasks: {},
      registry: emptyRegistry(),
      routingProfiles: emptyRoutingProfiles(),
      runtime: emptyRuntimeStatus(),
    };
    this.events = [];
  }

  enqueue(operation) {
    const run = this.writeChain.then(operation, operation);
    this.writeChain = run.catch(() => {});
    return run;
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const loaded = JSON.parse(await fs.readFile(this.statePath, 'utf8'));
      this.state = {
        ...this.state,
        ...loaded,
        version: 6,
        projects: loaded.projects || {},
        sessions: loaded.sessions || {},
        tasks: loaded.tasks || {},
        routeDecisions: loaded.routeDecisions || {},
        workerTasks: loaded.workerTasks || {},
        registry: { ...emptyRegistry(), ...(loaded.registry || {}) },
        routingProfiles: {
          ...emptyRoutingProfiles(),
          ...(loaded.routingProfiles || {}),
          worker: { ...emptyRoutingProfiles().worker, ...(loaded.routingProfiles?.worker || {}) },
          auto: { ...emptyRoutingProfiles().auto, ...(loaded.routingProfiles?.auto || {}) },
          main: { ...emptyRoutingProfiles().main, ...(loaded.routingProfiles?.main || {}) },
        },
        runtime: {
          ...emptyRuntimeStatus(),
          ...(loaded.runtime || {}),
          main: { ...emptyRuntimeStatus().main, ...(loaded.runtime?.main || {}) },
          reportedEnforcement: { ...emptyRuntimeStatus().reportedEnforcement, ...(loaded.runtime?.reportedEnforcement || loaded.runtime?.enforcement || {}) },
          // Hook observations prove calls reached this controller process and
          // must never survive a controller restart.
          observedEnforcement: { ...emptyRuntimeStatus().observedEnforcement },
          workers: Array.isArray(loaded.runtime?.workers) ? loaded.runtime.workers : [],
        },
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.persistState();
    }
    try {
      const lines = (await fs.readFile(this.eventsPath, 'utf8')).split('\n').filter(Boolean);
      const parsed = [];
      let malformed = false;
      for (const line of lines.slice(-this.maxEvents * 2)) {
        try { parsed.push(JSON.parse(line)); } catch { malformed = true; }
      }
      this.events = parsed.slice(-this.maxEvents);
      if (malformed || lines.length > this.maxEvents) await this.compactEvents();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await this.purgeExpired();
  }

  async persistState() {
    return this.enqueue(async () => {
      const temporary = `${this.statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, this.statePath);
    });
  }

  async compactEvents() {
    return this.enqueue(async () => {
      const temporary = `${this.eventsPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const text = this.events.map((event) => JSON.stringify(event)).join('\n');
      await fs.writeFile(temporary, text ? `${text}\n` : '', { mode: 0o600 });
      await fs.rename(temporary, this.eventsPath);
      this.eventWritesSinceCompact = 0;
    });
  }

  taskHeartbeatFresh(task, now = this.now()) {
    const heartbeatAt = Date.parse(task?.progress?.heartbeatAt || task?.createdAt || 0);
    return Boolean(heartbeatAt && now - heartbeatAt <= this.workerHeartbeatStaleMs);
  }

  taskScopeMatches(task, scope, id = '') {
    if (scope === 'global') return true;
    if (scope === 'project') return Boolean(id && task?.parent?.projectId === id);
    if (scope === 'session') return Boolean(id && (task?.parent?.sessionId === id || task?.parent?.sessionKey === id));
    return false;
  }

  async purgeExpired() {
    const now = this.now();
    let changed = false;
    for (const collection of [this.state.projects, this.state.sessions, this.state.tasks]) {
      for (const [id, entry] of Object.entries(collection)) {
        if (isExpired(entry, now)) { delete collection[id]; changed = true; }
      }
    }
    if (isExpired(this.state.global, now)) {
      this.state.global = { mode: this.defaultMode, updatedAt: new Date(now).toISOString(), actor: 'expiry' };
      changed = true;
    }
    for (const [runId, decision] of Object.entries(this.state.routeDecisions || {})) {
      if (!decision.createdAt || now - decision.createdAt > this.routeDecisionTtlMs) {
        delete this.state.routeDecisions[runId];
        changed = true;
      }
    }
    for (const task of Object.values(this.state.workerTasks || {})) {
      if (terminalTaskStates.has(task.state)) continue;
      const hardDeadline = Date.parse(task.lease?.hardDeadline || 0);
      const leaseExpiry = Date.parse(task.lease?.expiresAt || 0);
      const graceUntil = Date.parse(task.lease?.graceUntil || task.lease?.expiresAt || 0);
      if (hardDeadline && hardDeadline <= now) {
        this.expireTaskInMemory(task, 'hard_deadline_exceeded');
        changed = true;
      } else if (!this.taskHeartbeatFresh(task, now) && graceUntil && graceUntil <= now) {
        this.expireTaskInMemory(task, 'heartbeat_stale');
        changed = true;
      } else if (leaseExpiry && leaseExpiry <= now && graceUntil && graceUntil <= now) {
        this.expireTaskInMemory(task, 'lease_and_grace_exhausted');
        changed = true;
      }
    }
    this.trimWorkerTasks();
    if (changed) await this.persistState();
  }

  resolveMode({ sessionId = '', projectId = '', taskMode = '', includeTask = true } = {}) {
    const now = this.now();
    if (validModes.has(taskMode)) return { mode: taskMode, source: 'task-preview', entry: { mode: taskMode } };
    const task = includeTask && sessionId ? this.state.tasks[sessionId] : null;
    if (task && !isExpired(task, now)) return { mode: task.mode, source: 'task', entry: clone(task) };
    const session = sessionId ? this.state.sessions[sessionId] : null;
    if (session && !isExpired(session, now)) return { mode: session.mode, source: 'session', entry: clone(session) };
    const project = projectId ? this.state.projects[projectId] : null;
    if (project && !isExpired(project, now)) return { mode: project.mode, source: 'project', entry: clone(project) };
    const global = this.state.global;
    if (global && !isExpired(global, now)) return { mode: global.mode || this.defaultMode, source: 'global', entry: clone(global) };
    return { mode: this.defaultMode, source: global ? 'default-after-expiry' : 'default', entry: { mode: this.defaultMode } };
  }

  async consumeMode({ sessionId = '', projectId = '' } = {}) {
    const resolved = this.resolveMode({ sessionId, projectId });
    if (resolved.source !== 'task') return resolved;
    delete this.state.tasks[sessionId];
    await this.persistState();
    await this.appendEvent({ type: 'mode.consumed', scope: 'task', scopeId: sessionId, mode: resolved.mode, actor: 'runtime' });
    return resolved;
  }

  async setMode({ scope, id = '', mode, ttlMinutes = 0, actor = 'user', persistent = false }) {
    if (!validScopes.has(scope)) throw Object.assign(new Error(`Invalid scope: ${scope}`), { statusCode: 400 });
    if (!validModes.has(mode)) throw Object.assign(new Error(`Invalid mode: ${mode}`), { statusCode: 400 });
    if (scope !== 'global' && (!id || id.length > 200)) throw Object.assign(new Error(`${scope} mode requires a valid id`), { statusCode: 400 });
    const now = this.now();
    const isPersistent = Boolean(persistent) && ttlMinutes === 0;
    const entry = { mode, updatedAt: new Date(now).toISOString(), actor, ...(ttlMinutes > 0 ? { expiresAt: new Date(now + ttlMinutes * 60_000).toISOString() } : {}), ...(isPersistent ? { persistent: true } : {}) };
    if (scope === 'global') this.state.global = entry;
    if (scope === 'project') this.state.projects[id] = entry;
    if (scope === 'session') this.state.sessions[id] = entry;
    if (scope === 'task') this.state.tasks[id] = entry;

    // MAIN fences only the selected authority scope. A one-shot MAIN override
    // applies to the next Main route and must never kill unrelated work.
    if (mode === 'main' && scope !== 'task') {
      for (const task of Object.values(this.state.workerTasks)) {
        if (!terminalTaskStates.has(task.state) && this.taskScopeMatches(task, scope, id)) {
          task.state = 'cancelled';
          task.ownerEpoch = Number(task.ownerEpoch || 1) + 1;
          task.updatedAt = new Date(now).toISOString();
          task.terminal = { outcome: 'cancelled', endedAt: task.updatedAt, error: { code: 'mode_fenced', message: `MAIN mode fenced ${scope} delegated work` } };
          this.pushTaskEvent(task, taskEvent('task.fenced', now, { reason: 'main_mode', scope, scopeId: id || null }));
        }
      }
    }

    await this.persistState();
    await this.appendEvent({ type: 'mode.changed', scope, scopeId: id || null, mode, actor, expiresAt: entry.expiresAt || null, persistent: isPersistent });
    return clone(entry);
  }

  async clearMode({ scope, id = '', actor = 'user' }) {
    if (!['project', 'session', 'task'].includes(scope) || !id) throw Object.assign(new Error('Only task/project/session overrides can be cleared'), { statusCode: 400 });
    if (scope === 'project') delete this.state.projects[id];
    if (scope === 'session') delete this.state.sessions[id];
    if (scope === 'task') delete this.state.tasks[id];
    await this.persistState();
    await this.appendEvent({ type: 'mode.cleared', scope, scopeId: id, actor });
  }

  async updateRuntimeStatus({ instanceId = '', pluginLoaded = false, openclawVersion = '', main = {}, workers = [], enforcement = {}, sessionId = '', projectId = '', source = 'openclaw-plugin' } = {}) {
    const normalizedWorkers = Array.isArray(workers) ? workers.slice(0, 100).map((worker = {}) => ({
      id: cleanText(worker.id), model: cleanText(worker.model), configuredModel: cleanText(worker.configuredModel),
      provider: cleanText(worker.provider), role: cleanText(worker.role) || 'worker', status: cleanText(worker.status) || 'unknown',
      sessionId: cleanText(worker.sessionId), agentId: cleanText(worker.agentId), taskId: cleanText(worker.taskId),
    })) : [];
    const previousFingerprint = JSON.stringify({ main: this.state.runtime.main, workers: this.state.runtime.workers, instanceId: this.state.runtime.instanceId, reported: this.state.runtime.reportedEnforcement });
    const normalizedInstanceId = cleanText(instanceId, 100);
    const normalizedMain = {
      model: cleanText(main.model), configuredModel: cleanText(main.configuredModel), provider: cleanText(main.provider),
      status: cleanText(main.status) || 'unknown', sessionId: cleanText(main.sessionId || sessionId), agentId: cleanText(main.agentId),
    };
    const normalizedSessionId = cleanText(sessionId);
    const normalizedProjectId = cleanText(projectId);
    const currentRuntime = this.state.runtime || emptyRuntimeStatus();
    const currentUpdatedAt = currentRuntime.updatedAt ? Date.parse(currentRuntime.updatedAt) : 0;
    const currentFresh = Boolean(currentUpdatedAt && this.now() - currentUpdatedAt <= this.runtimeStaleMs);
    const currentObserved = currentRuntime.observedEnforcement || {};
    const incomingHasRuntimeIdentity = Boolean(normalizedMain.model || normalizedMain.provider || normalizedMain.sessionId || normalizedSessionId || normalizedWorkers.length);
    const currentHasRuntimeIdentity = Boolean(currentRuntime.main?.model || currentRuntime.main?.provider || currentRuntime.main?.sessionId || currentRuntime.sessionId || currentRuntime.workers?.length || currentObserved.routeAt || currentObserved.toolCheckAt);
    const incomingIsDifferentLowSignalInstance = normalizedInstanceId && normalizedInstanceId !== currentRuntime.instanceId && !incomingHasRuntimeIdentity;
    if (currentFresh && currentHasRuntimeIdentity && incomingIsDifferentLowSignalInstance) return clone(currentRuntime);

    const instanceChanged = normalizedInstanceId && normalizedInstanceId !== currentRuntime.instanceId;
    this.state.runtime = {
      instanceId: normalizedInstanceId,
      pluginLoaded: pluginLoaded === true,
      openclawVersion: cleanText(openclawVersion, 80),
      main: normalizedMain,
      workers: normalizedWorkers,
      reportedEnforcement: { routeWired: enforcement.routeWired === true, toolCheckWired: enforcement.toolCheckWired === true },
      observedEnforcement: instanceChanged
        ? { routeAt: null, toolCheckAt: null, instanceId: normalizedInstanceId }
        : { ...currentRuntime.observedEnforcement, instanceId: normalizedInstanceId || currentRuntime.observedEnforcement.instanceId },
      sessionId: normalizedSessionId,
      projectId: normalizedProjectId,
      updatedAt: new Date(this.now()).toISOString(),
      source: cleanText(source) || 'openclaw-plugin',
    };
    await this.persistState();
    const nextFingerprint = JSON.stringify({ main: this.state.runtime.main, workers: this.state.runtime.workers, instanceId: this.state.runtime.instanceId, reported: this.state.runtime.reportedEnforcement });
    if (previousFingerprint !== nextFingerprint) {
      await this.appendEvent({ type: 'runtime.changed', mainModel: this.state.runtime.main.model, activeWorkers: normalizedWorkers.filter((worker) => worker.status === 'running').length, instanceId: normalizedInstanceId });
    }
    return clone(this.state.runtime);
  }

  async markRouteObserved({ instanceId = '', runId = '', agentId = '', route = null, modeSource = '', sessionId = '', projectId = '', taskId = '', ownerEpoch = null } = {}) {
    const at = new Date(this.now()).toISOString();
    let changed = false;
    if (instanceId && instanceId === this.state.runtime.instanceId) {
      this.state.runtime.observedEnforcement = { ...this.state.runtime.observedEnforcement, routeAt: at, instanceId };
      changed = true;
    }
    if (runId && route) {
      this.state.routeDecisions[runId] = {
        route: clone(route), modeSource, agentId, sessionId, projectId,
        taskId: cleanText(taskId), ownerEpoch: Number.isInteger(ownerEpoch) ? ownerEpoch : null,
        createdAt: this.now(), instanceId,
      };
      changed = true;
    }
    if (changed) await this.persistState();
  }

  async markToolCheckObserved({ instanceId = '' } = {}) {
    if (instanceId && instanceId === this.state.runtime.instanceId) {
      this.state.runtime.observedEnforcement = { ...this.state.runtime.observedEnforcement, toolCheckAt: new Date(this.now()).toISOString(), instanceId };
      await this.persistState();
    }
  }

  cleanupRouteDecisions() {
    const cutoff = this.now() - this.routeDecisionTtlMs;
    for (const [runId, decision] of Object.entries(this.state.routeDecisions || {})) {
      if (!decision.createdAt || decision.createdAt < cutoff) delete this.state.routeDecisions[runId];
    }
  }

  getRouteDecision(runId) {
    this.cleanupRouteDecisions();
    return runId && this.state.routeDecisions[runId] ? clone(this.state.routeDecisions[runId]) : null;
  }

  validateRouteBinding(runId, agentId, sessionId = '') {
    if (!runId) return { decision: null, valid: false, reason: 'route_run_missing' };
    const decision = this.getRouteDecision(runId);
    if (!decision) return { decision: null, valid: false, reason: 'route_binding_missing' };
    if (decision.agentId !== agentId) return { decision, valid: false, reason: 'route_agent_mismatch' };
    if (sessionId && decision.sessionId && decision.sessionId !== sessionId) return { decision, valid: false, reason: 'route_session_mismatch' };
    return { decision, valid: true, reason: null };
  }

  async updateRegistry({ revision = '', source = 'openclaw-plugin', openclawVersion = '', providers = [], models = [], agents = [] } = {}) {
    const normalizedModels = Array.isArray(models) ? models.slice(0, 2000).map((entry = {}) => {
      const modelRef = cleanText(entry.ref || entry.modelRef, 300);
      const split = splitModelRef(modelRef);
      const levels = Array.isArray(entry.thinkingLevels) ? entry.thinkingLevels.slice(0, 16).map((level) => {
        if (typeof level === 'string') return { id: cleanText(level, 40), label: cleanText(level, 80) };
        return { id: cleanText(level?.id, 40), label: cleanText(level?.label || level?.id, 80) };
      }).filter((level) => level.id) : [];
      return {
        ref: modelRef,
        provider: cleanText(entry.provider, 120) || split.provider,
        model: cleanText(entry.model, 180) || split.model,
        name: cleanText(entry.name, 240) || split.model,
        thinkingLevels: levels,
        thinkingDefault: cleanText(entry.thinkingDefault, 40),
        configured: entry.configured !== false,
      };
    }).filter((entry) => entry.ref) : [];
    const normalizedProviders = Array.isArray(providers) ? providers.slice(0, 500).map((entry = {}) => ({
      id: cleanText(entry.id, 120), name: cleanText(entry.name || entry.id, 200),
    })).filter((entry) => entry.id) : [];
    const normalizedAgents = Array.isArray(agents) ? agents.slice(0, 200).map((entry = {}) => ({
      agentId: cleanText(entry.agentId, 160), role: cleanText(entry.role, 40), configuredModel: cleanText(entry.configuredModel, 300),
      provider: cleanText(entry.provider, 120), model: cleanText(entry.model, 180), thinkingDefault: cleanText(entry.thinkingDefault, 40),
    })).filter((entry) => entry.agentId) : [];
    this.state.registry = {
      revision: cleanText(revision, 160) || crypto.createHash('sha256').update(JSON.stringify({ normalizedProviders, normalizedModels, normalizedAgents })).digest('hex').slice(0, 16),
      source: cleanText(source, 80) || 'openclaw-plugin',
      openclawVersion: cleanText(openclawVersion, 80),
      providers: normalizedProviders,
      models: normalizedModels,
      agents: normalizedAgents,
      updatedAt: new Date(this.now()).toISOString(),
    };
    await this.persistState();
    return clone(this.state.registry);
  }

  registrySnapshot() { return clone(this.state.registry || emptyRegistry()); }

  resolveRouteConfig(mode, role) {
    const profile = this.state.routingProfiles?.[mode]?.[role] || {};
    const registry = this.state.registry || emptyRegistry();
    const registeredAgent = registry.agents.find((entry) => entry.role === role) || null;
    const modelRef = cleanText(profile.modelRef, 300) || cleanText(registeredAgent?.configuredModel, 300);
    const split = splitModelRef(modelRef);
    const modelEntry = registry.models.find((entry) => entry.ref === modelRef) || null;
    const requestedThinking = cleanText(profile.thinking, 40) || 'auto';
    const supported = (modelEntry?.thinkingLevels || []).map((entry) => entry.id);
    const thinking = requestedThinking === 'auto' || supported.includes(requestedThinking) ? requestedThinking : 'auto';
    return {
      modelRef,
      provider: split.provider || modelEntry?.provider || registeredAgent?.provider || null,
      model: split.model || modelEntry?.model || registeredAgent?.model || null,
      thinking,
      // Upstream did not declare levels => only Auto is a valid UI/control
      // plane choice. Never synthesize provider-specific reasoning tiers.
      thinkingLevels: supported.length ? clone(modelEntry.thinkingLevels) : [{ id: 'auto', label: 'Auto' }],
      thinkingDefault: modelEntry?.thinkingDefault || registeredAgent?.thinkingDefault || null,
      source: profile.modelRef ? 'routing-profile' : 'openclaw-config',
    };
  }

  async setRoutingProfile({ mode, role, modelRef = '', thinking = 'auto', actor = 'web' }) {
    if (!validModes.has(mode)) throw Object.assign(new Error('invalid_routing_mode'), { statusCode: 400 });
    const allowedRoles = mode === 'main' ? ['main'] : ['main', 'worker', 'verifier'];
    if (!allowedRoles.includes(role)) throw Object.assign(new Error('invalid_routing_role'), { statusCode: 400 });
    const normalizedRef = cleanText(modelRef, 300) || '';
    const normalizedThinking = cleanText(thinking, 40) || 'auto';
    if (normalizedRef) {
      const model = this.state.registry.models.find((entry) => entry.ref === normalizedRef);
      if (!model) throw Object.assign(new Error('model_not_in_openclaw_registry'), { statusCode: 409 });
      const supported = (model.thinkingLevels || []).map((entry) => entry.id);
      if (normalizedThinking !== 'auto' && !supported.includes(normalizedThinking)) {
        throw Object.assign(new Error('thinking_level_not_supported'), { statusCode: 409 });
      }
    } else if (normalizedThinking !== 'auto') {
      throw Object.assign(new Error('thinking_requires_explicit_model'), { statusCode: 409 });
    }
    this.state.routingProfiles[mode] ??= {};
    this.state.routingProfiles[mode][role] = {
      modelRef: normalizedRef || null,
      thinking: normalizedThinking,
      updatedAt: new Date(this.now()).toISOString(),
      actor,
      registryRevision: this.state.registry.revision,
    };
    await this.persistState();
    await this.appendEvent({ type: 'routing.changed', mode, role, modelRef: normalizedRef || null, thinking: normalizedThinking, actor });
    return clone(this.state.routingProfiles[mode][role]);
  }

  routingSnapshot() { return clone(this.state.routingProfiles || emptyRoutingProfiles()); }

  inferTaskKind(properties = {}) {
    if (properties.requiresMutation || properties.requiresExec || properties.requiresMultiFileRead || properties.likelyRetryLoop || properties.heavyPlanning) return 'standard';
    return 'quick';
  }

  pushTaskEvent(task, event) {
    task.events ??= [];
    task.events.push(event);
    if (task.events.length > 200) task.events.splice(0, task.events.length - 200);
  }

  trimWorkerTasks() {
    const entries = Object.entries(this.state.workerTasks || {});
    if (entries.length <= this.workerMaxRecords) return;
    const removable = entries
      .filter(([, task]) => terminalTaskStates.has(task.state))
      .sort((a, b) => Date.parse(a[1].updatedAt || a[1].createdAt || 0) - Date.parse(b[1].updatedAt || b[1].createdAt || 0));
    while (Object.keys(this.state.workerTasks).length > this.workerMaxRecords && removable.length) {
      const [id] = removable.shift();
      delete this.state.workerTasks[id];
    }
  }

  expireTaskInMemory(task, reason) {
    const now = this.now();
    task.state = 'expired';
    task.ownerEpoch = Number(task.ownerEpoch || 1) + 1;
    task.updatedAt = new Date(now).toISOString();
    task.terminal = { outcome: 'expired', endedAt: task.updatedAt, error: { code: reason, message: reason.replaceAll('_', ' ') } };
    this.pushTaskEvent(task, taskEvent('task.expired', now, { reason }));
  }

  async prepareWorkerTask({ kind = 'standard', role = 'worker', mode = 'auto', targetAgentId = '', parent = {}, task = '', properties = {}, provenance = {} } = {}) {
    if (!validTaskRoles.has(role)) throw Object.assign(new Error('invalid_worker_role'), { statusCode: 400 });
    const normalizedKind = kind === 'quick' ? 'quick' : 'standard';
    const now = this.now();
    const hardLimitMs = normalizedKind === 'quick' ? this.workerTaskQuickMaxMs : this.workerTaskStandardMaxMs;
    const hardDeadline = now + hardLimitMs;
    const leaseExpiry = Math.min(now + this.workerTaskLeaseMs, hardDeadline);
    const id = `wrk_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const route = this.resolveRouteConfig(mode, role);
    const record = {
      id,
      kind: normalizedKind,
      role,
      state: 'queued',
      ownerEpoch: 1,
      task: cleanText(task, 4000),
      properties: clone(properties || {}),
      parent: {
        agentId: cleanText(parent.agentId, 160), runId: cleanText(parent.runId, 200), sessionId: cleanText(parent.sessionId, 200),
        sessionKey: cleanText(parent.sessionKey, 300), projectId: cleanText(parent.projectId, 200),
      },
      execution: { agentId: cleanText(targetAgentId, 160), runId: null, sessionId: null, sessionKey: null, threadId: null, turnId: null },
      route: { ...route, mode, targetAgentId: cleanText(targetAgentId, 160) },
      provenance: {
        pluginInstanceId: cleanText(provenance.pluginInstanceId, 120),
        parentRouteRunId: cleanText(parent.runId, 200),
        toolCallId: cleanText(provenance.toolCallId, 200),
        createdBy: cleanText(provenance.createdBy, 80) || 'main',
        openclawVersion: cleanText(provenance.openclawVersion, 80),
      },
      lease: {
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(leaseExpiry).toISOString(),
        hardDeadline: new Date(hardDeadline).toISOString(),
        graceUntil: new Date(Math.min(leaseExpiry + this.workerTaskGraceMs, hardDeadline)).toISOString(),
        extensions: 0,
      },
      progress: { seq: 0, meaningfulSeq: 0, phase: 'queued', heartbeatAt: new Date(now).toISOString(), meaningfulAt: null, summary: null },
      review: { reviewPoint: null, verifierTaskId: null },
      terminal: null,
      events: [taskEvent('task.prepared', now, { role, kind: normalizedKind })],
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    this.state.workerTasks[id] = record;
    this.trimWorkerTasks();
    await this.persistState();
    await this.appendEvent({ type: 'worker.prepared', taskId: id, role, kind: normalizedKind, mode, parentRunId: record.parent.runId, modelRef: route.modelRef });
    return clone(record);
  }

  getWorkerTask(id) {
    const task = id ? this.state.workerTasks[id] : null;
    return task ? clone(task) : null;
  }

  listWorkerTasks({ limit = 100, activeOnly = false } = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 100, 500));
    return Object.values(this.state.workerTasks || {})
      .filter((task) => !activeOnly || activeTaskStates.has(task.state))
      .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))
      .slice(0, max)
      .map(clone);
  }

  async bindWorkerTask({ id, ownerEpoch, agentId = '', runId = '', sessionId = '', sessionKey = '', threadId = '', turnId = '', pluginInstanceId = '' } = {}) {
    const task = this.state.workerTasks[id];
    if (!task) throw Object.assign(new Error('worker_task_not_found'), { statusCode: 404 });
    if (Number(ownerEpoch) !== task.ownerEpoch) throw Object.assign(new Error('worker_owner_epoch_mismatch'), { statusCode: 409 });
    if (terminalTaskStates.has(task.state)) throw Object.assign(new Error('worker_task_terminal'), { statusCode: 409 });
    if (task.execution.agentId && agentId && task.execution.agentId !== agentId) throw Object.assign(new Error('worker_agent_mismatch'), { statusCode: 409 });
    if (Date.parse(task.lease.hardDeadline) <= this.now()) {
      this.expireTaskInMemory(task, 'hard_deadline_exceeded');
      await this.persistState();
      throw Object.assign(new Error('worker_task_expired'), { statusCode: 409 });
    }
    const now = this.now();
    task.state = task.role === 'verifier' ? 'reviewing' : 'running';
    task.execution = {
      ...task.execution,
      agentId: cleanText(agentId, 160) || task.execution.agentId,
      runId: cleanText(runId, 200) || task.execution.runId,
      sessionId: cleanText(sessionId, 200) || task.execution.sessionId,
      sessionKey: cleanText(sessionKey, 300) || task.execution.sessionKey,
      threadId: cleanText(threadId, 200) || task.execution.threadId,
      turnId: cleanText(turnId, 200) || task.execution.turnId,
    };
    if (pluginInstanceId) task.provenance.pluginInstanceId = cleanText(pluginInstanceId, 120);
    task.progress.heartbeatAt = new Date(now).toISOString();
    task.progress.phase = task.role === 'verifier' ? 'reviewing' : 'running';
    task.updatedAt = new Date(now).toISOString();
    this.pushTaskEvent(task, taskEvent('task.bound', now, { runId: task.execution.runId, sessionId: task.execution.sessionId, sessionKey: task.execution.sessionKey }));
    await this.persistState();
    await this.appendEvent({ type: 'worker.bound', taskId: id, role: task.role, agentId: task.execution.agentId, runId: task.execution.runId, sessionId: task.execution.sessionId });
    return clone(task);
  }

  validateWorkerLease({ id, ownerEpoch, agentId = '', runId = '', sessionId = '' } = {}) {
    const task = id ? this.state.workerTasks[id] : null;
    if (!task) return { valid: false, reason: 'worker_task_not_found', task: null };
    if (Number(ownerEpoch) !== task.ownerEpoch) return { valid: false, reason: 'worker_owner_epoch_mismatch', task: clone(task) };
    if (terminalTaskStates.has(task.state)) return { valid: false, reason: `worker_task_${task.state}`, task: clone(task) };
    const now = this.now();
    if (Date.parse(task.lease.hardDeadline) <= now) return { valid: false, reason: 'worker_hard_deadline_exceeded', task: clone(task) };
    if (!this.taskHeartbeatFresh(task, now)) return { valid: false, reason: 'worker_heartbeat_stale', task: clone(task) };
    const graceEnd = Date.parse(task.lease.graceUntil || task.lease.expiresAt);
    if (graceEnd <= now) return { valid: false, reason: 'worker_lease_expired', task: clone(task) };
    if (task.execution.agentId && agentId && task.execution.agentId !== agentId) return { valid: false, reason: 'worker_agent_mismatch', task: clone(task) };
    if (task.execution.runId && runId && task.execution.runId !== runId) return { valid: false, reason: 'worker_run_mismatch', task: clone(task) };
    if (task.execution.sessionId && sessionId && task.execution.sessionId !== sessionId) return { valid: false, reason: 'worker_session_mismatch', task: clone(task) };
    return { valid: true, reason: null, task: clone(task) };
  }

  async heartbeatWorkerTask({ id, ownerEpoch, agentId = '', runId = '', sessionId = '', meaningful = false, phase = '', summary = '', eventType = 'heartbeat' } = {}) {
    const task = this.state.workerTasks[id];
    if (!task) throw Object.assign(new Error('worker_task_not_found'), { statusCode: 404 });
    if (Number(ownerEpoch) !== task.ownerEpoch) throw Object.assign(new Error('worker_owner_epoch_mismatch'), { statusCode: 409 });
    if (terminalTaskStates.has(task.state)) return clone(task);
    if (task.execution.agentId && agentId && task.execution.agentId !== agentId) throw Object.assign(new Error('worker_agent_mismatch'), { statusCode: 409 });
    if (task.execution.runId && runId && task.execution.runId !== runId) throw Object.assign(new Error('worker_run_mismatch'), { statusCode: 409 });
    if (task.execution.sessionId && sessionId && task.execution.sessionId !== sessionId) throw Object.assign(new Error('worker_session_mismatch'), { statusCode: 409 });

    const now = this.now();
    const hardDeadline = Date.parse(task.lease.hardDeadline);
    if (hardDeadline <= now) {
      this.expireTaskInMemory(task, 'hard_deadline_exceeded');
      await this.persistState();
      return clone(task);
    }
    const graceUntil = Date.parse(task.lease.graceUntil || task.lease.expiresAt);
    if (Date.parse(task.lease.expiresAt) <= now && now > graceUntil) {
      this.expireTaskInMemory(task, 'lease_and_grace_exhausted');
      await this.persistState();
      return clone(task);
    }

    task.progress.seq = Number(task.progress.seq || 0) + 1;
    task.progress.heartbeatAt = new Date(now).toISOString();
    if (phase) task.progress.phase = cleanText(phase, 120);
    if (summary) task.progress.summary = cleanText(summary, 500);
    if (meaningful === true) {
      task.progress.meaningfulSeq = Number(task.progress.meaningfulSeq || 0) + 1;
      task.progress.meaningfulAt = new Date(now).toISOString();
      const nextLease = Math.min(now + this.workerTaskLeaseMs, hardDeadline);
      task.lease.expiresAt = new Date(nextLease).toISOString();
      task.lease.graceUntil = new Date(Math.min(nextLease + this.workerTaskGraceMs, hardDeadline)).toISOString();
      task.lease.extensions = Number(task.lease.extensions || 0) + 1;
    }
    task.updatedAt = new Date(now).toISOString();
    this.pushTaskEvent(task, taskEvent(`task.${cleanText(eventType, 80) || 'heartbeat'}`, now, { meaningful: meaningful === true, phase: task.progress.phase }));
    await this.persistState();
    return clone(task);
  }

  async finishWorkerTask({ id, ownerEpoch, outcome = 'succeeded', error = null, reviewPoint = '' } = {}) {
    const task = this.state.workerTasks[id];
    if (!task) throw Object.assign(new Error('worker_task_not_found'), { statusCode: 404 });
    if (Number(ownerEpoch) !== task.ownerEpoch) throw Object.assign(new Error('worker_owner_epoch_mismatch'), { statusCode: 409 });
    if (terminalTaskStates.has(task.state)) return clone(task);
    const normalizedOutcome = ['succeeded', 'failed', 'cancelled', 'expired'].includes(outcome) ? outcome : 'failed';
    const now = this.now();
    task.state = normalizedOutcome;
    task.updatedAt = new Date(now).toISOString();
    if (reviewPoint) task.review.reviewPoint = cleanText(reviewPoint, 500);
    task.terminal = { outcome: normalizedOutcome, endedAt: task.updatedAt, error: sanitizeError(error) };
    this.pushTaskEvent(task, taskEvent(`task.${normalizedOutcome}`, now, { error: task.terminal.error }));
    await this.persistState();
    await this.appendEvent({ type: `worker.${normalizedOutcome}`, taskId: id, role: task.role, runId: task.execution.runId, error: task.terminal.error });
    return clone(task);
  }

  async rootTaskAction({ id, action, minutes = 5, actor = 'root-control' } = {}) {
    const task = this.state.workerTasks[id];
    if (!task) throw Object.assign(new Error('worker_task_not_found'), { statusCode: 404 });
    if (action === 'cancel') {
      if (terminalTaskStates.has(task.state)) return clone(task);
      const now = this.now();
      task.state = 'cancelled';
      task.ownerEpoch = Number(task.ownerEpoch || 1) + 1;
      task.updatedAt = new Date(now).toISOString();
      task.terminal = { outcome: 'cancelled', endedAt: task.updatedAt, error: { code: 'root_cancel', message: `${actor} cancelled task` } };
      this.pushTaskEvent(task, taskEvent('task.cancelled', now, { reason: 'root_cancel', actor }));
      await this.persistState();
      await this.appendEvent({ type: 'worker.cancelled', taskId: id, role: task.role, runId: task.execution.runId, error: task.terminal.error });
      return clone(task);
    }
    if (action !== 'extend') throw Object.assign(new Error('invalid_task_action'), { statusCode: 400 });
    if (terminalTaskStates.has(task.state)) throw Object.assign(new Error('worker_task_terminal'), { statusCode: 409 });
    const now = this.now();
    const hardDeadline = Date.parse(task.lease.hardDeadline);
    const extensionMs = Math.max(1, Math.min(Number(minutes) || 5, 15)) * 60_000;
    const nextLease = Math.min(Math.max(Date.parse(task.lease.expiresAt), now) + extensionMs, hardDeadline);
    if (nextLease <= now) throw Object.assign(new Error('worker_hard_deadline_exceeded'), { statusCode: 409 });
    task.lease.expiresAt = new Date(nextLease).toISOString();
    task.lease.graceUntil = new Date(Math.min(nextLease + this.workerTaskGraceMs, hardDeadline)).toISOString();
    task.lease.extensions = Number(task.lease.extensions || 0) + 1;
    // Root extension is an emergency liveness assertion. It does not count as
    // meaningful model progress but prevents an immediate stale-heartbeat gate.
    task.progress.heartbeatAt = new Date(now).toISOString();
    task.updatedAt = new Date(now).toISOString();
    this.pushTaskEvent(task, taskEvent('task.root_extended', now, { actor, minutes: Math.ceil(extensionMs / 60_000) }));
    await this.persistState();
    await this.appendEvent({ type: 'worker.root_extended', taskId: id, actor, expiresAt: task.lease.expiresAt });
    return clone(task);
  }

  async appendEvent(event) {
    const normalized = { id: event.id || crypto.randomUUID(), at: event.at || new Date(this.now()).toISOString(), ...event };
    await this.enqueue(async () => {
      this.events.push(normalized);
      if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
      await fs.appendFile(this.eventsPath, `${JSON.stringify(normalized)}\n`, { mode: 0o600 });
      this.eventWritesSinceCompact += 1;
    });
    if (this.eventWritesSinceCompact >= 100) await this.compactEvents();
    for (const listener of this.listeners) listener(clone(normalized));
    return clone(normalized);
  }

  listEvents(limit = 100) { return clone(this.events.slice(-Math.max(1, Math.min(Number(limit) || 100, 500))).reverse()); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  enforcementSnapshot() {
    const runtime = this.state.runtime || emptyRuntimeStatus();
    const heartbeatFresh = Boolean(runtime.updatedAt && this.now() - Date.parse(runtime.updatedAt) <= this.runtimeStaleMs);
    const observed = runtime.observedEnforcement || {};
    const sameInstance = Boolean(runtime.instanceId && observed.instanceId === runtime.instanceId);
    const hard = heartbeatFresh && runtime.pluginLoaded === true && runtime.reportedEnforcement.routeWired === true && runtime.reportedEnforcement.toolCheckWired === true && sameInstance && Boolean(observed.routeAt) && Boolean(observed.toolCheckAt);
    return { state: hard ? 'hard' : 'advisory', hard, heartbeatFresh, routeObserved: sameInstance && Boolean(observed.routeAt), toolCheckObserved: sameInstance && Boolean(observed.toolCheckAt) };
  }

  snapshot({ sessionId = '', projectId = '' } = {}) {
    const resolved = this.resolveMode({ sessionId, projectId });
    const activeTasks = Object.values(this.state.workerTasks || {}).filter((task) => activeTaskStates.has(task.state));
    return {
      resolvedMode: resolved,
      globalMode: clone(this.state.global),
      projectMode: projectId ? clone(this.state.projects[projectId] || null) : null,
      taskMode: sessionId ? clone(this.state.tasks[sessionId] || null) : null,
      sessionMode: sessionId ? clone(this.state.sessions[sessionId] || null) : null,
      routingProfiles: this.routingSnapshot(),
      registry: this.registrySnapshot(),
      runtimeStatus: { ...clone(this.state.runtime || emptyRuntimeStatus()), enforcement: this.enforcementSnapshot() },
      workerSummary: {
        active: activeTasks.length,
        queued: activeTasks.filter((task) => task.state === 'queued').length,
        running: activeTasks.filter((task) => task.state === 'running').length,
        reviewing: activeTasks.filter((task) => task.state === 'reviewing').length,
        failed: Object.values(this.state.workerTasks || {}).filter((task) => task.state === 'failed').length,
      },
      metrics: {
        totalEvents: this.events.length,
        blockedMainActions: this.events.filter((event) => event.type === 'tool.blocked' && event.role === 'main').length,
        allowedToolCalls: this.events.filter((event) => event.type === 'tool.allowed').length,
        routeToWorker: this.events.filter((event) => event.type === 'route.decided' && event.role === 'main' && event.actor === 'worker').length,
        routeToMain: this.events.filter((event) => event.type === 'route.decided' && event.role === 'main' && event.actor === 'main').length,
        workerFailures: this.events.filter((event) => event.type === 'worker.failed').length,
      },
      latestRoute: clone(this.events.slice().reverse().find((event) => event.type === 'route.decided' && event.role === 'main') || null),
    };
  }
}
