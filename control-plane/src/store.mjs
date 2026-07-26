import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const validModes = new Set(['worker', 'auto', 'main']);
const validScopes = new Set(['global', 'project', 'session']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class StateStore {
  constructor({ dataDir, defaultMode = 'auto', maxEvents = 1000, now = () => Date.now() }) {
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, 'state.json');
    this.eventsPath = path.join(dataDir, 'events.ndjson');
    this.defaultMode = defaultMode;
    this.maxEvents = maxEvents;
    this.now = now;
    this.listeners = new Set();
    this.state = {
      version: 1,
      global: { mode: defaultMode, updatedAt: new Date(now()).toISOString(), actor: 'bootstrap' },
      projects: {},
      sessions: {},
    };
    this.events = [];
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      this.state = JSON.parse(await fs.readFile(this.statePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.persistState();
    }
    try {
      const text = await fs.readFile(this.eventsPath, 'utf8');
      this.events = text
        .split('\n')
        .filter(Boolean)
        .slice(-this.maxEvents)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  cleanupExpired() {
    const now = this.now();
    let changed = false;
    for (const collection of [this.state.projects, this.state.sessions]) {
      for (const [id, entry] of Object.entries(collection)) {
        if (entry.expiresAt && Date.parse(entry.expiresAt) <= now) {
          delete collection[id];
          changed = true;
        }
      }
    }
    return changed;
  }

  async persistState() {
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.statePath);
  }

  resolveMode({ sessionId = '', projectId = '', taskMode = '' } = {}) {
    this.cleanupExpired();
    if (validModes.has(taskMode)) return { mode: taskMode, source: 'task', entry: { mode: taskMode } };
    if (sessionId && this.state.sessions[sessionId]) {
      return { mode: this.state.sessions[sessionId].mode, source: 'session', entry: clone(this.state.sessions[sessionId]) };
    }
    if (projectId && this.state.projects[projectId]) {
      return { mode: this.state.projects[projectId].mode, source: 'project', entry: clone(this.state.projects[projectId]) };
    }
    return { mode: this.state.global?.mode || this.defaultMode, source: 'global', entry: clone(this.state.global) };
  }

  async setMode({ scope, id = '', mode, ttlMinutes = 0, actor = 'user' }) {
    if (!validScopes.has(scope)) throw new Error(`Invalid scope: ${scope}`);
    if (!validModes.has(mode)) throw new Error(`Invalid mode: ${mode}`);
    if (scope !== 'global' && !id) throw new Error(`${scope} mode requires an id`);

    const now = this.now();
    const entry = {
      mode,
      updatedAt: new Date(now).toISOString(),
      actor,
      ...(ttlMinutes > 0 ? { expiresAt: new Date(now + ttlMinutes * 60_000).toISOString() } : {}),
    };
    if (scope === 'global') this.state.global = entry;
    if (scope === 'project') this.state.projects[id] = entry;
    if (scope === 'session') this.state.sessions[id] = entry;
    await this.persistState();
    await this.appendEvent({
      type: 'mode.changed',
      scope,
      scopeId: id || null,
      mode,
      actor,
      expiresAt: entry.expiresAt || null,
    });
    return clone(entry);
  }

  async clearMode({ scope, id = '', actor = 'user' }) {
    if (scope === 'project') delete this.state.projects[id];
    else if (scope === 'session') delete this.state.sessions[id];
    else throw new Error('Only project/session overrides can be cleared');
    await this.persistState();
    await this.appendEvent({ type: 'mode.cleared', scope, scopeId: id, actor });
  }

  async appendEvent(event) {
    const normalized = {
      id: event.id || crypto.randomUUID(),
      at: event.at || new Date(this.now()).toISOString(),
      ...event,
    };
    this.events.push(normalized);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    await fs.appendFile(this.eventsPath, `${JSON.stringify(normalized)}\n`, { mode: 0o600 });
    for (const listener of this.listeners) listener(normalized);
    return clone(normalized);
  }

  listEvents(limit = 100) {
    return clone(this.events.slice(-Math.max(1, Math.min(limit, 500))).reverse());
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot({ sessionId = '', projectId = '' } = {}) {
    const resolved = this.resolveMode({ sessionId, projectId });
    const metrics = {
      totalEvents: this.events.length,
      blockedMainActions: this.events.filter((event) => event.type === 'tool.blocked' && event.role === 'main').length,
      routeToWorker: this.events.filter((event) => event.type === 'route.decided' && event.actor === 'worker').length,
      routeToMain: this.events.filter((event) => event.type === 'route.decided' && event.actor === 'main').length,
      workerFailures: this.events.filter((event) => event.type === 'worker.failed').length,
    };
    return {
      resolvedMode: resolved,
      globalMode: clone(this.state.global),
      projectMode: projectId ? clone(this.state.projects[projectId] || null) : null,
      sessionMode: sessionId ? clone(this.state.sessions[sessionId] || null) : null,
      metrics,
      latestRoute: clone(this.events.slice().reverse().find((event) => event.type === 'route.decided') || null),
    };
  }
}
