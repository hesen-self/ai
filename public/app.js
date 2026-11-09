const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  user: null,
  view: 'products',
  page: 1,
  pageSize: 20,
  total: 0,
  searchMode: 'hybrid',
  sessionId: null,
  sending: false,
  adminToken: sessionStorage.getItem('cf_admin_token') || '',
};

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const money = (value) => `¥${Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { credentials: 'include', ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !path.startsWith('/api/auth/') && !path.startsWith('/api/admin/')) {
    showLogin();
    throw new Error(data.error || '会话已失效，请重新登录');
  }
  if (!response.ok) throw new Error(data.error || `请求失败 HTTP ${response.status}`);
  return data;
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

function bindImages(container) {
  container.querySelectorAll('.product-thumb img').forEach((img) => {
    img.addEventListener('error', () => {
      const placeholder = document.createElement('span');
      placeholder.textContent = '▧';
      img.replaceWith(placeholder);
    });
  });
}

function productCard(p) {
  const thumb = p.imageUrl
    ? `<img src="${esc(p.imageUrl)}" alt="${esc(p.name)}" loading="lazy" />`
    : '<span>▧</span>';
  const sourceBadges = Array.isArray(p.sources)
    ? p.sources.map((s) => `<span class="badge">${s === 'semantic' ? '语义' : '关键词'}</span>`).join('')
    : '';
  const scoreBadge = p.score !== undefined
    ? `<span class="badge score">相关度 ${Number(p.score).toFixed(3)}</span>`
    : '';
  return `<article class="product-card">
    <div class="product-thumb">${thumb}</div>
    <div class="product-body">
      <div class="product-title" title="${esc(p.name)}">${esc(p.name)}</div>
      <div class="product-spec" title="${esc(p.spec)}">${esc(p.spec || '暂无规格信息')}</div>
      <div class="badges">
        <span class="badge cat">${esc(p.category || '未分类')}</span>
        <span class="badge ${p.status === '已上架' ? 'on' : ''}">${esc(p.status)}</span>
        ${p.recommended ? '<span class="badge">推荐</span>' : ''}
        ${sourceBadges}${scoreBadge}
      </div>
      <div class="product-meta"><span class="price">${money(p.price)}</span><span>${esc(p.unit || '件')}</span></div>
      <div class="product-meta"><span title="${esc(p.tenant)}">${esc(p.tenant || '未标注供应商')}</span><span>库存 ${Number(p.stock || 0)}</span></div>
    </div>
  </article>`;
}

function renderCards(container, items, emptyText) {
  container.innerHTML = items.length
    ? items.map(productCard).join('')
    : `<div class="empty">${esc(emptyText)}</div>`;
  bindImages(container);
}

/* ------------------------------ 会话 / 登录 ------------------------------ */

function showLogin() {
  state.user = null;
  $('#shell').hidden = true;
  $('#login-view').hidden = false;
}

function enterApp(user) {
  state.user = user;
  $('#login-view').hidden = true;
  $('#shell').hidden = false;
  $('#user-chip').textContent = `${user.displayName || user.email}${user.role === 'admin' ? ' · 管理员' : ''}`;
  loadFacets();
  loadProducts();
}

let authMode = 'login';
$$('#auth-tabs .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    authMode = tab.dataset.auth;
    $$('#auth-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('#display-name-field').hidden = authMode !== 'register';
    $('#auth-submit').textContent = authMode === 'register' ? '创建账号' : '登录';
    $('#auth-error').textContent = '';
  });
});

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  const displayName = $('#auth-name').value.trim();
  const button = $('#auth-submit');
  button.disabled = true;
  $('#auth-error').textContent = '';
  try {
    const { user } = await api(`/api/auth/${authMode}`, {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName }),
    });
    enterApp(user);
  } catch (error) {
    $('#auth-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => null);
  showLogin();
});

/* -------------------------------- 视图切换 ------------------------------- */

function switchView(view) {
  state.view = view;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('main > .panel').forEach((panel) => (panel.hidden = panel.id !== `view-${view}`));
  if (view === 'chat') loadSessions();
  if (view === 'admin') $('#admin-token').value = state.adminToken;
}

$$('.nav-item').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));

/* -------------------------------- 商品列表 ------------------------------- */

function filtersFromForm() {
  return {
    q: $('#filter-q').value.trim(),
    category: $('#filter-category').value,
    tenant: $('#filter-tenant').value,
    sort: $('#filter-sort').value,
    recommended: $('#filter-recommended').checked,
  };
}

async function loadProducts() {
  const filters = filtersFromForm();
  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
    sort: filters.sort,
  });
  if (filters.q) params.set('q', filters.q);
  if (filters.category) params.set('category', filters.category);
  if (filters.tenant) params.set('tenant', filters.tenant);
  if (filters.recommended) params.set('recommended', 'true');
  try {
    const data = await api(`/api/products?${params}`);
    state.total = data.total;
    renderCards($('#product-grid'), data.items, '没有符合条件的商品');
    $('#product-stats').textContent = `共 ${data.total.toLocaleString('zh-CN')} 件在售商品`;
    const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
    $('#page-info').textContent = `第 ${data.page} / ${pages} 页`;
    $('#page-prev').disabled = data.page <= 1;
    $('#page-next').disabled = data.page >= pages;
  } catch (error) {
    toast(error.message);
  }
}

async function loadFacets() {
  try {
    const facets = await api('/api/products/facets');
    const fill = (selector, list, label) => {
      const el = $(selector);
      el.innerHTML = `<option value="">${label}</option>` +
        list.map((x) => `<option value="${esc(x.value)}">${esc(x.value)} (${x.count})</option>`).join('');
    };
    fill('#filter-category', facets.categories || [], '全部类目');
    fill('#filter-tenant', facets.tenants || [], '全部供应商');
  } catch (error) {
    console.warn('筛选条件加载失败', error);
  }
}

let filterTimer;
['#filter-q', '#filter-category', '#filter-tenant', '#filter-sort'].forEach((selector) => {
  $(selector).addEventListener('input', () => {
    if (selector !== '#filter-q') return;
    clearTimeout(filterTimer);
    state.page = 1;
    filterTimer = setTimeout(loadProducts, 260);
  });
  $(selector).addEventListener('change', () => {
    state.page = 1;
    loadProducts();
  });
});
$('#filter-recommended').addEventListener('change', () => {
  state.page = 1;
  loadProducts();
});

$('#filter-reset').addEventListener('click', () => {
  $('#filter-q').value = '';
  $('#filter-category').value = '';
  $('#filter-tenant').value = '';
  $('#filter-sort').value = 'updated';
  $('#filter-recommended').checked = false;
  state.page = 1;
  loadProducts();
});

$('#page-prev').addEventListener('click', () => { if (state.page > 1) { state.page -= 1; loadProducts(); } });
$('#page-next').addEventListener('click', () => {
  if (state.page * state.pageSize < state.total) { state.page += 1; loadProducts(); }
});

/* -------------------------------- 商品检索 ------------------------------- */

$$('#search-modes .seg').forEach((button) => {
  button.addEventListener('click', () => {
    state.searchMode = button.dataset.mode;
    $$('#search-modes .seg').forEach((b) => b.classList.toggle('active', b === button));
  });
});

$$('#search-examples .chip-btn').forEach((button) => {
  button.addEventListener('click', () => {
    $('#search-input').value = button.dataset.q;
    doSearch();
  });
});

$('#search-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') doSearch();
});
$('#search-btn').addEventListener('click', doSearch);

async function doSearch() {
  const query = $('#search-input').value.trim();
  if (!query) { toast('请输入检索内容'); return; }
  const button = $('#search-btn');
  button.disabled = true;
  $('#search-summary').textContent = '检索中…';
  try {
    const data = await api('/api/search', {
      method: 'POST',
      body: JSON.stringify({ query, mode: state.searchMode, topK: 12 }),
    });
    const label = { hybrid: '混合', semantic: '语义', keyword: '关键词' }[data.mode];
    $('#search-summary').textContent =
      `${label}检索「${query}」：命中 ${data.count} 件（关键词 ${data.keywordCount} / 语义 ${data.semanticCount}）`;
    renderCards($('#search-results'), data.items, '没有检索到相关商品，换个说法试试');
  } catch (error) {
    $('#search-summary').textContent = '';
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

/* -------------------------------- 对话推荐 ------------------------------- */

function appendMessage(role, content, products = []) {
  const container = $('#chat-messages');
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = content;
  if (Array.isArray(products) && products.length) {
    const box = document.createElement('div');
    box.className = 'msg-products';
    box.innerHTML = products
      .map((p) => `<div class="mini-card">
        <div class="mini-name">[${esc(p.index)}] ${esc(p.name)}</div>
        <div class="mini-price">${money(p.price)}</div>
        <div class="muted">${esc(p.category || '未分类')}</div>
      </div>`)
      .join('');
    el.appendChild(box);
  }
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function welcomeMessage() {
  $('#chat-messages').innerHTML = '';
  appendMessage('system', '描述你的采购需求，我会从商品库和知识库里检索后给出推荐。');
}

async function loadSessions() {
  try {
    const { sessions } = await api('/api/chat/sessions');
    const list = $('#session-list');
    list.innerHTML = sessions.length
      ? sessions.map((s) => `<button class="session-item ${s.id === state.sessionId ? 'active' : ''}" data-id="${esc(s.id)}">${esc(s.title)}</button>`).join('')
      : '<p class="muted">暂无历史对话</p>';
    list.querySelectorAll('.session-item').forEach((button) => {
      button.addEventListener('click', () => openSession(button.dataset.id));
    });
  } catch (error) {
    toast(error.message);
  }
}

async function openSession(id) {
  try {
    const { messages } = await api(`/api/chat/sessions/${encodeURIComponent(id)}`);
    state.sessionId = id;
    $('#chat-messages').innerHTML = '';
    messages.forEach((m) => appendMessage(m.role, m.content, m.products));
    if (!messages.length) welcomeMessage();
    $$('.session-item').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
  } catch (error) {
    toast(error.message);
  }
}

$('#new-session-btn').addEventListener('click', () => {
  state.sessionId = null;
  welcomeMessage();
  $$('.session-item').forEach((b) => b.classList.remove('active'));
  $('#chat-input').focus();
});

$('#chat-send').addEventListener('click', sendChat);
$('#chat-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') sendChat(); });

async function sendChat() {
  const input = $('#chat-input');
  const message = input.value.trim();
  if (!message || state.sending) return;
  state.sending = true;
  input.value = '';
  $('#chat-send').disabled = true;
  appendMessage('user', message);
  appendMessage('system', '正在检索商品库与知识库…');
  try {
    const data = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ sessionId: state.sessionId, message }),
    });
    $('#chat-messages').lastElementChild?.remove();
    appendMessage('assistant', data.reply, data.products);
    state.sessionId = data.sessionId;
    if (data.degraded) toast('AI 生成暂时不可用，已用检索结果直接作答');
    loadSessions();
  } catch (error) {
    $('#chat-messages').lastElementChild?.remove();
    appendMessage('assistant', `抱歉，出错了：${error.message}`);
  } finally {
    state.sending = false;
    $('#chat-send').disabled = false;
    input.focus();
  }
}

/* --------------------------------- 运维 ---------------------------------- */

function adminHeaders() {
  state.adminToken = $('#admin-token').value.trim();
  sessionStorage.setItem('cf_admin_token', state.adminToken);
  return { 'X-Admin-Token': state.adminToken };
}

function output(value) {
  $('#admin-output').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function adminAction(label, path, body) {
  try {
    output(`${label}…`);
    const result = await api(path, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(body || {}),
    });
    output(result);
    toast(`${label}完成`);
  } catch (error) {
    output(`${label}失败：${error.message}`);
  }
}

$('#admin-status-btn').addEventListener('click', async () => {
  try {
    const result = await api('/api/admin/status', { headers: adminHeaders() });
    output(result);
  } catch (error) {
    output(`状态读取失败：${error.message}`);
  }
});

$('#admin-migrate-btn').addEventListener('click', () => adminAction('数据库迁移', '/api/admin/migrate'));
$('#admin-knowledge-btn').addEventListener('click', async () => {
  await adminAction('知识库构建（第 1 批）', '/api/admin/build-knowledge', { offset: 0, limit: 120 });
  toast('如需全量构建，请运行 npm run ingest:knowledge');
});
$('#admin-schema-btn').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/admin/schema', { headers: adminHeaders() });
    output(await response.text());
  } catch (error) {
    output(`DDL 读取失败：${error.message}`);
  }
});

/* --------------------------------- 启动 ---------------------------------- */

(async function boot() {
  try {
    const { user } = await api('/api/auth/session');
    if (user) enterApp(user);
    else showLogin();
  } catch {
    showLogin();
  }
  welcomeMessage();
})();
