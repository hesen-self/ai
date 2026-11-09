import postgres from 'postgres';
import { hashPassword } from './auth';
import { SCHEMA_STATEMENTS } from './schema';
import type { Env, KnowledgeDoc, Product } from './types';

type SqlClient = ReturnType<typeof postgres>;

/** 参数化查询小工具：动态拼接 WHERE 时自动生成 $1/$2... 占位符。 */
class Params {
  private values: any[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  get all(): any[] {
    return this.values;
  }
}

export function createSql(env: Env): SqlClient {
  return postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false,
    prepare: true,
  });
}

/** 每个请求独立创建 client（Hyperdrive 负责底层连接池），用完释放。 */
export async function withSql<T>(env: Env, fn: (sql: SqlClient) => Promise<T>): Promise<T> {
  const sql = createSql(env);
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

interface FieldDef {
  col: string;
  key: keyof Product;
  type: string;
}

/** PG 列 <-> Product 字段；type 用于 jsonb_to_recordset 的列声明。 */
const FIELDS: FieldDef[] = [
  { col: 'sku_code', key: 'skuCode', type: 'text' },
  { col: 'spu_code', key: 'spuCode', type: 'text' },
  { col: 'name', key: 'name', type: 'text' },
  { col: 'spec', key: 'spec', type: 'text' },
  { col: 'status', key: 'status', type: 'text' },
  { col: 'biz_type', key: 'bizType', type: 'text' },
  { col: 'category', key: 'category', type: 'text' },
  { col: 'tenant', key: 'tenant', type: 'text' },
  { col: 'price', key: 'price', type: 'numeric' },
  { col: 'stock', key: 'stock', type: 'numeric' },
  { col: 'list_price', key: 'listPrice', type: 'numeric' },
  { col: 'spu_stock', key: 'spuStock', type: 'numeric' },
  { col: 'sales', key: 'sales', type: 'integer' },
  { col: 'views', key: 'views', type: 'integer' },
  { col: 'reviews', key: 'reviews', type: 'integer' },
  { col: 'min_order', key: 'minOrder', type: 'integer' },
  { col: 'pricing_type', key: 'pricingType', type: 'text' },
  { col: 'unit', key: 'unit', type: 'text' },
  { col: 'recommended', key: 'recommended', type: 'boolean' },
  { col: 'after_sales', key: 'afterSales', type: 'boolean' },
  { col: 'price_range', key: 'priceRange', type: 'text' },
  { col: 'image_url', key: 'imageUrl', type: 'text' },
  { col: 'cover_url', key: 'coverUrl', type: 'text' },
  { col: 'gallery', key: 'gallery', type: 'jsonb' },
  { col: 'intro', key: 'intro', type: 'text' },
  { col: 'tier_prices', key: 'tierPrices', type: 'jsonb' },
  { col: 'logistics', key: 'logistics', type: 'jsonb' },
  { col: 'delivery', key: 'delivery', type: 'jsonb' },
  { col: 'video_url', key: 'videoUrl', type: 'text' },
  { col: 'weight_kg', key: 'weightKg', type: 'numeric' },
  { col: 'volume_m3', key: 'volumeM3', type: 'numeric' },
  { col: 'search_text', key: 'searchText', type: 'text' },
  { col: 'embed_text', key: 'embedText', type: 'text' },
  { col: 'content_hash', key: 'contentHash', type: 'text' },
  { col: 'vector_id', key: 'vectorId', type: 'text' },
];

const PUBLIC_COLS = `sku_code, spu_code, name, spec, status, biz_type, category, tenant,
  price, stock, list_price, spu_stock, sales, views, reviews, min_order,
  pricing_type, unit, recommended, after_sales, price_range, image_url, cover_url,
  gallery, intro, tier_prices, logistics, delivery, video_url, weight_kg, volume_m3,
  updated_at, synced_at`;

const SORTS: Record<string, string> = {
  updated: 'updated_at desc, sku_code',
  price_asc: 'price asc, sku_code',
  price_desc: 'price desc, sku_code',
  popular: 'views desc, sales desc, sku_code',
  recommended: 'recommended desc, views desc, sku_code',
  name: 'name asc, sku_code',
};

export function mapProductRow(r: Record<string, any>): Record<string, unknown> {
  const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
  return {
    skuCode: r.sku_code,
    spuCode: r.spu_code,
    name: r.name,
    spec: r.spec,
    status: r.status,
    bizType: r.biz_type,
    category: r.category,
    tenant: r.tenant,
    price: num(r.price),
    stock: num(r.stock),
    listPrice: r.list_price === null ? null : num(r.list_price),
    spuStock: r.spu_stock === null ? null : num(r.spu_stock),
    sales: num(r.sales),
    views: num(r.views),
    reviews: num(r.reviews),
    minOrder: num(r.min_order),
    pricingType: r.pricing_type,
    unit: r.unit,
    recommended: Boolean(r.recommended),
    afterSales: Boolean(r.after_sales),
    priceRange: r.price_range,
    imageUrl: r.image_url,
    coverUrl: r.cover_url,
    gallery: r.gallery ?? [],
    intro: r.intro,
    tierPrices: r.tier_prices ?? [],
    logistics: r.logistics ?? null,
    delivery: r.delivery ?? [],
    videoUrl: r.video_url,
    weightKg: r.weight_kg === null ? null : num(r.weight_kg),
    volumeM3: r.volume_m3 === null ? null : num(r.volume_m3),
    updatedAt: r.updated_at,
    syncedAt: r.synced_at,
    ...(r.keyword_score !== undefined ? { keywordScore: num(r.keyword_score) } : {}),
  };
}

/* ---------------------------------- 迁移 ---------------------------------- */

export async function migrate(env: Env): Promise<{ statements: number; adminSeeded: boolean }> {
  return withSql(env, async (sql) => {
    for (const statement of SCHEMA_STATEMENTS) {
      await sql.unsafe(statement);
    }
    let adminSeeded = false;
    if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
      const { hash, salt } = await hashPassword(env.ADMIN_PASSWORD);
      await sql.unsafe(
        `insert into app_users (email, display_name, password_hash, password_salt, role)
         values ($1, $2, $3, $4, 'admin')
         on conflict (email) do update set password_hash = excluded.password_hash,
           password_salt = excluded.password_salt, role = 'admin'`,
        [env.ADMIN_EMAIL.toLowerCase(), '系统管理员', hash, salt],
      );
      adminSeeded = true;
    }
    return { statements: SCHEMA_STATEMENTS.length, adminSeeded };
  });
}

