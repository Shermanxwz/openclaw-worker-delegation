const state = {
  csrf: '',
  source: null,
  page: document.body.dataset.page || 'home',
  totpRequired: false,
  status: null,
  registry: null,
  routingProfiles: null,
  routingDraft: new Map(),
  selectedTaskId: '',
  refreshTimer: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const scopeStorageKey = 'ocwd.control.scope.v2';

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) };
  if (options.method && options.method !== 'GET' && state.csrf) headers['x-csrf-token'] = state.csrf;
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/api/login') showAuth(false);
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status, data });
  return data;
}

function showAuth(authenticated) {
  $('#login-view')?.classList.toggle('hidden', authenticated);
  $('#app-view')?.classList.toggle('hidden', !authenticated);
}

function message(text = '', kind = 'normal') {
  const el = $('#page-message');
  if (!el) return;
  el.textContent = text;
  el.className = `page-message ${kind === 'error' ? 'error' : 'muted'}`;
}

function setConnection(label, kind = 'neutral') {
  const el = $('#connection');
  if (!el) return;
  el.textContent = label;
  el.className = `status-pill ${kind}`;
}

function dateText(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function relativeDeadline(value) {
  if (!value) return '—';
  const ms = Date.parse(value) - Date.now();
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return '已到期';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function restoreScope() {
  const scope = $('#scope');
  if (!scope) return;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(scopeStorageKey) || 'null'); } catch {}
  scope.value = ['global', 'project', 'session', 'task'].includes(saved?.scope) ? saved.scope : 'global';
  if ($('#scope-id')) $('#scope-id').value = typeof saved?.id === 'string' ? saved.id : '';
  applyScopeUi();
}

function persistScope() {
  if (!$('#scope')) return;
  try { localStorage.setItem(scopeStorageKey, JSON.stringify({ scope: $('#scope').value, id: $('#scope-id')?.value.trim() || '' })); } catch {}
}

function applyScopeUi() {
  if (!$('#scope')) return;
  $('#scope-id-label')?.classList.toggle('hidden', $('#scope').value === 'global');
}

function currentScope() {
  const scope = $('#scope')?.value || 'global';
  const id = $('#scope-id')?.value.trim() || '';
  return { scope, id };
}

function statusQuery() {
  const { scope, id } = currentScope();
  if (!id) return '';
  if (scope === 'project') return `?projectId=${encodeURIComponent(id)}`;
  if (scope === 'session' || scope === 'task') return `?sessionId=${encodeURIComponent(id)}`;
  return '';
}

function roleLabel(role) {
  return { main: 'Main', worker: 'Worker', verifier: 'Verifier' }[role] || role;
}

function roleHint(mode, role) {
  if (role === 'main' && mode === 'worker') return '协调 / 规划，不做实体工作';
  if (role === 'main' && mode === 'auto') return '轻量问答 + 自主路由';
  if (role === 'main') return '唯一执行主体';
  if (role === 'worker') return '隔离执行实体工作';
  return '独立复核（按风险调用）';
}

function rolesForMode(mode) {
  return mode === 'main' ? ['main'] : ['main', 'worker', 'verifier'];
}

function modelsForProvider(provider) {
  return (state.registry?.models || []).filter((model) => model.provider === provider);
}

function modelByRef(ref) {
  return (state.registry?.models || []).find((model) => model.ref === ref) || null;
}

function agentDefaultForRole(role) {
  return (state.registry?.agents || []).find((agent) => agent.role === role) || null;
}

function routingKey(mode, role) { return `${mode}:${role}`; }

function currentProfile(mode, role) {
  return state.routingDraft.get(routingKey(mode, role)) || state.routingProfiles?.[mode]?.[role] || {};
}

function setDraft(mode, role, patch) {
  const key = routingKey(mode, role);
  const previous = currentProfile(mode, role);
  state.routingDraft.set(key, { ...previous, ...patch });
  message('模型路由有未保存更改。');
}

