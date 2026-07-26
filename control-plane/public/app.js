const state = {
  csrf: '',
  source: null,
  runtimeSessionId: '',
  pendingMain: false,
  pendingPersistent: false,
  pendingDurationMinutes: 30,
  totpRequired: false,
};
const storageKey = 'ocwd.scope.v1';
const BUILD = 'live';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

let __ocwdCountdownInterval = null;
function clearCountdownInterval() {
  if (__ocwdCountdownInterval) {
    clearInterval(__ocwdCountdownInterval);
    __ocwdCountdownInterval = null;
  }
}

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

function selectedContext() {
  return { scope: $('#scope').value, id: $('#scope-id').value.trim() };
}

function persistContext() {
  try { localStorage.setItem(storageKey, JSON.stringify(selectedContext())); } catch {}
}

function restoreContext() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch {}
  const scope = ['global', 'project', 'session', 'task'].includes(saved?.scope) ? saved.scope : 'session';
  $('#scope').value = scope;
  $('#scope-id-label').classList.toggle('hidden', scope === 'global');
  $('#scope-id').value = typeof saved?.id === 'string' ? saved.id : '';
}

function contextQuery() {
  const { scope, id } = selectedContext();
  if (scope === 'session' || scope === 'task') return `?sessionId=${encodeURIComponent(id)}`;
  if (scope === 'project') return `?projectId=${encodeURIComponent(id)}`;
  return '';
}

function renderMetrics(metrics = {}) {
  const definitions = [
    ['审计事件', metrics.totalEvents || 0],
    ['主控被拦截', metrics.blockedMainActions || 0],
    ['工具已允许', metrics.allowedToolCalls || 0],
    ['路由到 Worker', metrics.routeToWorker || 0],
    ['路由到 Main', metrics.routeToMain || 0],
    ['Worker 失败', metrics.workerFailures || 0],
  ];
  $('#metrics').replaceChildren(...definitions.map(([label, value]) => {
    const card = document.createElement('article'); card.className = 'metric';
    const number = document.createElement('strong'); number.textContent = value;
    const text = document.createElement('span'); text.textContent = label;
    card.append(number, text); return card;
  }));
}

function yesNo(id, value) {
  const el = $(id);
  el.textContent = value ? '是' : '否';
  el.classList.toggle('proof-yes', value);
  el.classList.toggle('proof-no', !value);
}