/* ---------------------------------- 用户 ---------------------------------- */

export async function findUserByEmail(sql: SqlClient, email: string): Promise<Record<string, any> | null> {
  const rows = await sql.unsafe(
    `select id, email, display_name, password_hash, password_salt, role, created_at
     from app_users where email = $1`,
    [email.toLowerCase()],
  );
  return (rows[0] as Record<string, any>) ?? null;
}

export async function createUser(
  sql: SqlClient,
  email: string,
  password: string,
  displayName: string,
): Promise<Record<string, any>> {
  const { hash, salt } = await hashPassword(password);
  const rows = await sql.unsafe(
    `insert into app_users (email, display_name, password_hash, password_salt)
     values ($1, $2, $3, $4)
     returning id, email, display_name, role`,
    [email.toLowerCase(), displayName, hash, salt],
  );
  return rows[0] as Record<string, any>;
}

/* --------------------------------- 商品写入 -------------------------------- */

export async function upsertProducts(sql: SqlClient, products: Product[]): Promise<number> {
  if (!products.length) return 0;
  const rows = products.map((p) => {
    const row: Record<string, unknown> = {};
    for (const f of FIELDS) row[f.col] = p[f.key];
    return row;
  });
  const cols = FIELDS.map((f) => f.col);
  const typeDefs = FIELDS.map((f) => `${f.col} ${f.type}`).join(', ');
  const updates = cols
    .filter((c) => c !== 'sku_code')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  const statement = `insert into products (${cols.join(', ')})
    select ${cols.join(', ')} from jsonb_to_recordset($1::jsonb) as x(${typeDefs})
    on conflict (sku_code) do update set ${updates}, updated_at = now()`;
  await sql.unsafe(statement, [JSON.stringify(rows)]);
  return rows.length;
}