function createOption(value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

function renderThinking(container, mode, role, modelRef, selected) {
  container.replaceChildren();
  const model = modelByRef(modelRef);
  const levels = model?.thinkingLevels || [];
  const choices = levels.length ? [{ id: 'auto', label: 'Auto' }, ...levels] : [{ id: 'auto', label: 'Auto' }];
  const normalized = choices.some((entry) => entry.id === selected) ? selected : 'auto';
  for (const choice of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `think-chip${choice.id === normalized ? ' active' : ''}`;
    button.textContent = choice.label || choice.id;
    button.dataset.thinking = choice.id;
    button.addEventListener('click', () => {
      setDraft(mode, role, { thinking: choice.id });
      renderThinking(container, mode, role, modelRef, choice.id);
    });
    container.append(button);
  }
  if (!levels.length) {
    const note = document.createElement('span');
    note.className = 'route-inline-note';
    note.textContent = '上游未声明档位';
    container.append(note);
  }
}

function renderRoleRoute(mode, role) {
  const profile = currentProfile(mode, role);
  const defaultAgent = agentDefaultForRole(role);
  const selectedRef = profile.modelRef || '';
  const selectedModel = modelByRef(selectedRef);
  const selectedProvider = selectedModel?.provider || '__official__';

  const card = document.createElement('section');
  card.className = 'role-route';
  const head = document.createElement('div');
  head.className = 'role-route-head';
  const title = document.createElement('div');
  const strong = document.createElement('strong'); strong.textContent = roleLabel(role);
  const small = document.createElement('small'); small.textContent = roleHint(mode, role);
  title.append(strong, small);
  const source = document.createElement('span'); source.className = 'source-badge'; source.textContent = selectedRef ? 'Runtime override' : 'OpenClaw';
  head.append(title, source);
  card.append(head);

  const fields = document.createElement('div'); fields.className = 'route-fields';
  const providerLabel = document.createElement('label'); providerLabel.textContent = 'Provider';
  const providerSelect = document.createElement('select');
  providerSelect.append(createOption('__official__', 'OpenClaw 当前配置'));
  const providerIds = [...new Set([...(state.registry?.providers || []).map((p) => p.id), ...(state.registry?.models || []).map((m) => m.provider).filter(Boolean)])].sort();
  for (const provider of providerIds) providerSelect.append(createOption(provider, provider));
  providerSelect.value = selectedProvider;
  providerLabel.append(providerSelect);

  const modelLabel = document.createElement('label'); modelLabel.textContent = 'Model';
  const modelSelect = document.createElement('select');
  function populateModels(provider, preferredRef = '') {
    modelSelect.replaceChildren();
    if (provider === '__official__') {
      const configured = defaultAgent?.configuredModel ? ` · ${defaultAgent.configuredModel}` : '';
      modelSelect.append(createOption('', `跟随 OpenClaw${configured}`));
      modelSelect.disabled = true;
      modelSelect.value = '';
      return '';
    }
    modelSelect.disabled = false;
    const available = modelsForProvider(provider);
    if (!available.length) {
      modelSelect.append(createOption('', '该 Provider 暂无已同步模型'));
      return '';
    }
    for (const model of available) modelSelect.append(createOption(model.ref, model.name && model.name !== model.model ? `${model.name} · ${model.model}` : model.model || model.ref));
    const next = available.some((model) => model.ref === preferredRef) ? preferredRef : available[0].ref;
    modelSelect.value = next;
    return next;
  }
  let effectiveRef = populateModels(selectedProvider, selectedRef);
  modelLabel.append(modelSelect);

  const thinkingField = document.createElement('div'); thinkingField.className = 'thinking-field';
  const thinkingTitle = document.createElement('span'); thinkingTitle.className = 'field-label'; thinkingTitle.textContent = 'Reasoning';
  const thinkingControls = document.createElement('div'); thinkingControls.className = 'thinking-controls';
  renderThinking(thinkingControls, mode, role, effectiveRef, profile.thinking || 'auto');
  thinkingField.append(thinkingTitle, thinkingControls);

  providerSelect.addEventListener('change', () => {
    effectiveRef = populateModels(providerSelect.value, '');
    setDraft(mode, role, { modelRef: effectiveRef || null, thinking: 'auto' });
    source.textContent = effectiveRef ? 'Runtime override' : 'OpenClaw';
    renderThinking(thinkingControls, mode, role, effectiveRef, 'auto');
  });
  modelSelect.addEventListener('change', () => {
    effectiveRef = modelSelect.value;
    setDraft(mode, role, { modelRef: effectiveRef || null, thinking: 'auto' });
    renderThinking(thinkingControls, mode, role, effectiveRef, 'auto');
  });

  fields.append(providerLabel, modelLabel, thinkingField);
  card.append(fields);
  return card;
}

function renderHome() {
  const status = state.status;
  if (!status) return;
  const resolved = status.resolvedMode || { mode: 'auto', source: 'global' };
  $('#resolved-mode').textContent = String(resolved.mode || 'auto').toUpperCase();
  const sourceNames = { global: '全局默认', project: '当前项目', session: '当前会话', task: '下一次任务', 'task-run-binding': '任务运行绑定', default: '默认' };
  $('#mode-source').textContent = `来源：${sourceNames[resolved.source] || resolved.source || '默认'}`;

  const enforcement = status.runtimeStatus?.enforcement || {};
  const banner = $('#enforcement-banner');
  if (enforcement.hard) {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden');
    $('#enforcement-state').textContent = 'ADVISORY';
    $('#enforcement-detail').textContent = '插件未连接、心跳过期，或路由 / 工具钩子尚未完成同一实例实测。';
  }

  for (const card of $$('.mode-card')) {
    const mode = card.dataset.modeCard;
    const active = mode === resolved.mode;
    card.classList.toggle('active', active);
    const panel = $('[data-route-panel]', card);
    panel.classList.toggle('hidden', !active);
    panel.replaceChildren();
    if (active) for (const role of rolesForMode(mode)) panel.append(renderRoleRoute(mode, role));
  }

  const registry = state.registry || {};
  $('#registry-note').textContent = registry.updatedAt
    ? `Registry ${registry.revision || '—'} · ${registry.models?.length || 0} 模型 · ${dateText(registry.updatedAt)}`
    : '等待 OpenClaw Registry 同步';
}

async function switchMode(mode) {
  const { scope, id } = currentScope();
  if (scope !== 'global' && !id) throw new Error('请先填写当前作用范围的标识。');
  if (mode === 'main') {
    $('#reauth-totp-label')?.classList.toggle('hidden', !state.totpRequired);
    $('#main-dialog')?.showModal();
    return;
  }
  await api('/api/mode', { method: 'PUT', body: JSON.stringify({ scope, id, mode }) });
  message(`已切换到 ${mode.toUpperCase()}。`);
  await refreshPage();
}

async function confirmMain() {
  const { scope, id } = currentScope();
  if (scope !== 'global' && !id) throw new Error('请先填写当前作用范围的标识。');
  const ttlMinutes = Number($('input[name="main-duration"]:checked')?.value || 30);
  const persistent = ttlMinutes === 0;
  await api('/api/mode', {
    method: 'PUT',
    body: JSON.stringify({
      scope, id, mode: 'main', ttlMinutes,
      confirmation: persistent ? 'ENABLE_MAIN_PERSISTENT' : 'ENABLE_MAIN',
      reauthPassword: $('#reauth-password')?.value || '',
      reauthTotp: $('#reauth-totp')?.value || '',
    }),
  });
  $('#main-dialog')?.close();
  if ($('#reauth-password')) $('#reauth-password').value = '';
  if ($('#reauth-totp')) $('#reauth-totp').value = '';
  message('仅主控已启用；活动 Worker / Verifier 已被 fence。');
  await refreshPage();
}

async function saveRouting() {
  const mode = state.status?.resolvedMode?.mode || 'auto';
  const roles = rolesForMode(mode);
  const button = $('#save-routing');
  if (button) button.disabled = true;
  try {
    for (const role of roles) {
      const profile = currentProfile(mode, role);
      await api('/api/routing', {
        method: 'PUT',
        body: JSON.stringify({ mode, role, modelRef: profile.modelRef || '', thinking: profile.thinking || 'auto' }),
      });
      state.routingDraft.delete(routingKey(mode, role));
    }
    message('模型路由已保存；下一次 OpenClaw turn / spawn 将按该路由执行。');
    await refreshHomeData();
  } finally {
    if (button) button.disabled = false;
  }
}

async function refreshHomeData() {
  const [status, registry] = await Promise.all([api(`/api/status${statusQuery()}`), api('/api/registry')]);
  state.status = status;
  state.registry = registry.registry;
  state.routingProfiles = registry.routingProfiles;
  state.routingDraft.clear();
  renderHome();
}

function taskStateClass(task) {
  if (task.state === 'succeeded') return 'success';
  if (['failed', 'expired', 'cancelled'].includes(task.state)) return 'danger';
  return 'neutral';
}

function appendCell(row, text, className = '') {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  row.append(td);
  return td;
}

function renderTasks(tasks) {
  const body = $('#tasks-body');
  body.replaceChildren();
  $('#tasks-empty').classList.toggle('hidden', tasks.length > 0);
  for (const task of tasks) {
    const row = document.createElement('tr');
    row.className = 'clickable-row';
    row.addEventListener('click', () => openTask(task.id));
    const idCell = appendCell(row, task.id);
    const meta = document.createElement('small'); meta.textContent = `${task.kind} · epoch ${task.ownerEpoch}`; idCell.append(document.createElement('br'), meta);
    appendCell(row, `${roleLabel(task.role)}\n${task.route?.modelRef || 'OpenClaw 默认'}`, 'preserve-lines');
    const stateCell = appendCell(row, task.state);
    stateCell.innerHTML = '';
    const pill = document.createElement('span'); pill.className = `status-pill ${taskStateClass(task)}`; pill.textContent = task.state; stateCell.append(pill);
    appendCell(row, `${task.progress?.phase || '—'}\nmeaningful ${task.progress?.meaningfulSeq || 0}`, 'preserve-lines');
    appendCell(row, `${relativeDeadline(task.lease?.expiresAt)}\nHB ${relativeDeadline(task.progress?.heartbeatAt ? new Date(Date.parse(task.progress.heartbeatAt) + 45_000).toISOString() : null)}`, 'preserve-lines');
    appendCell(row, `${relativeDeadline(task.lease?.hardDeadline)}\n${dateText(task.lease?.hardDeadline)}`, 'preserve-lines');
    body.append(row);
  }
}

function detailLine(label, value) {
  const row = document.createElement('div'); row.className = 'detail-line';
  const key = document.createElement('span'); key.textContent = label;
  const val = document.createElement('strong'); val.textContent = value || '—';
  row.append(key, val); return row;
}

async function openTask(id) {
  const { task } = await api(`/api/worker-tasks/${encodeURIComponent(id)}`);
  state.selectedTaskId = id;
  $('#task-title').textContent = id;
  const detail = $('#task-detail'); detail.replaceChildren(
    detailLine('状态', `${task.state} · ${task.kind}`),
    detailLine('角色', `${task.role} · ${task.execution?.agentId || task.route?.targetAgentId || '—'}`),
    detailLine('模型', task.route?.modelRef || 'OpenClaw 默认'),
    detailLine('Reasoning', task.route?.thinking || 'auto'),
    detailLine('Run / Session', [task.execution?.runId, task.execution?.sessionId || task.execution?.sessionKey].filter(Boolean).join(' · ')),
    detailLine('Parent', [task.parent?.runId, task.parent?.sessionId || task.parent?.sessionKey].filter(Boolean).join(' · ')),
    detailLine('Lease', `${dateText(task.lease?.expiresAt)} · hard ${dateText(task.lease?.hardDeadline)}`),
    detailLine('进度', `${task.progress?.phase || '—'} · meaningful ${task.progress?.meaningfulSeq || 0}`),
    detailLine('终态', task.terminal ? `${task.terminal.outcome}${task.terminal.error?.message ? ` · ${task.terminal.error.message}` : ''}` : '—'),
  );
  const timeline = $('#task-events'); timeline.replaceChildren();
  for (const event of task.events || []) {
    const item = document.createElement('div'); item.className = 'timeline-item';
    const top = document.createElement('div'); const type = document.createElement('strong'); type.textContent = event.type; const time = document.createElement('time'); time.textContent = dateText(event.at); top.append(type, time);
    const meta = document.createElement('code'); const copy = { ...event }; delete copy.type; delete copy.at; meta.textContent = JSON.stringify(copy);
    item.append(top, meta); timeline.append(item);
  }
  $('#task-root-totp-label')?.classList.toggle('hidden', !state.totpRequired);
  $('#task-dialog').showModal();
}

async function rootTaskAction(action) {
  if (!state.selectedTaskId) return;
  if (action === 'cancel' && !window.confirm('确认使用 root-control 取消此任务？')) return;
  const body = {
    action,
    confirmation: action === 'cancel' ? 'CANCEL_TASK' : 'EXTEND_TASK',
    reauthPassword: $('#task-root-password')?.value || '',
    reauthTotp: $('#task-root-totp')?.value || '',
    minutes: Number($('#task-extend-minutes')?.value || 5),
  };
  await api(`/api/worker-tasks/${encodeURIComponent(state.selectedTaskId)}/action`, { method: 'POST', body: JSON.stringify(body) });
  message(action === 'cancel' ? 'Root-control 已取消任务。' : 'Root-control 已在硬截止内续期 lease。');
  $('#task-dialog').close();
  await refreshTasks();
}

async function refreshTasks() {
  const active = $('#active-only')?.checked ? '&active=1' : '';
  const data = await api(`/api/worker-tasks?limit=250${active}`);
  renderTasks(data.tasks || []);
}

function proof(id, value) {
  const el = $(id); if (!el) return;
  el.textContent = value ? '是' : '否';
  el.className = value ? 'proof-yes' : 'proof-no';
}

async function refreshRuntime() {
  const status = await api('/api/status');
  const runtime = status.runtimeStatus || {};
  const enforcement = runtime.enforcement || {};
  const chip = $('#runtime-enforcement');
  chip.textContent = enforcement.hard ? 'HARD' : 'ADVISORY';
  chip.className = `status-pill ${enforcement.hard ? 'success' : 'warning'}`;
  $('#runtime-main-model').textContent = runtime.main?.model || runtime.main?.configuredModel || '等待上报';
  $('#runtime-main-meta').textContent = [runtime.main?.provider, runtime.main?.agentId, runtime.main?.sessionId].filter(Boolean).join(' · ') || 'OpenClaw 原生插件尚未上报运行身份';
  const registry = status.registry || {};
  $('#runtime-registry').textContent = registry.revision || '等待同步';
  $('#runtime-registry-meta').textContent = `${registry.models?.length || 0} 模型 · ${registry.providers?.length || 0} Provider · OpenClaw ${registry.openclawVersion || runtime.openclawVersion || '—'}`;
  const summary = status.workerSummary || {};
  $('#runtime-work-summary').textContent = `${summary.active || 0} 个活动任务`;
  $('#runtime-work-meta').textContent = `running ${summary.running || 0} · reviewing ${summary.reviewing || 0} · failed ${summary.failed || 0}`;
  proof('#proof-heartbeat', enforcement.heartbeatFresh === true);
  proof('#proof-route', enforcement.routeObserved === true);
  proof('#proof-tool', enforcement.toolCheckObserved === true);
  proof('#proof-instance', Boolean(runtime.instanceId) && runtime.observedEnforcement?.instanceId === runtime.instanceId);
  $('#runtime-updated').textContent = `实例 ${runtime.instanceId || '—'} · 更新 ${dateText(runtime.updatedAt)}`;
  const workers = $('#runtime-workers'); workers.replaceChildren();
  const entries = runtime.workers || [];
  if (!entries.length) {
    const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '暂无活动 Worker / Verifier 运行上报。'; workers.append(empty);
  } else {
    for (const worker of entries) {
      const row = document.createElement('div'); row.className = 'runtime-row';
      const left = document.createElement('div'); const strong = document.createElement('strong'); strong.textContent = worker.agentId || worker.id || worker.role; const small = document.createElement('small'); small.textContent = [worker.role, worker.taskId, worker.sessionId].filter(Boolean).join(' · '); left.append(strong, small);
      const right = document.createElement('div'); right.className = 'runtime-row-right'; right.textContent = `${worker.provider ? `${worker.provider}/` : ''}${worker.model || worker.configuredModel || '—'} · ${worker.status || 'unknown'}`;
      row.append(left, right); workers.append(row);
    }
  }
}

function eventDetails(event) {
  const copy = { ...event };
  for (const key of ['id', 'at', 'type', 'role', 'agentId', 'taskId', 'runId']) delete copy[key];
  const text = JSON.stringify(copy);
  return text.length > 700 ? `${text.slice(0, 700)}…` : text;
}

async function refreshAudit() {
  const limit = Number($('#audit-limit')?.value || 100);
  const { events } = await api(`/api/events?limit=${limit}`);
  const body = $('#audit-body'); body.replaceChildren();
  for (const event of events || []) {
    const row = document.createElement('tr');
    appendCell(row, dateText(event.at));
    appendCell(row, event.type || '—');
    appendCell(row, [event.role || event.actor, event.agentId].filter(Boolean).join(' / ') || '—');
    appendCell(row, [event.taskId, event.runId].filter(Boolean).join(' / ') || '—');
    appendCell(row, eventDetails(event), 'audit-detail');
    body.append(row);
  }
}

async function refreshSettings() {
  const { registry } = await api('/api/registry');
  $('#settings-registry').textContent = registry.updatedAt
    ? `${registry.revision} · ${registry.models?.length || 0} models · OpenClaw ${registry.openclawVersion || '—'} · ${dateText(registry.updatedAt)}`
    : '尚未收到 OpenClaw Registry';
}

async function refreshPage() {
  setConnection('刷新中', 'neutral');
  try {
    if (state.page === 'home') await refreshHomeData();
    if (state.page === 'tasks') await refreshTasks();
    if (state.page === 'runtime') await refreshRuntime();
    if (state.page === 'audit') await refreshAudit();
    if (state.page === 'settings') await refreshSettings();
    setConnection('实时连接', 'success');
  } catch (error) {
    setConnection('刷新失败', 'danger');
    message(error.message, 'error');
    throw error;
  }
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => refreshPage().catch(() => {}), 180);
}

