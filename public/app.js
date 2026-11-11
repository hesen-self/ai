/* 前端入口：状态、SPA path 路由、鉴权、各视图的数据加载与业务编排。
 * 渲染层在 render.js，DOM/格式化工具在 ui.js，站内信在 notify-ui.js，运维面板在 admin-ui.js。
 * 经典脚本（index.html 以 defer 顺序加载），顶层声明进入全局词法作用域。 */
/* global $, $$, el, toast, skeletonCards, renderCards, appendMessage, renderDetail */
/* global startNotifyPolling, stopNotifyPolling, closeNotifyDrawer */

/** 主视图 → URL 路径。默认 products 是根路径 /；其他视图用 /xxx。
 *  必须在 state 之前声明，因为 state.view 初始化时会调用 viewFromPath() 访问本常量。 */
const VIEW_PATH = {
  search: '/search',
  chat: '/chat',
  admin: '/admin',
  product: null, // 详情页由 /product/<sku> 单独处理
};

const state = {
  user: null,
  view: viewFromPath() || 'products',
  page: 1,
  pageSize: 18,
  total: 0,
  searchMode: 'hybrid',
  sessionId: null,
  sending: false,
  currentSku: null,
  adminToken: sessionStorage.getItem('cf_admin_token') || '',
  notifications: [],
  notifyUnread: 0,
  notifyDrawerOpen: false,
  notifyPollTimer: null,
};

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

/* ------------------------------ 会话 / 登录 ------------------------------ */

function showLogin() {
  state.user = null;
  $('#boot-loading').hidden = true;
  $('#shell').hidden = true;
  $('#login-view').hidden = false;
}

function enterApp(user) {
  state.user = user;
  $('#boot-loading').hidden = true;
  $('#login-view').hidden = true;
  $('#auth-form').reset();
  $('#shell').hidden = false;
  $('#user-chip').textContent = `${user.displayName || user.email}${user.role === 'admin' ? ' · 管理员' : ''}`;
  // 根据 pathname 恢复视图（或默认 products），进入详情页也会由 applyPath 处理。
  applyPath();
  if (state.view === 'products') {
    loadFacets();
    loadProducts();
  }
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
  // 登出接口失败也继续本地登出，但留下日志便于排障。
  await api('/api/auth/logout', { method: 'POST' }).catch((error) => console.warn('登出接口调用失败', error));
  stopNotifyPolling();
  closeNotifyDrawer();
  showLogin();
});

/* -------------------------------- 视图切换 ------------------------------- */

/** 从 pathname 解析出当前视图名，或 null（根路径 /）。 */
function viewFromPath() {
  const p = location.pathname;
  if (/^\/product\//.test(p)) return 'product';
  for (const [view, path] of Object.entries(VIEW_PATH)) {
    if (path && p === path) return view;
  }
  return null;
}

/** 切换视图，可选是否写入浏览器历史。 */
function switchView(view, { replaceUrl = false, pushUrl = false } = {}) {
  state.view = view;
  const navView = view === 'product' ? 'products' : view;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === navView));
  $$('main > .panel').forEach((panel) => (panel.hidden = panel.id !== `view-${view}`));
  if (view === 'chat') loadSessions();
  if (view === 'admin') $('#admin-token').value = state.adminToken;
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // 同步浏览器 URL：默认 products 回到 /；其他视图写 /path。
  const targetPath = VIEW_PATH[view] ?? '/';
  const currentPath = location.pathname;
  if (targetPath !== currentPath) {
    if (pushUrl) history.pushState(null, '', targetPath);
    else if (replaceUrl) history.replaceState(null, '', targetPath);
  }
}

$$('.nav-item').forEach((button) => button.addEventListener('click', () =>
  switchView(button.dataset.view, { pushUrl: true }),
));

/* ------------------------------ 商品详情路由 ------------------------------ */

