const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  user: null,
  view: viewFromHash() || 'products',
  page: 1,
  pageSize: 18,
  total: 0,
  searchMode: 'hybrid',
  sessionId: null,
  sending: false,
  currentSku: null,
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
const listOf = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const cell = (value) => esc(value === null || value === undefined || value === '' ? '—' : String(value));
// 商品图片统一取：SKU 图 → SPU 封面 → 轮播图首张；只接受 http(s) 或站内绝对路径。
const imageUrlOf = (product) => {
  const urls = [product?.imageUrl, product?.coverUrl, ...listOf(product?.gallery)];
  for (const value of urls) {
    const url = typeof value === 'string' ? value.trim() : '';
    if (/[\s"'<>]/.test(url)) continue; // 含引号/空白的 URL 一律丢弃，避免属性被污染
    if (/^https?:\/\//i.test(url) || (url.startsWith('/') && !url.startsWith('//'))) return url;
  }
  return '';
};
const safeUrl = (value) => {
  const url = String(value ?? '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
};
const scalar = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  if (isObject(value) || Array.isArray(value)) return JSON.stringify(value);
  return String(value);
};
const describe = (value) =>
  isObject(value)
    ? Object.entries(value).map(([k, v]) => `${esc(k)}：${esc(scalar(v))}`).join('　')
    : esc(scalar(value));

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
  container.querySelectorAll('.product-thumb img, .mini-thumb img').forEach((img) => {
    img.addEventListener('error', () => {
      const placeholder = document.createElement('span');
      placeholder.textContent = '▧';
      img.replaceWith(placeholder);
    });
  });
}

function productCard(p) {
  const image = imageUrlOf(p);
  const thumb = image
    ? `<img src="${esc(image)}" alt="${esc(p.name)}" loading="lazy" />`
    : '<span>▧</span>';
  const sourceBadges = Array.isArray(p.sources)
    ? p.sources.map((s) => `<span class="badge">${s === 'semantic' ? '语义' : '关键词'}</span>`).join('')
    : '';
  const scoreBadge = p.score !== undefined
    ? `<span class="badge score">相关度 ${Number(p.score).toFixed(3)}</span>`
    : '';
  return `<article class="product-card" data-sku="${esc(p.skuCode)}" role="link" tabindex="0" title="点击查看商品详情">
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
  $('#auth-form').reset();
  $('#shell').hidden = false;
  $('#user-chip').textContent = `${user.displayName || user.email}${user.role === 'admin' ? ' · 管理员' : ''}`;
  // 根据 hash 恢复视图（或默认 products），进入详情页也会由 applyHash 处理。
  applyHash();
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
  await api('/api/auth/logout', { method: 'POST' }).catch(() => null);
  showLogin();
});

/* -------------------------------- 视图切换 ------------------------------- */

/** 主视图 → hash 路由段。默认 products 不写 hash，URL 保持根路径干净。 */
const VIEW_HASH = {
  search: '#/search',
  chat: '#/chat',
  admin: '#/admin',
  product: null, // 详情页由 #/product/<sku> 单独处理
};

function viewFromHash() {
  const h = location.hash;
  if (!h) return null;
  if (/^#\/product\//.test(h)) return 'product';
  for (const [view, hash] of Object.entries(VIEW_HASH)) {
    if (hash && h === hash) return view;
  }
  return null;
}

function switchView(view, { replaceUrl = false } = {}) {
  state.view = view;
  const navView = view === 'product' ? 'products' : view;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === navView));
  $$('main > .panel').forEach((panel) => (panel.hidden = panel.id !== `view-${view}`));
  if (view === 'chat') loadSessions();
  if (view === 'admin') $('#admin-token').value = state.adminToken;
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // 默认 products 清掉所有 hash，URL 回到 /；其他视图写 hash 便于刷新保留。
  const targetHash = VIEW_HASH[view];
  if (targetHash === undefined) {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  } else if (targetHash && replaceUrl && location.hash !== targetHash) {
    history.replaceState(null, '', targetHash);
  }
}

$$('.nav-item').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view, { replaceUrl: true })));

/* ------------------------------ 商品详情路由 ------------------------------ */

function skuFromHash() {
  const match = location.hash.match(/^#\/product\/(.+)$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function openProduct(skuCode) {
  if (!skuCode) return;
  const target = `#/product/${encodeURIComponent(skuCode)}`;
  if (location.hash === target) showProduct(skuCode);
  else location.hash = target; // 由 hashchange 统一触发导航，避免重复请求
}

function showProduct(skuCode) {
  if (!state.user) return;
  switchView('product');
  loadProductDetail(skuCode);
}

function applyHash() {
  const sku = skuFromHash();
  if (sku) {
    showProduct(sku);
    return;
  }
  const view = viewFromHash();
  if (view && view !== state.view) switchView(view, { replaceUrl: false });
}

window.addEventListener('hashchange', applyHash);

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

/* -------------------------------- 商品详情 ------------------------------- */

function galleryOf(product) {
  const usable = (url) =>
    typeof url === 'string' && /^(https?:\/\/|\/)/i.test(url.trim()) && !/^javascript:/i.test(url.trim());
  return [...new Set([product.coverUrl, product.imageUrl, ...listOf(product.gallery)])]
    .filter(usable)
    .slice(0, 8);
}

function bindMainImage(wrap) {
  const img = wrap.querySelector('#detail-main-img');
  if (!img) return;
  img.addEventListener('error', () => {
    const placeholder = document.createElement('span');
    placeholder.className = 'detail-placeholder';
    placeholder.textContent = '▧';
    img.replaceWith(placeholder);
  });
}

function renderDetail(p) {
  const gallery = galleryOf(p);
  const main = gallery.length
    ? `<img id="detail-main-img" src="${esc(gallery[0])}" alt="${esc(p.name)}" />`
    : '<span class="detail-placeholder">▧</span>';
  const thumbs = gallery.length > 1
    ? `<div class="detail-thumbs">${gallery
        .map((url, i) => `<button class="detail-thumb ${i === 0 ? 'active' : ''}" data-src="${esc(url)}" title="商品图 ${i + 1}"><img src="${esc(url)}" alt="商品图 ${i + 1}" loading="lazy" /></button>`)
        .join('')}</div>`
    : '';

  const badges = [
    `<span class="badge cat">${cell(p.category)}</span>`,
    `<span class="badge ${p.status === '已上架' ? 'on' : ''}">${cell(p.status)}</span>`,
    p.recommended ? '<span class="badge">平台推荐</span>' : '',
    p.afterSales ? '<span class="badge">支持售后</span>' : '',
  ].join('');

  const facts = [
    ['SKU 编码', p.skuCode],
    ['SPU 编码', p.spuCode],
    ['商品类目', p.category],
    ['供应商', p.tenant],
    ['业务类型', p.bizType],
    ['定价方式', p.pricingType],
    ['计价单位', p.unit],
    ['标价', p.listPrice == null ? null : money(p.listPrice)],
    ['价格区间', p.priceRange],
    ['起订量', p.minOrder],
    ['库存', p.stock],
    ['SPU 库存', p.spuStock],
    ['销量 / 浏览', `${Number(p.sales || 0)} / ${Number(p.views || 0)}`],
    ['评价数', p.reviews],
    ['重量 / 体积', `${p.weightKg ?? '—'} kg / ${p.volumeM3 ?? '—'} m³`],
    ['上架状态', p.status],
  ];
  const factsHtml = facts
    .map(([label, value]) => `<div class="fact"><span>${esc(label)}</span><strong>${cell(value)}</strong></div>`)
    .join('');

  const tiers = listOf(p.tierPrices);
  const tiersHtml = tiers.length
    ? `<ul class="detail-list">${tiers.map((t) => `<li>${describe(t)}</li>`).join('')}</ul>`
    : '<p class="muted">暂无阶梯价信息</p>';

  const logisticsHtml = isObject(p.logistics)
    ? `<ul class="detail-list">${Object.entries(p.logistics)
        .map(([k, v]) => `<li>${esc(k)}：${esc(scalar(v))}</li>`)
        .join('')}</ul>`
    : `<p class="muted">${cell(p.logistics)}</p>`;
  const deliveries = listOf(p.delivery);
  const deliveryHtml = deliveries.length
    ? `<ul class="detail-list">${deliveries.map((d) => `<li>${describe(d)}</li>`).join('')}</ul>`
    : '<p class="muted">暂无配送信息</p>';
  const video = safeUrl(p.videoUrl);
  const videoHtml = video
    ? `<section class="detail-section"><h3>商品视频</h3><a class="detail-link" href="${esc(video)}" target="_blank" rel="noopener noreferrer">${esc(video)} ↗</a></section>`
    : '';

  const wrap = $('#product-detail');
  wrap.innerHTML = `<div class="detail-hero">
      <div class="detail-gallery">
        <div class="detail-main">${main}</div>
        ${thumbs}
      </div>
      <div class="detail-info">
        <div class="badges">${badges}</div>
        <h2 class="detail-title">${cell(p.name)}</h2>
        <div class="detail-price">${money(p.price)} <span class="muted">/ ${cell(p.unit || '件')}</span></div>
        <div class="detail-actions">
          <button class="btn primary" data-detail-action="chat">向 AI 咨询这款商品</button>
          <button class="btn" data-detail-action="search">找同类商品</button>
          <button class="btn ghost" data-detail-action="copy">复制 SKU</button>
        </div>
        <div class="detail-facts">${factsHtml}</div>
      </div>
    </div>
    <section class="detail-section"><h3>规格与简介</h3>
      <p class="detail-text"><strong>销售规格：</strong>${cell(p.spec)}</p>
      <p class="detail-text"><strong>商品简介：</strong>${cell(p.intro)}</p>
    </section>
    <section class="detail-section"><h3>阶梯价格</h3>${tiersHtml}</section>
    <section class="detail-section"><h3>物流与配送</h3>
      <h4>物流信息</h4>${logisticsHtml}<h4>配送说明</h4>${deliveryHtml}
    </section>
    ${videoHtml}`;

  bindMainImage(wrap);
  wrap.querySelectorAll('.detail-thumb').forEach((button) => {
    button.addEventListener('click', () => {
      wrap.querySelectorAll('.detail-thumb').forEach((b) => b.classList.toggle('active', b === button));
      wrap.querySelector('.detail-main').innerHTML =
        `<img id="detail-main-img" src="${esc(button.dataset.src)}" alt="商品图" />`;
      bindMainImage(wrap);
    });
  });
  wrap.querySelectorAll('[data-detail-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.detailAction;
      if (action === 'copy') {
        try {
          await navigator.clipboard.writeText(String(p.skuCode || ''));
          toast('SKU 已复制');
        } catch {
          toast(`SKU：${p.skuCode}`);
        }
      } else if (action === 'search') {
        switchView('search');
        $('#search-input').value = String(p.category || p.name || '');
        doSearch();
      } else if (action === 'chat') {
        switchView('chat');
        $('#chat-input').value = `请介绍 SKU ${p.skuCode}（${p.name}），并给出采购建议。`;
        $('#chat-input').focus();
      }
    });
  });
}

