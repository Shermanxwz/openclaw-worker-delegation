const state = { csrf: '', source: null, runtimeSessionId: '', pendingMain: null, totpRequired: false };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) };
  if (options.method && options.method !== 'GET' && state.csrf) headers['x-csrf-token'] = state.csrf;
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/api/login') {
    state.source?.close(); state.csrf = ''; show('login');
  }
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status, data });
  return data;
}

function show(view) {
  $('#login-view').classList.toggle('hidden', view !== 'login');
  $('#dashboard').classList.toggle('hidden', view !== 'dashboard');
}

function contextQuery() {
  const scope = $('#scope').value;
  const id = $('#scope-id').value.trim();
  if (scope === 'session' || scope === 'task') return `?sessionId=${encodeURIComponent(id)}`;
  if (scope === 'project') return `?projectId=${encodeURIComponent(id)}`;
  return '';
}

function renderMetrics(metrics = {}) {
  const definitions = [
    ['审计事件', metrics.totalEvents || 0], ['主控被拦截', metrics.blockedMainActions || 0],
    ['工具已允许', metrics.allowedToolCalls || 0], ['路由到 Worker', metrics.routeToWorker || 0],
    ['路由到 Main', metrics.routeToMain || 0], ['Worker 失败', metrics.workerFailures || 0],
  ];
  $('#metrics').replaceChildren(...definitions.map(([label, value]) => {
    const card = document.createElement('article'); card.className = 'card metric';
    const number = document.createElement('strong'); number.textContent = value;
    const text = document.createElement('span'); text.textContent = label;
    card.append(number, text); return card;
  }));
}

function yesNo(id, value) { $(id).textContent = value ? '是' : '否'; $(id).className = value ? 'ok' : 'warn'; }

function renderRuntime(runtime = {}) {
  const main = runtime.main || {};
  const workers = Array.isArray(runtime.workers) ? runtime.workers : [];
  const enforcement = runtime.enforcement || {};
  state.runtimeSessionId = main.sessionId || runtime.sessionId || '';
  $('#main-model').textContent = main.model || '未上报';
  $('#main-model-meta').textContent = [main.provider, main.configuredModel && main.configuredModel !== main.model ? `配置：${main.configuredModel}` : '', main.agentId ? `Agent：${main.agentId}` : '', main.status ? `状态：${main.status}` : '', main.sessionId ? `会话：${main.sessionId}` : ''].filter(Boolean).join(' · ') || '等待 OpenClaw 原生插件心跳';
  $('#runtime-updated').textContent = runtime.updatedAt ? `更新 ${new Date(runtime.updatedAt).toLocaleTimeString()}` : '尚未上报';
  $('#worker-models').textContent = workers.length ? workers.map((worker) => `${worker.id || worker.agentId || worker.role || 'worker'}: ${worker.model || '模型未上报'}\n  ${[worker.role, worker.status, worker.provider, worker.sessionId].filter(Boolean).join(' · ')}`).join('\n\n') : '暂无 Worker 上报';

  const hard = enforcement.state === 'hard';
  $('#enforcement-state').textContent = hard ? 'HARD' : 'ADVISORY';
  $('#enforcement-banner').className = `banner ${hard ? 'hard' : 'advisory'}`;
  $('#enforcement-detail').textContent = hard ? '同一插件实例的路由与工具前置钩子已被控制器实际观察到' : '插件未连接、心跳过期，或路由/工具钩子尚未完成实测';
  yesNo('#proof-heartbeat', enforcement.heartbeatFresh === true);
  yesNo('#proof-route', enforcement.routeObserved === true);
  yesNo('#proof-tool', enforcement.toolCheckObserved === true);
  yesNo('#proof-instance', Boolean(runtime.instanceId) && runtime.observedEnforcement?.instanceId === runtime.instanceId);
}

function compactEvent(event) {
  const copy = { ...event }; for (const key of ['id', 'at', 'type', 'task']) delete copy[key]; return JSON.stringify(copy);
}

function renderEvents(events = []) {
  $('#events').replaceChildren(...events.map((event) => {
    const row = document.createElement('tr');
    if (event.type === 'tool.blocked' || event.type === 'auth.failed') row.classList.add('danger-row');
    const time = document.createElement('td'); time.textContent = new Date(event.at).toLocaleString();
    const type = document.createElement('td'); type.textContent = event.type;
    const role = document.createElement('td'); role.textContent = [event.role || event.actor, event.agentId].filter(Boolean).join(' / ') || '—';
    const details = document.createElement('td'); details.textContent = event.task || compactEvent(event);
    row.append(time, type, role, details); return row;
  }));
}

function renderRoute(route) {
  if (!route) return '暂无记录';
  const reasons = (route.reasons || []).map((item) => `${item.points > 0 ? '+' : ''}${item.points} ${item.reason}`).join('\n');
  return [`Actor: ${String(route.actor || '').toUpperCase()}`, `Decision: ${route.decision || '—'}`, `Score: ${route.score ?? '—'}`, `Confidence: ${route.confidence ? `${Math.round(route.confidence * 100)}%` : '—'}`, reasons ? `\nReasons:\n${reasons}` : ''].filter(Boolean).join('\n');
}

