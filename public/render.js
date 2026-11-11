/* 商品卡片、商品详情、聊天卡片的渲染层。
 * 全部通过 ui.js 的 el() 构建 DOM（textContent / setAttribute 自动转义），不使用 innerHTML。 */
/* exported skeletonCards, productCard, renderCards, appendMessage, renderDetail */
/* global $, el, money, cell, listOf, isObject, scalar, describe, imageUrlOf, safeUrl, bindImages, toast, switchView, doSearch */

/** 骨架卡片：首屏或上次失败后 grid 无内容时占位，避免加载期一片空白。 */
function skeletonCards(count) {
  return Array.from({ length: count }, () =>
    el('div', { class: 'skeleton-card', 'aria-hidden': 'true' },
      el('div', { class: 'skeleton-thumb' }),
      el('div', { class: 'skeleton-body' },
        el('div', { class: 'skeleton-line w80' }),
        el('div', { class: 'skeleton-line w60' }),
        el('div', { class: 'skeleton-line w40' }))));
}

function productCard(p) {
  const image = imageUrlOf(p);
  const badges = [
    el('span', { class: 'badge cat', text: p.category || '未分类' }),
    el('span', { class: `badge ${p.status === '已上架' ? 'on' : ''}`, text: p.status }),
    p.recommended ? el('span', { class: 'badge', text: '推荐' }) : null,
    ...(Array.isArray(p.sources)
      ? p.sources.map((s) => el('span', { class: 'badge', text: s === 'semantic' ? '语义' : '关键词' }))
      : []),
    p.score !== undefined
      ? el('span', { class: 'badge score', text: `相关度 ${Number(p.score).toFixed(3)}` })
      : null,
  ];
  return el('article', { class: 'product-card', dataset: { sku: p.skuCode }, role: 'link', tabindex: '0', title: '点击查看商品详情' },
    el('div', { class: 'product-thumb' },
      image ? el('img', { src: image, alt: p.name, loading: 'lazy' }) : el('span', { text: '▧' })),
    el('div', { class: 'product-body' },
      el('div', { class: 'product-title', title: p.name ?? '', text: p.name }),
      el('div', { class: 'product-spec', title: p.spec ?? '', text: p.spec || '暂无规格信息' }),
      el('div', { class: 'badges' }, badges),
      el('div', { class: 'product-meta' },
        el('span', { class: 'price', text: money(p.price) }),
        el('span', { text: p.unit || '件' })),
      el('div', { class: 'product-meta' },
        el('span', { title: p.tenant ?? '', text: p.tenant || '未标注供应商' }),
        el('span', { text: `库存 ${Number(p.stock || 0)}` }))));
}

function renderCards(container, items, emptyText) {
  container.replaceChildren(...(items.length
    ? items.map(productCard)
    : [el('div', { class: 'empty', text: emptyText })]));
  bindImages(container);
}

