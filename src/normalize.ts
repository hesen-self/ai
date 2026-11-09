import type { Product, RawSku } from './types';

const text = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
};

const number = (v: unknown, fallback: number | null = 0): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
};

const integer = (v: unknown, fallback = 0): number => {
  const n = number(v, fallback);
  return n === null ? fallback : Math.trunc(n);
};

const yes = (v: unknown): boolean =>
  v === '是' || v === true || v === 1 || v === 'true' || v === 'YES';

function parseJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v !== 'string') return (Array.isArray(v) || typeof v === 'object' ? v : fallback) as T;
  try {
    const parsed = JSON.parse(v);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export const clip = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max)}…` : s;

/** FNV-1a：仅用于「内容是否变化」的幂等判断，不用于安全场景。 */
export function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ':' + input.length.toString(36);
}

function describeLogistics(logistics: Record<string, unknown> | null): string {
  if (!logistics) return '';
  const labels: Record<string, string> = {
    weight: '重量',
    length: '长',
    wide: '宽',
    high: '高',
    volume: '体积',
  };
  const parts = Object.entries(logistics)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${labels[k] ?? k}:${String(v)}`);
  return parts.length ? `物流参数：${parts.join('，')}` : '';
}

/**
 * 构造向量化文本。原始数据的「商品名称」大量是不相关的短句，
 * 因此把类目放在开头并重复一次，显式提高类目/规格/供应商的语义权重。
 * bge-m3 单次输入上限 512 token，整体控制在 360 字以内。
 */
export function buildEmbedText(p: Product): string {
  const category = p.category || '未分类';
  const tags = [`状态：${p.status}`, `库存：${p.stock}`];
  if (p.recommended) tags.push('平台推荐商品');
  if (p.afterSales) tags.push('支持售后维保');
  const segments = [
    `商品类目：${category}，${category}设备及配套产品`,
    `商品名称：${clip(p.name || '未命名', 70)}`,
    `销售规格：${clip(p.spec || '暂无规格', 160)}`,
    `供应商：${p.tenant || '未知供应商'}`,
    `业务类型：${p.bizType || '普通商品'}；定价方式：${p.pricingType || '按数量阶梯价'}`,
    `售价${p.price}元/${p.unit || '件'}，标价${p.listPrice ?? p.price}元，起订量${p.minOrder}${p.unit || '件'}`,
    tags.join('；'),
  ];
  const logisticsText = describeLogistics(p.logistics);
  if (logisticsText) segments.push(logisticsText);
  if (p.tierPrices.length) {
    const first = p.tierPrices[0] as Record<string, unknown>;
    if (first && (first.moq !== undefined || first.perPrice !== undefined)) {
      segments.push(`阶梯价：起订${String(first.moq ?? 1)}件单价${String(first.perPrice ?? p.price)}元`);
    }
  }
  if (p.intro) segments.push(`商品简介：${clip(p.intro, 80)}`);
  return clip(segments.filter(Boolean).join('；'), 360);
}

export function buildSearchText(p: Product): string {
  return [
    p.name,
    p.spec,
    p.category,
    p.tenant,
    p.spuCode,
    p.skuCode,
    p.bizType,
    p.pricingType,
    p.priceRange,
    p.intro,
    JSON.stringify(p.tierPrices),
    JSON.stringify(p.logistics),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** 把 docs/*.json 中的一条原始记录转成统一结构；纯函数，可被测试复用。 */
export function normalizeSku(raw: RawSku): Product {
  const gallery = parseJson<string[]>(raw['SPU轮播图'], []);
  const tierPrices = parseJson<unknown[]>(raw['阶梯价格JSON'], []);
  const logistics = parseJson<Record<string, unknown> | null>(raw['物流信息JSON'], null);
  const delivery = parseJson<unknown[]>(raw['发货时效评估JSON'], []);

  const p: Product = {
    skuCode: text(raw['SKU条码']),
    spuCode: text(raw['SPU编码']),
    name: text(raw['商品名称']),
    spec: text(raw['销售规格']),
    status: text(raw['商品状态']),
    bizType: text(raw['业务类型']),
    category: text(raw['分类名称']) === 'None' ? '' : text(raw['分类名称']),
    tenant: text(raw['租户名称']),
    price: number(raw['SKU售价'], 0) ?? 0,
    stock: number(raw['SKU库存'], 0) ?? 0,
    listPrice: number(raw['SPU标价'], null),
    spuStock: number(raw['SPU库存'], null),
    sales: integer(raw['SPU销量']),
    views: integer(raw['点击量']),
    reviews: integer(raw['评价数']),
    minOrder: integer(raw['最小起订量'], 1),
    pricingType: text(raw['定价方式']),
    unit: text(raw['计量单位']),
    recommended: yes(raw['是否推荐']),
    afterSales: yes(raw['支持售后维保']),
    priceRange: text(raw['价格区间']),
    imageUrl: text(raw['SKU图片']),
    coverUrl: text(raw['SPU封面图']),
    gallery: Array.isArray(gallery) ? gallery.filter((x) => typeof x === 'string') : [],
    intro: text(raw['商品简介']),
    tierPrices: Array.isArray(tierPrices) ? tierPrices : [],
    logistics: logistics && typeof logistics === 'object' ? logistics : null,
    delivery: Array.isArray(delivery) ? delivery : [],
    videoUrl: text(raw['视频链接']),
    weightKg: number(raw['重量kg'], null),
    volumeM3: number(raw['体积m3'], null),
    searchText: '',
    embedText: '',
    contentHash: '',
    vectorId: '',
  };

  p.searchText = buildSearchText(p);
  p.embedText = buildEmbedText(p);
  p.contentHash = hashString(
    `${p.embedText}|${p.status}|${p.price}|${p.stock}|${p.imageUrl}|${p.searchText}`,
  );
  p.vectorId = `sku:${p.skuCode}`;
  return p;
}

export function normalizeBatch(items: unknown[]): { products: Product[]; rejected: number } {
  const products: Product[] = [];
  let rejected = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      rejected += 1;
      continue;
    }
    const p = normalizeSku(item as RawSku);
    if (!p.skuCode || !p.name) {
      rejected += 1;
      continue;
    }
    products.push(p);
  }
  return { products, rejected };
}