export async function getProductHashes(
  sql: SqlClient,
  skuCodes: string[],
): Promise<Map<string, { hash: string; syncedAt: string | null }>> {
  if (!skuCodes.length) return new Map();
  const rows = await sql.unsafe(
    `select sku_code, content_hash, synced_at from products
     where sku_code in (select value::text from jsonb_array_elements_text($1::jsonb))`,
    [JSON.stringify(skuCodes)],
  );
  return new Map(
    (rows as Record<string, any>[]).map((r) => [
      String(r.sku_code),
      { hash: String(r.content_hash ?? ''), syncedAt: r.synced_at ?? null },
    ]),
  );
}

export async function markProductsSynced(sql: SqlClient, skuCodes: string[]): Promise<void> {
  if (!skuCodes.length) return;
  await sql.unsafe(
    `update products set synced_at = now()
     where sku_code in (select value::text from jsonb_array_elements_text($1::jsonb))`,
    [JSON.stringify(skuCodes)],
  );
}

/* --------------------------------- 商品查询 -------------------------------- */

export interface ListOptions {
  page?: number;
  pageSize?: number;
  q?: string;
  category?: string;
  tenant?: string;
  status?: string;
  recommended?: boolean;
  minPrice?: number;
  maxPrice?: number;
  sort?: string;
}