/* -------------------------------- 商品详情 -------------------------------- */

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
  const mainWrap = el('div', { class: 'detail-main' },
    gallery.length
      ? el('img', { id: 'detail-main-img', src: gallery[0], alt: p.name })
      : el('span', { class: 'detail-placeholder', text: '▧' }));
  const thumbs = gallery.length > 1
    ? el('div', { class: 'detail-thumbs' }, gallery.map((url, i) =>
        el('button', { class: `detail-thumb ${i === 0 ? 'active' : ''}`, dataset: { src: url }, title: `商品图 ${i + 1}` },
          el('img', { src: url, alt: `商品图 ${i + 1}`, loading: 'lazy' }))))
    : null;

  const badges = el('div', { class: 'badges' },
    el('span', { class: 'badge cat', text: cell(p.category) }),
    el('span', { class: `badge ${p.status === '已上架' ? 'on' : ''}`, text: cell(p.status) }),
    p.recommended ? el('span', { class: 'badge', text: '平台推荐' }) : null,
    p.afterSales ? el('span', { class: 'badge', text: '支持售后' }) : null);

  // 首屏只给采购决策核心字段，其余参数折叠进"更多参数"，避免 16 块参数墙。
  const factItem = ([label, value]) =>
    el('div', { class: 'fact' }, el('span', { text: label }), el('strong', { text: cell(value) }));
  const coreFacts = [
    ['供应商', p.tenant],
    ['库存', p.stock],
    ['起订量', p.minOrder],
    ['标价', p.listPrice == null ? null : money(p.listPrice)],
  ];

  const moreGroups = [
    ['交易', [
      ['价格区间', p.priceRange],
      ['定价方式', p.pricingType],
      ['SPU 库存', p.spuStock],
      ['计价单位', p.unit],
    ]],
    ['规格', [
      ['SKU 编码', p.skuCode],
      ['SPU 编码', p.spuCode],
      ['商品类目', p.category],
      ['业务类型', p.bizType],
      ['重量 / 体积', `${p.weightKg ?? '—'} kg / ${p.volumeM3 ?? '—'} m³`],
    ]],
    ['运营', [
      ['销量 / 浏览', `${Number(p.sales || 0)} / ${Number(p.views || 0)}`],
      ['评价数', p.reviews],
      ['上架状态', p.status],
    ]],
  ];
  const moreCount = moreGroups.reduce((n, [, rows]) => n + rows.length, 0);
  const more = el('details', { class: 'more-facts' },
    el('summary', { text: `更多参数（${moreCount} 项）` }),
    el('div', { class: 'more-facts-groups' }, moreGroups.map(([name, rows]) =>
      el('div', null,
        el('h4', { text: name }),
        el('div', { class: 'detail-facts' }, rows.map(factItem))))));

  const tiers = listOf(p.tierPrices);
  const tiersBlock = tiers.length
    ? el('ul', { class: 'detail-list' }, tiers.map((t) => el('li', { text: describe(t) })))
    : el('p', { class: 'muted', text: '暂无阶梯价信息' });

  const logisticsBlock = isObject(p.logistics)
    ? el('ul', { class: 'detail-list' }, Object.entries(p.logistics).map(([k, v]) =>
        el('li', { text: `${k}：${scalar(v)}` })))
    : el('p', { class: 'muted', text: cell(p.logistics) });
  const deliveries = listOf(p.delivery);
  const deliveryBlock = deliveries.length
    ? el('ul', { class: 'detail-list' }, deliveries.map((d) => el('li', { text: describe(d) })))
    : el('p', { class: 'muted', text: '暂无配送信息' });

  const video = safeUrl(p.videoUrl);
  const videoSection = video
    ? el('section', { class: 'detail-section' },
        el('h3', { text: '商品视频' }),
        el('a', { class: 'detail-link', href: video, target: '_blank', rel: 'noopener noreferrer', text: `${video} ↗` }))
    : null;

  const wrap = $('#product-detail');
  wrap.replaceChildren(
    el('div', { class: 'detail-hero' },
      el('div', { class: 'detail-gallery' }, mainWrap, thumbs),
      el('div', { class: 'detail-info' },
        badges,
        el('h2', { class: 'detail-title', text: cell(p.name) }),
        el('div', { class: 'detail-price' }, `${money(p.price)} `,
          el('span', { class: 'muted', text: `/ ${cell(p.unit || '件')}` })),
        el('div', { class: 'detail-actions' },
          el('button', { class: 'btn primary', dataset: { detailAction: 'chat' }, text: '向 AI 咨询这款商品' }),
          el('button', { class: 'btn', dataset: { detailAction: 'search' }, text: '找同类商品' }),
          el('button', { class: 'btn ghost', dataset: { detailAction: 'copy' }, text: '复制 SKU' })),
        el('div', { class: 'detail-facts' }, coreFacts.map(factItem)),
        more)),
    el('section', { class: 'detail-section' },
      el('h3', { text: '规格与简介' }),
      el('p', { class: 'detail-text' }, el('strong', { text: '销售规格：' }), cell(p.spec)),
      el('p', { class: 'detail-text' }, el('strong', { text: '商品简介：' }), cell(p.intro))),
    el('section', { class: 'detail-section' }, el('h3', { text: '阶梯价格' }), tiersBlock),
    el('section', { class: 'detail-section' },
      el('h3', { text: '物流与配送' }),
      el('h4', { text: '物流信息' }), logisticsBlock,
      el('h4', { text: '配送说明' }), deliveryBlock),
    videoSection);

  bindMainImage(wrap);
  wrap.querySelectorAll('.detail-thumb').forEach((button) => {
    button.addEventListener('click', () => {
      wrap.querySelectorAll('.detail-thumb').forEach((b) => b.classList.toggle('active', b === button));
      wrap.querySelector('.detail-main').replaceChildren(
        el('img', { id: 'detail-main-img', src: button.dataset.src, alt: '商品图' }));
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

/* -------------------------------- 聊天卡片 -------------------------------- */

function miniCard(p) {
  const image = imageUrlOf(p);
  return el('div', { class: 'mini-card', dataset: { sku: p.skuCode }, role: 'link', tabindex: '0', title: '点击查看商品详情' },
    el('div', { class: 'mini-thumb' },
      image ? el('img', { src: image, alt: p.name, loading: 'lazy' }) : el('span', { text: '▧' })),
    el('div', { class: 'mini-info' },
      el('div', { class: 'mini-name', text: `${p.index ? `[${p.index}] ` : ''}${p.name}` }),
      el('div', { class: 'mini-price', text: money(p.price) }),
      el('div', { class: 'muted', text: p.category || '未分类' })));
}

function appendMessage(role, content, products = [], intent = null) {
  const container = $('#chat-messages');
  const node = el('div', { class: `msg ${role}`, text: content });
  // 意图识别结果只在本轮展示；历史消息未持久化 intent，回放时保持原样。
  if (intent && role === 'assistant') {
    node.appendChild(el('div', { class: 'msg-intent', text: `意图识别：${intent.label || '未分类'} · ${intent.shouldRecommend ? '已检索商品库' : '无需商品推荐'}` }));
  }
  const all = Array.isArray(products) ? products : [];
  if (all.length) {
    // 对话回复可能引用 [1]~[6]，卡片只展示前三条，避免长列表挤占聊天区。
    const shown = all.slice(0, 3);
    const box = el('div', { class: 'msg-products' }, shown.map(miniCard));
    node.appendChild(box);
    bindImages(box); // 图片 404 时换成占位符，不留破图
    if (all.length > shown.length) {
      node.appendChild(el('div', { class: 'msg-products-more muted', text: `仅展示前 ${shown.length} 件推荐商品，其余 ${all.length - shown.length} 件可在商品检索中查看。` }));
    }
  }
  container.appendChild(node);
  container.scrollTop = container.scrollHeight;
}