function connectEvents() {
  state.source?.close();
  const source = new EventSource('/api/stream');
  state.source = source;
  source.addEventListener('ready', () => setConnection('实时连接', 'success'));
  source.addEventListener('control', scheduleRefresh);
  source.onerror = () => setConnection('重新连接', 'warning');
}

function wirePage() {
  $('#refresh')?.addEventListener('click', () => refreshPage().catch(() => {}));
  $('#logout')?.addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {}
    state.source?.close(); state.csrf = ''; showAuth(false);
  });

  if (state.page === 'home') {
    restoreScope();
    $('#scope')?.addEventListener('change', () => { applyScopeUi(); persistScope(); if ($('#scope').value === 'global' || $('#scope-id').value.trim()) refreshPage().catch(() => {}); });
    $('#scope-id')?.addEventListener('change', () => { persistScope(); refreshPage().catch(() => {}); });
    for (const button of $$('[data-mode-select]')) button.addEventListener('click', () => switchMode(button.dataset.modeSelect).catch((error) => message(error.message, 'error')));
    $('#save-routing')?.addEventListener('click', () => saveRouting().catch((error) => message(error.message, 'error')));
    $('#cancel-main')?.addEventListener('click', () => $('#main-dialog')?.close());
    $('#confirm-main')?.addEventListener('click', () => confirmMain().catch((error) => message(error.message, 'error')));
  }
  if (state.page === 'tasks') {
    $('#active-only')?.addEventListener('change', () => refreshTasks().catch((error) => message(error.message, 'error')));
    $('#close-task')?.addEventListener('click', () => $('#task-dialog')?.close());
    $('#extend-task')?.addEventListener('click', () => rootTaskAction('extend').catch((error) => message(error.message, 'error')));
    $('#cancel-task')?.addEventListener('click', () => rootTaskAction('cancel').catch((error) => message(error.message, 'error')));
  }
  if (state.page === 'audit') $('#audit-limit')?.addEventListener('change', () => refreshAudit().catch((error) => message(error.message, 'error')));
}

async function bootstrap() {
  wirePage();
  try {
    const loginConfig = await api('/api/login-config');
    state.totpRequired = loginConfig.totpRequired === true;
  } catch {}
  $('#login-totp-label')?.classList.toggle('hidden', !state.totpRequired);
  $('#login-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#login-error').textContent = '';
    try {
      const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password')?.value || '', totp: $('#login-totp')?.value || '' }) });
      state.csrf = data.csrfToken;
      showAuth(true);
      await refreshPage();
      connectEvents();
    } catch (error) {
      $('#login-error').textContent = error.message;
    }
  });

  try {
    const session = await api('/api/session');
    state.csrf = session.csrfToken;
    state.totpRequired = session.totpEnabled === true;
    showAuth(true);
    await refreshPage();
    connectEvents();
  } catch (error) {
    if (error.status !== 401) message(error.message, 'error');
    showAuth(false);
  }
}

window.addEventListener('beforeunload', () => state.source?.close());
bootstrap();