function skuFromPath() {
  const match = location.pathname.match(/^\/product\/(.+)$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function openProduct(skuCode) {
  if (!skuCode) return;
  const target = `/product/${encodeURIComponent(skuCode)}`;
  if (location.pathname === target) {
    showProduct(skuCode);
  } else {
    history.pushState(null, '', target);
    showProduct(skuCode);
  }
}

function showProduct(skuCode) {
  if (!state.user) return;
  switchView('product');
  loadProductDetail(skuCode);
}

function applyPath() {
  const sku = skuFromPath();
  if (sku) {
    showProduct(sku);
    return;
  }
  const view = viewFromPath();
  // 注意：无论 state.view 当前值是什么都必须调 switchView ——
  // 因为 state.view 初始化时从 pathname 读对了，但 panel.hidden 从来没被同步过。
  if (view) switchView(view);
}

window.addEventListener('popstate', applyPath);

// 商品卡片 / 聊天卡片统一事件委托：点击与回车都进入详情。
document.addEventListener('click', (event) => {
  const card = event.target.closest?.('[data-sku]');
  if (card?.dataset.sku) openProduct(card.dataset.sku);
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const card = event.target.closest?.('.product-card[data-sku], .mini-card[data-sku]');
  if (card?.dataset.sku) openProduct(card.dataset.sku);
});

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
  const grid = $('#product-grid');
  // 有旧内容时保留到结果返回（翻页/筛选不闪骨架），无内容才画骨架。
  if (!grid.querySelector('.product-card')) grid.replaceChildren(...skeletonCards(12));
  try {
    const data = await api(`/api/products?${params}`);
    state.total = data.total;
    renderCards(grid, data.items, '没有符合条件的商品');
    $('#product-stats').textContent = `共 ${data.total.toLocaleString('zh-CN')} 件在售商品`;
    const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
    $('#page-info').textContent = `第 ${data.page} / ${pages} 页`;
    $('#page-prev').disabled = data.page <= 1;
    $('#page-next').disabled = data.page >= pages;
  } catch (error) {
    if (grid.querySelector('.skeleton-card')) {
      // 首屏/重试失败：把错误留在页面上并给重试入口，而不是空白或一闪而过的 toast。
      const retry = el('button', { class: 'btn', type: 'button', text: '重试' });
      retry.addEventListener('click', loadProducts);
      grid.replaceChildren(el('div', { class: 'empty' },
        `商品列表加载失败：${error.message}`,
        el('div', { class: 'empty-actions' }, retry)));
    } else {
      toast(error.message);
    }
  }
}

async function loadFacets() {
  try {
    const facets = await api('/api/products/facets');
    const fill = (selector, list, label) => {
      $(selector).replaceChildren(
        el('option', { value: '', text: label }),
        ...list.map((x) => el('option', { value: x.value, text: `${x.value} (${x.count})` })));
    };
    fill('#filter-category', facets.categories || [], '全部类目');
    fill('#filter-tenant', facets.tenants || [], '全部供应商');
  } catch (error) {
    console.warn('筛选条件加载失败', error);
    toast('筛选条件加载失败，可直接输入关键词搜索');
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

/* -------------------------------- 商品详情 ------------------------------- */

async function loadProductDetail(skuCode) {
  state.currentSku = skuCode;
  $('#product-crumb').textContent = `SKU ${skuCode}`;
  $('#product-detail').replaceChildren(el('div', { class: 'empty', text: '正在加载商品…' }));
  $('#product-related').replaceChildren();
  try {
    const { product } = await api(`/api/products/${encodeURIComponent(skuCode)}`);
    renderDetail(product);
    loadRelated(product);
  } catch (error) {
    $('#product-detail').replaceChildren(el('div', { class: 'empty', text: error.message }));
  }
}

async function loadRelated(product) {
  const params = new URLSearchParams({ page: '1', pageSize: '6', sort: 'popular', status: '已上架' });
  if (product.category) params.set('category', String(product.category));
  try {
    const data = await api(`/api/products?${params}`);
    const items = (data.items || [])
      .filter((item) => String(item.skuCode) !== String(product.skuCode))
      .slice(0, 6);
    renderCards($('#product-related'), items, '暂无同类商品');
  } catch {
    renderCards($('#product-related'), [], '相关商品加载失败');
  }
}

$('#product-back').addEventListener('click', () => {
  history.replaceState(null, '', location.pathname + location.search);
  switchView('products');
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
    $('#search-summary').textContent = `${label}检索「${query}」：命中 ${data.count} 件（关键词 ${data.keywordCount} / 语义 ${data.semanticCount}）`;
    renderCards($('#search-results'), data.items, '没有检索到相关商品，换个说法试试');
  } catch (error) {
    $('#search-summary').textContent = '';
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

/* -------------------------------- 对话推荐 ------------------------------- */

function welcomeMessage() {
  $('#chat-messages').replaceChildren();
  appendMessage('system', '描述采购需求，我会先判断是否需要推荐，再检索商品库给出建议；也可以直接打招呼、问我能做什么。');
}

async function loadSessions() {
  try {
    const { sessions } = await api('/api/chat/sessions');
    const list = $('#session-list');
    if (!sessions.length) {
      list.replaceChildren(el('p', { class: 'muted', text: '暂无历史对话' }));
      return;
    }
    list.replaceChildren(...sessions.map((s) => {
      const delBtn = el('button', { class: 'session-del', dataset: { del: s.id }, title: '删除', text: '×' });
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = s.id;
        if (!confirm('确定删除这条对话记录吗？')) return;
        try {
          await api(`/api/chat/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
          if (state.sessionId === id) {
            state.sessionId = null;
            $('#chat-messages').replaceChildren();
            welcomeMessage();
          }
          loadSessions();
        } catch (error) {
          toast(error.message);
        }
      });
      const item = el('div', { class: `session-item ${s.id === state.sessionId ? 'active' : ''}`, role: 'button', tabindex: '0', dataset: { id: s.id } },
        el('span', { class: 'session-title', text: s.title }),
        delBtn);
      const open = () => openSession(s.id);
      item.addEventListener('click', open);
      item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      return item;
    }));
  } catch (error) {
    toast(error.message);
  }
}

async function openSession(id) {
  try {
    const { messages } = await api(`/api/chat/sessions/${encodeURIComponent(id)}`);
    state.sessionId = id;
    $('#chat-messages').replaceChildren();
    // 历史消息里的 products 带 imageUrl，缩略图在回放时同样渲染。
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
  appendMessage('system', '正在理解你的问题…');
  try {
    const data = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ sessionId: state.sessionId, message }),
    });
    $('#chat-messages').lastElementChild?.remove();
    appendMessage('assistant', data.reply, data.products, {
      label: data.intentLabel,
      shouldRecommend: data.shouldRecommend,
    });
    state.sessionId = data.sessionId;
    if (data.degraded) {
      toast(data.shouldRecommend ? 'AI 生成暂时不可用，已用检索结果直接作答' : 'AI 生成暂时不可用，已用内置话术作答');
    }
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

/* --------------------------------- 启动 ---------------------------------- */

(async function boot() {
  try {
    const resp = await fetch('/api/auth/session', { credentials: 'include' });
    const data = await resp.json();
    console.log('[boot] session check', { status: resp.status, user: data.user });
    if (data.user) {
      enterApp(data.user);
      startNotifyPolling();
    } else {
      showLogin();
    }
  } catch (err) {
    console.error('[boot] session check failed', err);
    showLogin();
  }
  welcomeMessage();
})();