async function refresh() {
  const [status, eventData] = await Promise.all([api(`/api/status${contextQuery()}`), api('/api/events?limit=100')]);
  $('#resolved-mode').textContent = status.resolvedMode.mode.toUpperCase();
  $('#mode-source').textContent = `来源：${status.resolvedMode.source}${status.resolvedMode.entry?.expiresAt ? ` · 到期 ${new Date(status.resolvedMode.entry.expiresAt).toLocaleString()}` : ''}`;
  $$('.mode-button').forEach((button) => button.classList.toggle('active', button.dataset.mode === status.resolvedMode.mode));
  $('#clear-override').disabled = !['task', 'session', 'project'].includes(status.resolvedMode.source);
  renderRuntime(status.runtimeStatus); renderMetrics(status.metrics);
  $('#latest-route').textContent = renderRoute(status.latestRoute); renderEvents(eventData.events);
}

function connectEvents() {
  state.source?.close(); const source = new EventSource('/api/stream'); state.source = source;
  source.addEventListener('ready', () => { $('#connection').textContent = '实时连接'; });
  source.addEventListener('control', () => refresh().catch(() => {}));
  source.onerror = () => { $('#connection').textContent = '重新连接中'; };
}

async function setMode(mode, reauthPassword = '', reauthTotp = '') {
  const scope = $('#scope').value; const id = scope === 'global' ? '' : $('#scope-id').value.trim();
  if (!id && scope !== 'global') throw new Error('scope_id_required');
  const result = await api('/api/mode', { method: 'PUT', body: JSON.stringify({ mode, scope, id, ttlMinutes: Number($('#ttl').value), reauthPassword, reauthTotp, confirmation: mode === 'main' ? 'ENABLE_MAIN' : undefined }) });
  $('#mode-message').textContent = `已切换为 ${result.entry.mode.toUpperCase()}${result.entry.expiresAt ? `，到期 ${new Date(result.entry.expiresAt).toLocaleString()}` : ''}`;
  await refresh();
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); $('#login-error').textContent = '';
  try { const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value, totp: $('#login-totp').value }) }); state.csrf = result.csrfToken; $('#password').value = ''; $('#login-totp').value = ''; show('dashboard'); await refresh(); connectEvents(); }
  catch (error) { $('#login-error').textContent = error.message === 'login_temporarily_blocked' ? '登录尝试过多，请稍后再试。' : '登录失败。'; }
});

$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {}); state.source?.close(); state.csrf = ''; show('login'); });
$('#scope').addEventListener('change', () => { $('#scope-id-label').classList.toggle('hidden', $('#scope').value === 'global'); refresh().catch(() => {}); });
$('#scope-id').addEventListener('change', () => refresh().catch(() => {}));
$('#refresh').addEventListener('click', () => refresh().catch((error) => { $('#connection').textContent = `刷新失败：${error.message}`; }));
$('#use-runtime-session').addEventListener('click', () => { if (state.runtimeSessionId) { $('#scope').value = 'session'; $('#scope-id-label').classList.remove('hidden'); $('#scope-id').value = state.runtimeSessionId; refresh().catch(() => {}); } else $('#mode-message').textContent = '运行时尚未上报会话 ID。'; });
$('#clear-override').addEventListener('click', async () => { const scope = $('#scope').value; const id = $('#scope-id').value.trim(); if (!['task', 'session', 'project'].includes(scope) || !id) return; try { await api('/api/mode', { method: 'DELETE', body: JSON.stringify({ scope, id }) }); $('#mode-message').textContent = '已清除覆盖。'; await refresh(); } catch (error) { $('#mode-message').textContent = `清除失败：${error.message}`; } });

$$('.mode-button').forEach((button) => button.addEventListener('click', async () => {
  $('#mode-message').textContent = '';
  if (button.dataset.mode === 'main') { state.pendingMain = true; $('#reauth-password').value = ''; $('#reauth-totp').value = ''; $('#main-dialog').showModal(); $('#reauth-password').focus(); return; }
  try { await setMode(button.dataset.mode); } catch (error) { $('#mode-message').textContent = `切换失败：${error.message}`; }
}));

$('#main-form').addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') { state.pendingMain = null; return; }
  event.preventDefault();
  try { await setMode('main', $('#reauth-password').value, $('#reauth-totp').value); $('#main-dialog').close(); state.pendingMain = null; }
  catch (error) { $('#mode-message').textContent = error.message === 'reauthentication_required' ? '二次验证失败。' : `切换失败：${error.message}`; $('#main-dialog').close(); }
});

$('#route-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const task = $('#route-task').value.trim(); if (!task) return;
  const scope = $('#scope').value; const id = $('#scope-id').value.trim(); const body = { task };
  if (scope === 'session' || scope === 'task') body.sessionId = id; if (scope === 'project') body.projectId = id;
  try { const result = await api('/api/route-preview', { method: 'POST', body: JSON.stringify(body) }); $('#route-result').textContent = `${renderRoute(result.route)}\n\nPolicy:\n${JSON.stringify(result.policy, null, 2)}`; }
  catch (error) { $('#route-result').textContent = `预览失败：${error.message}`; }
});

(async () => {
  try {
    const loginConfig = await api('/api/login-config');
    state.totpRequired = loginConfig.totpRequired === true;
    $('#login-totp-label').classList.toggle('hidden', !state.totpRequired);
    $('#reauth-totp-label').classList.toggle('hidden', !state.totpRequired);
    $('#login-totp').required = state.totpRequired;
    $('#reauth-totp').required = state.totpRequired;
  } catch {}
  try {
    const session = await api('/api/session'); state.csrf = session.csrfToken; show('dashboard'); await refresh(); connectEvents();
  } catch { show('login'); }
})();