async function loadProductDetail(skuCode) {
  state.currentSku = skuCode;
  $('#product-crumb').textContent = `SKU ${skuCode}`;
  $('#product-detail').innerHTML = '<div class="empty">正在加载商品…</div>';
  $('#product-related').innerHTML = '';
  try {
    const { product } = await api(`/api/products/${encodeURIComponent(skuCode)}`);
    renderDetail(product);
    loadRelated(product);
  } catch (error) {
    $('#product-detail').innerHTML = `<div class="empty">${esc(error.message)}</div>`;
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

function appendMessage(role, content, products = [], intent = null) {
  const container = $('#chat-messages');
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = content;
  // 意图识别结果只在本轮展示；历史消息未持久化 intent，回放时保持原样。
  if (intent && role === 'assistant') {
    const tag = document.createElement('div');
    tag.className = 'msg-intent';
    tag.textContent = `意图识别：${intent.label || '未分类'} · ${intent.shouldRecommend ? '已检索商品库' : '无需商品推荐'}`;
    el.appendChild(tag);
  }
  const all = Array.isArray(products) ? products : [];
  if (all.length) {
    // 对话回复可能引用 [1]~[6]，卡片只展示前三条，避免长列表挤占聊天区。
    const shown = all.slice(0, 3);
    const box = document.createElement('div');
    box.className = 'msg-products';
    box.innerHTML = shown
      .map((p) => {
        const image = imageUrlOf(p);
        const thumb = image
          ? `<div class="mini-thumb"><img src="${esc(image)}" alt="${esc(p.name)}" loading="lazy" /></div>`
          : '<div class="mini-thumb"><span>▧</span></div>';
        return `<div class="mini-card" data-sku="${esc(p.skuCode)}" role="link" tabindex="0" title="点击查看商品详情">
        ${thumb}
        <div class="mini-info">
          <div class="mini-name">${p.index ? `[${esc(p.index)}] ` : ''}${esc(p.name)}</div>
          <div class="mini-price">${money(p.price)}</div>
          <div class="muted">${esc(p.category || '未分类')}</div>
          <div class="mini-link">查看详情 →</div>
        </div>
      </div>`;
      })
      .join('');
    el.appendChild(box);
    bindImages(box); // 图片 404 时换成占位符，不留破图
    if (all.length > shown.length) {
      const more = document.createElement('div');
      more.className = 'msg-products-more muted';
      more.textContent = `仅展示前 ${shown.length} 件推荐商品，其余 ${all.length - shown.length} 件可在商品检索中查看。`;
      el.appendChild(more);
    }
  }
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function welcomeMessage() {
  $('#chat-messages').innerHTML = '';
  appendMessage('system', '描述采购需求，我会先判断是否需要推荐，再检索商品库给出建议；也可以直接打招呼、问我能做什么。');
}

async function loadSessions() {
  try {
    const { sessions } = await api('/api/chat/sessions');
    const list = $('#session-list');
    list.innerHTML = sessions.length
      ? sessions.map((s) => `<div class="session-item ${s.id === state.sessionId ? 'active' : ''}" role="button" tabindex="0" data-id="${esc(s.id)}"><span class="session-title">${esc(s.title)}</span><button class="session-del" data-del="${esc(s.id)}" title="删除">×</button></div>`).join('')
      : '<p class="muted">暂无历史对话</p>';
    list.querySelectorAll('.session-item').forEach((el) => {
      const id = el.dataset.id;
      const open = () => openSession(id);
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
    list.querySelectorAll('.session-del').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.del;
        if (!confirm('确定删除这条对话记录吗？')) return;
        try {
          await api(`/api/chat/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
          if (state.sessionId === id) {
            state.sessionId = null;
            $('#chat-messages').innerHTML = '';
            welcomeMessage();
          }
          loadSessions();
        } catch (error) {
          toast(error.message);
        }
      });
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
$('#admin-ai-status-btn').addEventListener('click', async () => {
  try {
    const result = await api('/api/admin/ai-search/status', { headers: adminHeaders() });
    output(result.aiSearch ?? result);
  } catch (error) {
    output(`AI Search 状态读取失败：${error.message}`);
  }
});
$('#admin-ai-sync-btn').addEventListener('click', () =>
  adminAction('AI Search 知识库同步（第 1 批）', '/api/admin/ai-search/sync', {
    kind: 'kb', offset: 0, limit: 40,
  }),
);
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