export async function listProducts(
  sql: SqlClient,
  options: ListOptions,
): Promise<{ items: Record<string, unknown>[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.min(60, Math.max(1, Math.floor(options.pageSize ?? 20)));
  const p = new Params();
  const where = ['1 = 1'];

  if (options.q?.trim()) {
    const pattern = `%${options.q.trim()}%`;
    where.push(`(search_text ilike ${p.add(pattern)} or name ilike ${p.add(pattern)})`);
  }
  if (options.category) where.push(`category = ${p.add(options.category)}`);
  if (options.tenant) where.push(`tenant = ${p.add(options.tenant)}`);
  if (options.status) where.push(`status = ${p.add(options.status)}`);
  else where.push(`status = '已上架'`);
  if (options.recommended) where.push(`recommended = true`);
  if (options.minPrice !== undefined) where.push(`price >= ${p.add(options.minPrice)}`);
  if (options.maxPrice !== undefined) where.push(`price <= ${p.add(options.maxPrice)}`);

  const clause = where.join(' and ');
  const countRows = await sql.unsafe(`select count(*)::int as total from products where ${clause}`, p.all);
  const total = Number((countRows[0] as any)?.total ?? 0);

  const order = SORTS[options.sort ?? ''] ?? SORTS.updated;
  const rows = await sql.unsafe(
    `select ${PUBLIC_COLS} from products where ${clause}
     order by ${order} limit ${p.add(pageSize)} offset ${p.add((page - 1) * pageSize)}`,
    p.all,
  );
  return {
    items: (rows as Record<string, any>[]).map(mapProductRow),
    total,
    page,
    pageSize,
  };
}

export async function getProductsBySkus(
  sql: SqlClient,
  skuCodes: string[],
): Promise<Record<string, unknown>[]> {
  if (!skuCodes.length) return [];
  const rows = await sql.unsafe(
    `select ${PUBLIC_COLS} from products
     where sku_code in (select value::text from jsonb_array_elements_text($1::jsonb))`,
    [JSON.stringify(skuCodes)],
  );
  return (rows as Record<string, any>[]).map(mapProductRow);
}

export async function getProductBySku(sql: SqlClient, skuCode: string): Promise<Record<string, unknown> | null> {
  const rows = await sql.unsafe(`select ${PUBLIC_COLS} from products where sku_code = $1`, [skuCode]);
  return rows.length ? mapProductRow(rows[0] as Record<string, any>) : null;
}

export async function getFacets(sql: SqlClient): Promise<Record<string, unknown>> {
  const [categories, tenants, stats, statuses] = await Promise.all([
    sql.unsafe(
      `select category as value, count(*)::int as count from products
       where status = '已上架' and coalesce(category, '') <> ''
       group by category order by count desc, category limit 120`,
    ),
    sql.unsafe(
      `select tenant as value, count(*)::int as count from products
       where status = '已上架' and coalesce(tenant, '') <> ''
       group by tenant order by count desc, tenant limit 80`,
    ),
    sql.unsafe(
      `select count(*)::int as total, count(*) filter (where status = '已上架')::int as on_sale,
        coalesce(min(price), 0)::float8 as min_price, coalesce(max(price), 0)::float8 as max_price,
        count(distinct spu_code)::int as spu_count
       from products`,
    ),
    sql.unsafe(`select status as value, count(*)::int as count from products group by status order by count desc`),
  ]);
  return {
    categories,
    tenants,
    statuses,
    stats: (stats[0] as Record<string, unknown>) ?? {},
  };
}

export async function keywordSearch(
  sql: SqlClient,
  query: string,
  limit = 20,
  onlyOnSale = true,
): Promise<Record<string, unknown>[]> {
  const pattern = `%${query.trim()}%`;
  const rows = await sql.unsafe(
    `select ${PUBLIC_COLS},
      (case when name ilike $1 then 3 else 0 end
       + case when category ilike $1 then 2 else 0 end
       + case when spec ilike $1 then 1 else 0 end
       + case when tenant ilike $1 then 1 else 0 end)::float8 as keyword_score
     from products
     where (search_text ilike $1 or name ilike $1) ${onlyOnSale ? `and status = '已上架'` : ''}
     order by keyword_score desc, views desc, sku_code
     limit $2`,
    [pattern, limit],
  );
  return (rows as Record<string, any>[]).map(mapProductRow);
}

/* --------------------------------- 知识库 --------------------------------- */

export async function upsertKnowledgeDocs(sql: SqlClient, docs: KnowledgeDoc[]): Promise<number> {
  if (!docs.length) return 0;
  const rows = docs.map((d) => ({
    id: d.id,
    kind: d.kind,
    ref_key: d.refKey,
    title: d.title,
    content: d.content,
    meta: d.meta,
    content_hash: d.contentHash,
    vector_id: d.vectorId,
  }));
  await sql.unsafe(
    `insert into knowledge_docs (id, kind, ref_key, title, content, meta, content_hash, vector_id)
     select id, kind, ref_key, title, content, meta, content_hash, vector_id
     from jsonb_to_recordset($1::jsonb) as x(
       id text, kind text, ref_key text, title text, content text,
       meta jsonb, content_hash text, vector_id text)
     on conflict (id) do update set kind = excluded.kind, title = excluded.title,
       content = excluded.content, meta = excluded.meta, content_hash = excluded.content_hash,
       vector_id = excluded.vector_id, updated_at = now()`,
    [JSON.stringify(rows)],
  );
  return rows.length;
}

export async function getKnowledgeHashes(
  sql: SqlClient,
  ids: string[],
): Promise<Map<string, { hash: string; syncedAt: string | null }>> {
  if (!ids.length) return new Map();
  const rows = await sql.unsafe(
    `select id, content_hash, synced_at from knowledge_docs
     where id in (select value::text from jsonb_array_elements_text($1::jsonb))`,
    [JSON.stringify(ids)],
  );
  return new Map(
    (rows as Record<string, any>[]).map((r) => [
      String(r.id),
      { hash: String(r.content_hash ?? ''), syncedAt: r.synced_at ?? null },
    ]),
  );
}

export async function markKnowledgeSynced(sql: SqlClient, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await sql.unsafe(
    `update knowledge_docs set synced_at = now()
     where id in (select value::text from jsonb_array_elements_text($1::jsonb))`,
    [JSON.stringify(ids)],
  );
}

export async function listKnowledgeDocs(
  sql: SqlClient,
  limit = 20,
): Promise<Record<string, unknown>[]> {
  const rows = await sql.unsafe(
    `select id, kind, ref_key, title, left(content, 240) as excerpt, synced_at
     from knowledge_docs order by updated_at desc limit $1`,
    [limit],
  );
  return rows as Record<string, unknown>[];
}

export interface KnowledgeAggregate {
  key: string;
  count: number;
  minPrice: number;
  maxPrice: number;
  samples: Array<{ name: string; price: number; spec: string }>;
  tenants: string[];
  units: string[];
}

/** 从 PG 聚合出「类目 / 供应商 / 价格带」知识文档的原始材料。 */
export async function aggregateKnowledge(
  sql: SqlClient,
): Promise<{ categories: KnowledgeAggregate[]; tenants: KnowledgeAggregate[]; bands: KnowledgeAggregate[] }> {
  const groupQuery = (groupCol: string, where: string) => `
    select ${groupCol} as key, count(*)::int as count,
      coalesce(min(price), 0)::float8 as min_price, coalesce(max(price), 0)::float8 as max_price,
      coalesce(jsonb_agg(jsonb_build_object('name', name, 'price', price::float8, 'spec', left(coalesce(spec, ''), 60))
        order by views desc) filter (where ordinal <= 4), '[]'::jsonb) as samples,
      coalesce(jsonb_agg(distinct tenant) filter (where tenant is not null and tenant <> ''), '[]'::jsonb) as tenants,
      coalesce(jsonb_agg(distinct unit) filter (where unit is not null and unit <> ''), '[]'::jsonb) as units
    from (
      select *, row_number() over (partition by ${groupCol} order by views desc, sku_code) as ordinal
      from products where status = '已上架' and ${where}
    ) ranked
    group by ${groupCol} order by count desc`;

  const mapRows = (rows: any[]): KnowledgeAggregate[] =>
    rows.map((r) => ({
      key: String(r.key),
      count: Number(r.count),
      minPrice: Number(r.min_price),
      maxPrice: Number(r.max_price),
      samples: (r.samples ?? []) as KnowledgeAggregate['samples'],
      tenants: (r.tenants ?? []).slice(0, 5) as string[],
      units: (r.units ?? []).slice(0, 5) as string[],
    }));

  const [categories, tenants, bands] = await Promise.all([
    sql.unsafe(groupQuery('category', `coalesce(category, '') <> ''`)),
    sql.unsafe(groupQuery('tenant', `coalesce(tenant, '') <> ''`)),
    sql.unsafe(groupQuery(
      `case when price < 100 then '百元以内' when price < 1000 then '100-1000元'
            when price < 10000 then '1000-10000元' else '万元以上' end`,
      'true',
    )),
  ]);

  return {
    categories: mapRows(categories as any[]),
    tenants: mapRows(tenants as any[]),
    bands: mapRows(bands as any[]),
  };
}

/* --------------------------------- 会话 ---------------------------------- */

export async function ensureSession(sql: SqlClient, userId: string, sessionId?: string, title?: string) {
  if (sessionId) {
    const rows = await sql.unsafe(
      `select id from chat_sessions where id = $1::uuid and user_id = $2`,
      [sessionId, userId],
    );
    if (rows.length) return sessionId;
  }
  const created = await sql.unsafe(
    `insert into chat_sessions (id, user_id, title) values (gen_random_uuid(), $1, $2)
     returning id`,
    [userId, title?.slice(0, 60) || '新对话'],
  );
  return String((created[0] as any).id);
}

export async function listSessions(sql: SqlClient, userId: string) {
  return sql.unsafe(
    `select id, title, created_at, updated_at from chat_sessions
     where user_id = $1 order by updated_at desc limit 30`,
    [userId],
  );
}

export async function getMessages(sql: SqlClient, sessionId: string, userId: string, limit = 40) {
  return sql.unsafe(
    `select m.role, m.content, m.products, m.created_at from chat_messages m
     join chat_sessions s on s.id = m.session_id
     where m.session_id = $1::uuid and s.user_id = $2
     order by m.created_at desc limit $3`,
    [sessionId, userId, limit],
  );
}

export async function addMessage(
  sql: SqlClient,
  sessionId: string,
  role: string,
  content: string,
  products: unknown[] = [],
): Promise<void> {
  await sql.unsafe(
    `insert into chat_messages (session_id, role, content, products)
     values ($1::uuid, $2, $3, $4::jsonb)`,
    [sessionId, role, content, JSON.stringify(products)],
  );
  await sql.unsafe(`update chat_sessions set updated_at = now() where id = $1::uuid`, [sessionId]);
}

export async function renameSession(sql: SqlClient, sessionId: string, title: string): Promise<void> {
  await sql.unsafe(`update chat_sessions set title = $2 where id = $1::uuid`, [sessionId, title.slice(0, 60)]);
}

export async function deleteSession(sql: SqlClient, sessionId: string, userId: string): Promise<void> {
  await sql.unsafe(`delete from chat_sessions where id = $1::uuid and user_id = $2`, [sessionId, userId]);
}