function renderRuntime(runtime = {}) {
  const main = runtime.main || {};
  const workers = Array.isArray(runtime.workers) ? runtime.workers : [];
  const enforcement = runtime.enforcement || {};
  state.runtimeSessionId = main.sessionId || runtime.sessionId || '';
  $('#main-model').textContent = main.model || '未上报';
  $('#main-model-meta').textContent = [
    main.provider,
    main.configuredModel && main.configuredModel !== main.model ? `配置：${main.configuredModel}` : '',
    main.agentId ? `Agent：${main.agentId}` : '',
    main.status ? `状态：${main.status}` : '',
    main.sessionId ? `会话：${main.sessionId}` : '',
  ].filter(Boolean).join(' · ') || '等待 OpenClaw 原生插件心跳';
  $('#runtime-updated').textContent = runtime.updatedAt ? `更新 ${new Date(runtime.updatedAt).toLocaleTimeString()}` : '尚未上报';
  $('#worker-models').textContent = workers.length
    ? workers.map((worker) => `${worker.id || worker.agentId || worker.role || 'worker'}: ${worker.model || '模型未上报'}\n  ${[worker.role, worker.status, worker.provider, worker.sessionId].filter(Boolean).join(' · ')}`).join('\n\n')
    : '暂无 Worker 上报';

  const hard = enforcement.state === 'hard';
  $('#enforcement-state').textContent = hard ? 'HARD' : 'ADVISORY';
  $('#enforcement-state-chip').textContent = hard ? 'HARD' : 'ADVISORY';
  $('#enforcement-state-chip').className = `chip ${hard ? 'chip-success' : 'chip-warn'}`;
  $('#enforcement-banner').className = `banner ${hard ? 'banner-hard' : 'banner-advisory'}`;
  $('#enforcement-detail').textContent = hard ? '同一插件实例的路由与工具前置钩子已被控制器实际观察到。' : '插件未连接、心跳过期，或路由/工具钩子尚未完成实测。';
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

function formatRelative(targetMs, nowMs) {
  let diff = Math.max(0, Math.round((targetMs - nowMs) / 1000));
  if (diff < 60) return `${diff} 秒`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分 ${diff % 60} 秒`;
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  return `${hours} 时 ${minutes} 分`;
}

/**
 * Reset mode-meta chips and any pending countdown before re-rendering.
 * This must run on EVERY mode change / refresh, otherwise stale chip text and
 * intervals leak across modes (the bug being fixed in this pass).
 */
function resetModeMetaUi() {
  clearCountdownInterval();
  const kind = $('#mode-meta-kind');
  const ttl = $('#mode-meta-ttl');
  const countdown = $('#mode-meta-countdown');
  if (!kind || !ttl || !countdown) return;
  kind.className = 'chip chip-neutral';
  ttl.className = 'chip chip-neutral';
  countdown.classList.add('hidden');
  countdown.className = 'chip chip-neutral hidden';
  countdown.textContent = '';
}

function renderModeMeta(resolved) {
  const entry = resolved?.entry || {};
  const source = resolved?.source || '';
  const mode = (resolved?.mode || '').toLowerCase();
  const persistent = entry.persistent === true;
  const expiresAt = entry.expiresAt ? Date.parse(entry.expiresAt) : null;
  const isTask = source === 'task' || source === 'task-run-binding';

  const kind = $('#mode-meta-kind');
  const ttl = $('#mode-meta-ttl');
  const countdown = $('#mode-meta-countdown');
  const help = $('#mode-meta-help');

  resetModeMetaUi();

  if (mode === 'main') {
    if (persistent) {
      kind.textContent = '持久主控';
      kind.className = 'chip chip-warn';
      ttl.textContent = '直到手动切回 Auto';
      ttl.className = 'chip chip-warn';
      help.textContent = '已开启持久主控：Worker / Verifier 已冻结；直到在面板手动切回 Auto / Worker，才解除主控提权。';
    } else if (expiresAt) {
      kind.textContent = '限时主控';
      kind.className = 'chip chip-warn';
      ttl.textContent = `到期 ${new Date(expiresAt).toLocaleString()}`;
      ttl.className = 'chip chip-warn';
      help.textContent = '主控提权已开启：Worker / Verifier 已冻结；到期自动恢复，或随时手动切回。';
      const tick = () => {
        const remain = expiresAt - Date.now();
        if (remain <= 0) {
          // Stop ticking once the window expires so we don't keep firing a
          // 1Hz no-op interval until the next render. clearCountdownInterval
          // nulls the shared handle, so a later render can safely reschedule.
          countdown.classList.add('hidden');
          clearCountdownInterval();
          return;
        }
        countdown.textContent = `剩余 ${formatRelative(expiresAt, Date.now())}`;
        countdown.classList.remove('hidden');
        countdown.className = 'chip chip-warn';
      };
      tick();
      clearCountdownInterval();
      __ocwdCountdownInterval = setInterval(tick, 1000);
    } else {
      kind.textContent = '限时主控';
      kind.className = 'chip chip-warn';
      ttl.textContent = '无到期';
      ttl.className = 'chip chip-warn';
      help.textContent = '主控提权已开启：Worker / Verifier 已冻结。';
    }
  } else if (mode === 'worker') {
    // Worker is ALWAYS persistent (no TTL countdown). task scope is the only
    // case where it can be "next-task", and that one-shot is consumed by the
    // router; the panel itself never shows a countdown for Worker/Auto.
    kind.textContent = '持久生效';
    kind.className = 'chip chip-success';
    ttl.textContent = isTask ? '下一次任务' : '直到手动切换';
    ttl.className = isTask ? 'chip chip-accent' : 'chip chip-success';
    help.textContent = '主控只能规划、派发、审核，不会自动升级到执行。';
  } else if (mode === 'auto') {
    kind.textContent = '自动判断';
    kind.className = 'chip chip-accent';
    ttl.textContent = isTask ? '下一次任务' : '持久生效';
    ttl.className = isTask ? 'chip chip-accent' : 'chip chip-success';
    help.textContent = '路由器按任务性质自动选 Main（轻量问答）或 Worker（工具型工作）。';
  } else {
    kind.textContent = '未生效';
    ttl.textContent = '—';
    help.textContent = '选择一个作用范围与模式开始控制。';
  }
}

async function refresh() {
  $('#connection').textContent = '刷新中…';
  $('#connection').className = 'chip chip-neutral';
  // Always clear stale timer/chip before reading new state.
  resetModeMetaUi();
  try {
    const [status, eventData] = await Promise.all([
      api(`/api/status${contextQuery()}`),
      api('/api/events?limit=100'),
    ]);
    $('#resolved-mode').textContent = (status.resolvedMode.mode || 'auto').toUpperCase();
    const sourceLabel = {
      'global': '全局默认',
      'project': '当前项目',
      'session': '当前运行时会话',
      'task': '下一次任务',
      'task-preview': '下一次任务（预览）',
      'task-run-binding': '下一次任务（运行绑定）',
      'default-after-expiry': '全局默认（已过期回落）',
      'default': '默认',
    }[status.resolvedMode.source] || status.resolvedMode.source;
    $('#mode-source').textContent = `来源：${sourceLabel}`;
    $$('.mode-button').forEach((button) => button.classList.toggle('active', button.dataset.mode === status.resolvedMode.mode));
    $('#clear-override').disabled = !['task', 'session', 'project'].includes(status.resolvedMode.source);
    renderModeMeta(status.resolvedMode);
    renderRuntime(status.runtimeStatus);
    renderMetrics(status.metrics);
    $('#latest-route').textContent = renderRoute(status.latestRoute);
    renderEvents(eventData.events);
    $('#connection').textContent = '实时连接';
    $('#connection').className = 'chip chip-success';
  } catch (error) {
    $('#connection').textContent = `刷新失败：${error.message}`;
    $('#connection').className = 'chip chip-danger';
    throw error;
  }
}

function connectEvents() {
  state.source?.close(); const source = new EventSource('/api/stream'); state.source = source;
  source.addEventListener('ready', () => { $('#connection').textContent = '实时连接'; $('#connection').className = 'chip chip-success'; });
  source.addEventListener('control', () => refresh().catch(() => {}));
  source.onerror = () => { $('#connection').textContent = '重新连接中'; $('#connection').className = 'chip chip-warn'; };
}

function applyScopeUi() {
  const scope = $('#scope').value;
  $('#scope-id-label').classList.toggle('hidden', scope === 'global');
  const helpEl = $('#scope-help-text');
  if (helpEl) {
    const labels = {
      global: '全局默认 · 所有会话/任务都按此模式路由。',
      project: '当前项目 · 该 projectId 下所有任务都按此模式路由。',
      session: '当前运行时会话 · 该会话所有任务都按此模式路由。',
      task: '下一次任务 · 仅下一条真实 Main 路由生效；Auto / Worker 不存在此语义。',
    };
    helpEl.textContent = labels[scope] || '';
  }
}

function setMainPending(pending) {
  state.pendingMain = pending === true;
  $$('.mode-button').forEach((button) => {
    if (button.dataset.mode === 'main') button.classList.toggle('pending', state.pendingMain);
  });
}

function readSelectedDuration() {
  const checked = document.querySelector('input[name="main-duration"]:checked');
  if (!checked) return 30;
  const v = Number(checked.value);
  return Number.isFinite(v) ? v : 30;
}

function updateMainDialogSummary() {
  const summary = $('#main-dialog-summary');
  const valueEl = $('#main-dialog-summary-value');
  const modeEl = $('#main-dialog-summary-mode');
  const hintEl = $('#main-dialog-summary-hint');
  const confirmLabel = $('#reauth-confirm-label');
  if (!summary || !valueEl || !modeEl) return;
  const minutes = readSelectedDuration();
  state.pendingDurationMinutes = minutes;
  state.pendingPersistent = minutes === 0;
  const isPersistent = minutes === 0;
  summary.classList.toggle('is-persistent', isPersistent);
  valueEl.textContent = isPersistent ? '持久生效' : `${minutes} 分钟`;
  if (isPersistent) {
    modeEl.textContent = '仅主控 · 直到手动切回 Auto 或 Worker';
    if (hintEl) hintEl.textContent = '持久主控 · 不会自动到期，需在面板手动切回';
    confirmLabel.classList.remove('hidden');
    $('#reauth-confirm').required = true;
  } else {
    modeEl.textContent = `仅主控 · ${minutes} 分钟后自动恢复`;
    if (hintEl) hintEl.textContent = `限时主控 · ${minutes} 分钟后自动恢复为 ${getCurrentAutoLabel()}`;
    confirmLabel.classList.add('hidden');
    $('#reauth-confirm').required = false;
    $('#reauth-confirm').value = '';
  }
}

function getCurrentAutoLabel() {
  const source = $('#resolved-mode')?.textContent || 'AUTO';
  return source.toUpperCase() === 'AUTO' ? '自动判断' : '原默认模式';
}

async function setMode(mode, reauthPassword = '', reauthTotp = '', confirmation = '', ttlMinutes) {
  const scope = $('#scope').value;
  const id = scope === 'global' ? '' : $('#scope-id').value.trim();
  persistContext();
  if (!id && scope !== 'global') throw new Error('scope_id_required');
  const body = { mode, scope, id, reauthPassword, reauthTotp };
  if (mode === 'main') {
    body.ttlMinutes = typeof ttlMinutes === 'number' ? ttlMinutes : state.pendingDurationMinutes;
    body.confirmation = confirmation === 'ENABLE_MAIN_PERSISTENT' ? 'ENABLE_MAIN_PERSISTENT' : 'ENABLE_MAIN';
  }
  const result = await api('/api/mode', { method: 'PUT', body: JSON.stringify(body) });
  const exp = result.entry.expiresAt ? `，到期 ${new Date(result.entry.expiresAt).toLocaleString()}` : (result.entry.persistent ? '（持久生效，直到手动切回 Auto）' : '');
  $('#mode-message').textContent = `已切换为 ${result.entry.mode.toUpperCase()}${exp}`;
  await refresh();
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); $('#login-error').textContent = '';
  try {
    const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value, totp: $('#login-totp').value }) });
    state.csrf = result.csrfToken;
    $('#password').value = ''; $('#login-totp').value = '';
    show('dashboard'); await refresh(); connectEvents();
  } catch (error) {
    $('#login-error').textContent = error.message === 'login_temporarily_blocked' ? '登录尝试过多，请稍后再试。' : '登录失败。';
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
  state.source?.close(); state.csrf = ''; show('login');
});
$('#scope').addEventListener('change', () => { applyScopeUi(); persistContext(); refresh().catch(() => {}); });
$('#scope-id').addEventListener('change', () => { persistContext(); refresh().catch(() => {}); });
$('#refresh').addEventListener('click', () => refresh().catch(() => {}));
$('#use-runtime-session').addEventListener('click', () => {
  if (state.runtimeSessionId) {
    $('#scope').value = 'session'; $('#scope-id-label').classList.remove('hidden'); $('#scope-id').value = state.runtimeSessionId;
    applyScopeUi(); persistContext(); refresh().catch(() => {});
  } else $('#mode-message').textContent = '运行时尚未上报会话 ID。';
});
$('#clear-override').addEventListener('click', async () => {
  const scope = $('#scope').value; const id = $('#scope-id').value.trim();
  if (!['task', 'session', 'project'].includes(scope) || !id) return;
  try {
    await api('/api/mode', { method: 'DELETE', body: JSON.stringify({ scope, id }) });
    $('#mode-message').textContent = '已清除覆盖。';
    await refresh();
  } catch (error) { $('#mode-message').textContent = `清除失败：${error.message}`; }
});

$$('.mode-button').forEach((button) => button.addEventListener('click', async () => {
  $('#mode-message').textContent = '';
  if (button.dataset.mode === 'main') {
    openMainDialog();
    return;
  }
  try { await setMode(button.dataset.mode); }
  catch (error) { $('#mode-message').textContent = `切换失败：${error.message}`; }
}));

function openMainDialog() {
  setMainPending(true);
  state.pendingPersistent = false;
  state.pendingDurationMinutes = 30;
  // Reset dialog UI to defaults every time it opens (no stale selection)
  const defaults = $$('input[name="main-duration"]');
  defaults.forEach((input) => { input.checked = input.value === '30'; });
  $('#reauth-password').value = '';
  $('#reauth-totp').value = '';
  $('#reauth-confirm').value = '';
  updateMainDialogSummary();
  // Pre-fill dialog context text from current scope
  const scope = $('#scope').value;
  const scopeLabels = {
    global: '全局默认',
    project: '当前项目',
    session: '当前运行时会话',
    task: '下一次任务',
  };
  $('#main-dialog-eyebrow').textContent = 'PRIVILEGE ELEVATION';
  $('#main-dialog-title').textContent = '启用仅主控模式';
  $('#main-dialog-help').textContent = `作用域：${scopeLabels[scope] || scope}。这会临时允许主控执行命令和修改文件，同时冻结 Worker / Verifier，按所选有效期自动恢复。`;
  $('#main-dialog-checklist').innerHTML = `
    <li>需要重新输入控制台密码与（若已启用）动态验证码。</li>
    <li>切换只对所选作用范围生效。</li>
    <li>随时可在面板里切回 Auto / Worker 立即撤销。</li>`;
  $('#reauth-confirm-label').classList.add('hidden');
  $('#reauth-confirm').required = false;
  const dialog = $('#main-dialog');
  if (typeof dialog.showModal === 'function') {
    dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }
  $('#reauth-password').focus();
}

function closeMainDialog() {
  const dialog = $('#main-dialog');
  if (dialog.open) dialog.close();
  setMainPending(false);
  state.pendingPersistent = false;
}

// Cancel button — must always work even if reauth is empty / invalid.
$('#cancel-main').addEventListener('click', (event) => {
  event.preventDefault();
  closeMainDialog();
});

$('#main-dialog').addEventListener('click', (event) => {
  // Click on the dialog backdrop (the dialog itself, not its inner content)
  // closes the dialog. We detect this by comparing event.target to the dialog.
  if (event.target === event.currentTarget) closeMainDialog();
});

// Wire radio change → dialog summary update (event delegation on form)
$('#main-form').addEventListener('change', (event) => {
  if (event.target?.name === 'main-duration') updateMainDialogSummary();
});

// Confirm button — type="button" so the dialog never auto-submits / resets the
// form behind our back; we drive the request manually.
$('#confirm-main').addEventListener('click', async (event) => {
  event.preventDefault();
  const minutes = readSelectedDuration();
  const isPersistent = minutes === 0;
  let confirmation = 'ENABLE_MAIN';
  if (isPersistent) {
    if ($('#reauth-confirm').value.trim() !== 'ENABLE_MAIN_PERSISTENT') {
      $('#mode-message').textContent = '请键入 ENABLE_MAIN_PERSISTENT 以确认。';
      return; // keep dialog open so user can correct
    }
    confirmation = 'ENABLE_MAIN_PERSISTENT';
  }
  try {
    await setMode('main', $('#reauth-password').value, $('#reauth-totp').value, confirmation, minutes);
    closeMainDialog();
  } catch (error) {
    const msg = error.message === 'reauthentication_required' ? '二次验证失败。'
      : error.message === 'persistent_main_disabled' ? '后端未启用持久主控（MAIN_ALLOW_PERSISTENT）。请联系运维。'
      : error.message === 'main_confirmation_required' ? '确认口令不匹配。'
      : error.message === 'scope_id_required' ? '请填写会话/项目标识，或选择「全局默认」。'
      : `切换失败：${error.message}`;
    $('#mode-message').textContent = msg;
    closeMainDialog();
  }
});

// Escape / X close — drop pending MAIN state.
$('#main-dialog').addEventListener('close', () => {
  setMainPending(false);
  state.pendingPersistent = false;
});

$('#route-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const task = $('#route-task').value.trim(); if (!task) return;
  const scope = $('#scope').value; const id = $('#scope-id').value.trim(); const body = { task };
  if (scope === 'session' || scope === 'task') body.sessionId = id;
  if (scope === 'project') body.projectId = id;
  try {
    const result = await api('/api/route-preview', { method: 'POST', body: JSON.stringify(body) });
    $('#route-result').textContent = `${renderRoute(result.route)}\n\nPolicy:\n${JSON.stringify(result.policy, null, 2)}`;
  } catch (error) { $('#route-result').textContent = `预览失败：${error.message}`; }
});

(async () => {
  restoreContext();
  $('#build-info').textContent = `build ${BUILD}`;
  applyScopeUi();
  try {
    const loginConfig = await api('/api/login-config');
    state.totpRequired = loginConfig.totpRequired === true;
    $('#login-totp-label').classList.toggle('hidden', !state.totpRequired);
    $('#reauth-totp-label').classList.toggle('hidden', !state.totpRequired);
    $('#login-totp').required = state.totpRequired;
    $('#reauth-totp').required = state.totpRequired;
  } catch {}
  try {
    const session = await api('/api/session');
    state.csrf = session.csrfToken;
    show('dashboard');
    await refresh();
    connectEvents();
    applyScopeUi();
  } catch {
    show('login');
  }
})();