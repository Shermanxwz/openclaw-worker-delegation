import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const validModes = new Set(['worker', 'auto', 'main']);
const validScopes = new Set(['global', 'project', 'session', 'task']);
const clone = (value) => JSON.parse(JSON.stringify(value));
const cleanText = (value, max = 200) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
const isExpired = (entry, now) => Boolean(entry?.expiresAt && Date.parse(entry.expiresAt) <= now);

function emptyRuntimeStatus() {
  return {
    instanceId: null,
    pluginLoaded: false,
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

export class StateStore {
  constructor({ dataDir, defaultMode = 'auto', maxEvents = 2000, runtimeStaleSeconds = 90, routeDecisionTtlSeconds = 900, now = () => Date.now() }) {
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, 'state.json');
    this.eventsPath = path.join(dataDir, 'events.ndjson');
    this.defaultMode = defaultMode;
    this.maxEvents = maxEvents;
    this.runtimeStaleMs = runtimeStaleSeconds * 1000;
    this.routeDecisionTtlMs = routeDecisionTtlSeconds * 1000;
    this.now = now;
    this.listeners = new Set();
    this.writeChain = Promise.resolve();
    this.eventWritesSinceCompact = 0;
    this.routeDecisions = new Map();
    this.state = {
      version: 4,
      global: { mode: defaultMode, updatedAt: new Date(now()).toISOString(), actor: 'bootstrap' },
      projects: {},
      sessions: {},
      tasks: {},
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
        projects: loaded.projects || {},
        sessions: loaded.sessions || {},
        tasks: loaded.tasks || {},
        runtime: {
          ...emptyRuntimeStatus(),
          ...(loaded.runtime || {}),
          main: { ...emptyRuntimeStatus().main, ...(loaded.runtime?.main || {}) },
          reportedEnforcement: { ...emptyRuntimeStatus().reportedEnforcement, ...(loaded.runtime?.reportedEnforcement || loaded.runtime?.enforcement || {}) },
          // Observations prove hooks reached this controller process. Never
          // carry them across a controller restart.
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

  async setMode({ scope, id = '', mode, ttlMinutes = 0, actor = 'user' }) {
    if (!validScopes.has(scope)) throw Object.assign(new Error(`Invalid scope: ${scope}`), { statusCode: 400 });
    if (!validModes.has(mode)) throw Object.assign(new Error(`Invalid mode: ${mode}`), { statusCode: 400 });
    if (scope !== 'global' && (!id || id.length > 200)) throw Object.assign(new Error(`${scope} mode requires a valid id`), { statusCode: 400 });
    const now = this.now();
    const entry = { mode, updatedAt: new Date(now).toISOString(), actor, ...(ttlMinutes > 0 ? { expiresAt: new Date(now + ttlMinutes * 60_000).toISOString() } : {}) };
    if (scope === 'global') this.state.global = entry;
    if (scope === 'project') this.state.projects[id] = entry;
    if (scope === 'session') this.state.sessions[id] = entry;
    if (scope === 'task') this.state.tasks[id] = entry;
    await this.persistState();
    await this.appendEvent({ type: 'mode.changed', scope, scopeId: id || null, mode, actor, expiresAt: entry.expiresAt || null });
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

  async updateRuntimeStatus({ instanceId = '', pluginLoaded = false, main = {}, workers = [], enforcement = {}, sessionId = '', projectId = '', source = 'openclaw-plugin' } = {}) {
    const normalizedWorkers = Array.isArray(workers) ? workers.slice(0, 100).map((worker = {}) => ({
      id: cleanText(worker.id), model: cleanText(worker.model), configuredModel: cleanText(worker.configuredModel),
      provider: cleanText(worker.provider), role: cleanText(worker.role) || 'worker', status: cleanText(worker.status) || 'unknown',
      sessionId: cleanText(worker.sessionId), agentId: cleanText(worker.agentId),
    })) : [];
    const previousFingerprint = JSON.stringify({ main: this.state.runtime.main, workers: this.state.runtime.workers, instanceId: this.state.runtime.instanceId, reported: this.state.runtime.reportedEnforcement });
    const normalizedInstanceId = cleanText(instanceId, 100);
    const instanceChanged = normalizedInstanceId && normalizedInstanceId !== this.state.runtime.instanceId;
    this.state.runtime = {
      instanceId: normalizedInstanceId,
      pluginLoaded: pluginLoaded === true,
      main: {
        model: cleanText(main.model), configuredModel: cleanText(main.configuredModel), provider: cleanText(main.provider),
        status: cleanText(main.status) || 'unknown', sessionId: cleanText(main.sessionId || sessionId), agentId: cleanText(main.agentId),
      },
      workers: normalizedWorkers,
      reportedEnforcement: { routeWired: enforcement.routeWired === true, toolCheckWired: enforcement.toolCheckWired === true },
      observedEnforcement: instanceChanged
        ? { routeAt: null, toolCheckAt: null, instanceId: normalizedInstanceId }
        : { ...this.state.runtime.observedEnforcement, instanceId: normalizedInstanceId || this.state.runtime.observedEnforcement.instanceId },
      sessionId: cleanText(sessionId), projectId: cleanText(projectId), updatedAt: new Date(this.now()).toISOString(), source: cleanText(source) || 'openclaw-plugin',
    };
    await this.persistState();
    const nextFingerprint = JSON.stringify({ main: this.state.runtime.main, workers: this.state.runtime.workers, instanceId: this.state.runtime.instanceId, reported: this.state.runtime.reportedEnforcement });
    if (previousFingerprint !== nextFingerprint) {
      await this.appendEvent({ type: 'runtime.changed', mainModel: this.state.runtime.main.model, activeWorkers: normalizedWorkers.filter((worker) => worker.status === 'running').length, instanceId: normalizedInstanceId });
    }
    return clone(this.state.runtime);
  }

  async markRouteObserved({ instanceId = '', runId = '', agentId = '', route = null, modeSource = '', sessionId = '', projectId = '' } = {}) {
    const at = new Date(this.now()).toISOString();
    if (instanceId && instanceId === this.state.runtime.instanceId) {
      this.state.runtime.observedEnforcement = { ...this.state.runtime.observedEnforcement, routeAt: at, instanceId };
      await this.persistState();
    }
    if (runId && route) this.routeDecisions.set(runId, { route: clone(route), modeSource, agentId, sessionId, projectId, createdAt: this.now(), instanceId });
    this.cleanupRouteDecisions();
  }

  async markToolCheckObserved({ instanceId = '' } = {}) {
    if (instanceId && instanceId === this.state.runtime.instanceId) {
      this.state.runtime.observedEnforcement = { ...this.state.runtime.observedEnforcement, toolCheckAt: new Date(this.now()).toISOString(), instanceId };
      await this.persistState();
    }
  }

  cleanupRouteDecisions() {
    const cutoff = this.now() - this.routeDecisionTtlMs;
    for (const [runId, decision] of this.routeDecisions) if (decision.createdAt < cutoff) this.routeDecisions.delete(runId);
  }

  getRouteDecision(runId) {
    this.cleanupRouteDecisions();
    return runId && this.routeDecisions.has(runId) ? clone(this.routeDecisions.get(runId)) : null;
  }

  validateRouteBinding(runId, agentId, sessionId = '') {
    const decision = this.getRouteDecision(runId);
    if (!decision) return { decision: null, valid: true, reason: null };
    if (decision.agentId !== agentId) return { decision, valid: false, reason: 'route_agent_mismatch' };
    if (sessionId && decision.sessionId && decision.sessionId !== sessionId) return { decision, valid: false, reason: 'route_session_mismatch' };
    return { decision, valid: true, reason: null };
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
    return {
      resolvedMode: resolved,
      globalMode: clone(this.state.global),
      projectMode: projectId ? clone(this.state.projects[projectId] || null) : null,
      taskMode: sessionId ? clone(this.state.tasks[sessionId] || null) : null,
      sessionMode: sessionId ? clone(this.state.sessions[sessionId] || null) : null,
      runtimeStatus: { ...clone(this.state.runtime || emptyRuntimeStatus()), enforcement: this.enforcementSnapshot() },
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
