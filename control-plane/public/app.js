const state = { csrf: '', source: null };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) };
  if (options.method && options.method !== 'GET' && state.csrf) headers['x-csrf-token'] = state.csrf;
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => ({}));
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
  if (scope === 'session') return `?sessionId=${encodeURIComponent(id)}`;
  if (scope === 'project') return `?projectId=${encodeURIComponent(id)}`;
  return '';
}

function renderMetrics(metrics = {}) {
  const definitions = [
    ['事件总数', metrics.totalEvents || 0],
    ['主控被拦截', metrics.blockedMainActions || 0],
    ['路由到 Worker', metrics.routeToWorker || 0],
    ['Worker 失败', metrics.workerFailures || 0],
  ];
  const root = $('#metrics');
  root.replaceChildren(...definitions.map(([label, value]) => {
    const card = document.createElement('article');
    card.className = 'card metric';
    const number = document.createElement('strong');
    number.textContent = value;
    const text = document.createElement('span');
    text.textContent = label;
    card.append(number, text);
    return card;
  }));
}

function compactEvent(event) {
  const copy = { ...event };
  delete copy.id;
  delete copy.at;
  delete copy.type;
  delete copy.task;
  return JSON.stringify(copy);
}

function renderEvents(events = []) {
  const tbody = $('#events');
  tbody.replaceChildren(...events.map((event) => {
    const row = document.createElement('tr');
    if (event.type === 'tool.blocked') row.classList.add('danger-row');
    const time = document.createElement('td');
    time.textContent = new Date(event.at).toLocaleString();
    const type = document.createElement('td');
    type.textContent = event.type;
    const role = document.createElement('td');
    role.textContent = event.role || event.actor || '—';
    const details = document.createElement('td');
    details.textContent = event.task || compactEvent(event);
    row.append(time, type, role, details);
    return row;
  }));
}

function renderRoute(route) {
  if (!route) return '暂无记录';
  const reasons = (route.reasons || []).map((item) => `${item.points > 0 ? '+' : ''}${item.points} ${item.reason}`).join('\n');
  return [
    `Actor: ${String(route.actor || '').toUpperCase()}`,
    `Decision: ${route.decision || '—'}`,
    `Score: ${route.score ?? '—'}`,
    `Confidence: ${route.confidence ? `${Math.round(route.confidence * 100)}%` : '—'}`,
    reasons ? `\nReasons:\n${reasons}` : '',
  ].filter(Boolean).join('\n');
}

async function refresh() {
  const [status, eventData] = await Promise.all([
    api(`/api/status${contextQuery()}`),
    api('/api/events?limit=100'),
  ]);
  $('#resolved-mode').textContent = status.resolvedMode.mode.toUpperCase();
  $('#mode-source').textContent = `来源：${status.resolvedMode.source}`;
  renderMetrics(status.metrics);
  $('#latest-route').textContent = renderRoute(status.latestRoute);
  renderEvents(eventData.events);
}

function connectEvents() {
  state.source?.close();
  const source = new EventSource('/api/stream');
  state.source = source;
  source.addEventListener('ready', () => { $('#connection').textContent = '实时连接'; });
  source.addEventListener('control', () => refresh().catch(() => {}));
  source.onerror = () => { $('#connection').textContent = '重新连接中'; };
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  try {
    const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
    state.csrf = result.csrfToken;
    $('#password').value = '';
    show('dashboard');
    await refresh();
    connectEvents();
  } catch (error) {
    $('#login-error').textContent = error.message === 'login_temporarily_blocked' ? '登录尝试过多，请稍后再试。' : '密码错误。';
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
  state.source?.close();
  state.csrf = '';
  show('login');
});

$('#scope').addEventListener('change', () => {
  $('#scope-id-label').classList.toggle('hidden', $('#scope').value === 'global');
  refresh().catch(() => {});
});
$('#scope-id').addEventListener('change', () => refresh().catch(() => {}));
$('#refresh').addEventListener('click', () => refresh());

$$('.mode-button').forEach((button) => button.addEventListener('click', async () => {
  const mode = button.dataset.mode;
  const scope = $('#scope').value;
  const id = scope === 'global' ? '' : $('#scope-id').value.trim();
  if (!id && scope !== 'global') {
    $('#mode-message').textContent = '请输入会话或项目标识。';
    return;
  }
  let reauthPassword = '';
  if (mode === 'main') {
    reauthPassword = window.prompt('仅主控模式会开放执行权限，请重新输入控制台密码：') || '';
    if (!reauthPassword) return;
  }
  try {
    const result = await api('/api/mode', {
      method: 'PUT',
      body: JSON.stringify({ mode, scope, id, ttlMinutes: Number($('#ttl').value), reauthPassword }),
    });
    $('#mode-message').textContent = `已切换为 ${result.entry.mode.toUpperCase()}${result.entry.expiresAt ? `，到期 ${new Date(result.entry.expiresAt).toLocaleString()}` : ''}`;
    await refresh();
  } catch (error) {
    $('#mode-message').textContent = error.message === 'reauthentication_required' ? '二次验证失败。' : `切换失败：${error.message}`;
  }
}));

$('#route-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const task = $('#route-task').value.trim();
  if (!task) return;
  const scope = $('#scope').value;
  const id = $('#scope-id').value.trim();
  const body = { task };
  if (scope === 'session') body.sessionId = id;
  if (scope === 'project') body.projectId = id;
  const result = await api('/api/route', { method: 'POST', body: JSON.stringify(body) });
  $('#route-result').textContent = `${renderRoute(result.route)}\n\nPolicy:\n${JSON.stringify(result.policy, null, 2)}`;
});

(async () => {
  try {
    const session = await api('/api/session');
    state.csrf = session.csrfToken;
    show('dashboard');
    await refresh();
    connectEvents();
  } catch {
    show('login');
  }
})();
