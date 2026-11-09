/**
 * AI Search 文档同步的数据访问层。
 *
 * AI Search 只接受内置存储 / R2 / 网站作为数据源，不直连 PostgreSQL，
 * 所以这里把 PG 里的商品与知识文档渲染成 markdown 文档，并用
 * ai_search_sync 表记录已上传的内容版本，实现增量同步。
 */
import { clip, hashString } from './normalize';
import type { SqlClient } from './db';

export type SyncKind = 'kb' | 'sku';

export interface SyncDoc {
  /** Items API 的 item key，同时作为同步表主键。 */
  docKey: string;
  kind: SyncKind;
  contentHash: string;
  content: string;
  /** 自定义 metadata：最多 5 个字段，见 config.ts。 */
  metadata: Record<string, string>;
}

/** 文档模板版本：改渲染逻辑后 bump，让旧文档自动重新上传。 */
const DOC_VERSION = 'v1';

function hashDoc(content: string): string {
  return hashString(`${DOC_VERSION}|${content}`);
}

/** AI Search item key 的文件名有长度上限；中文 URI 编码会膨胀约 9 倍。 */
const MAX_KEY_NAME_LENGTH = 120;

function docKey(kind: SyncKind, id: string): string {
  const encoded = encodeURIComponent(id);
  // 超长 id（如供应商全称）改用稳定短哈希，避免 filename_exceeds_maximum_length。
  // 原始来源仍写在文档正文的「关联键」里，检索侧据此还原可读引用。
  const name =
    encoded.length <= MAX_KEY_NAME_LENGTH
      ? encoded
      : `h${hashString(id).replace(':', '-')}`;
  return `${kind}/${name}.md`;
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export async function loadKnowledgeSyncDocs(
  sql: SqlClient,
  offset: number,
  limit: number,
): Promise<SyncDoc[]> {
  const rows = await sql.unsafe(
    `select id, kind, ref_key, title, content, content_hash
     from knowledge_docs order by id limit $1 offset $2`,
    [limit, offset],
  );
  return (rows as Record<string, unknown>[]).map((r) => {
    const id = text(r.id);
    const title = text(r.title);
    const body = text(r.content);
    const content = [
      `# ${title}`,
      '',
      `知识类型：${text(r.kind)}`,
      `关联键：${text(r.ref_key)}`,
      '',
      body,
    ].join('\n');
    return {
      docKey: docKey('kb', id),
      kind: 'kb' as const,
      contentHash: hashDoc(content),
      content,
      metadata: {
        kind: 'kb',
        category: '知识库',
        tenant: '',
        status: '已上架',
        price: '0',
      },
    };
  });
}

export async function loadProductSyncDocs(
  sql: SqlClient,
  offset: number,
  limit: number,
): Promise<SyncDoc[]> {
  const rows = await sql.unsafe(
    `select sku_code, name, spec, status, category, tenant, price, unit,
      min_order, pricing_type, biz_type, intro, embed_text
     from products order by sku_code limit $1 offset $2`,
    [limit, offset],
  );
  return (rows as Record<string, unknown>[]).map((r) => {
    const sku = text(r.sku_code);
    const category = text(r.category) || '未分类';
    const tenant = text(r.tenant) || '未知供应商';
    const status = text(r.status);
    const price = num(r.price);
    const content = [
      `# ${text(r.name) || '未命名商品'}`,
      '',
      `SKU：${sku}`,
      `商品类目：${category}`,
      `供应商：${tenant}`,
      `商品状态：${status}`,
      `售价：${price} 元/${text(r.unit) || '件'}，最小起订量：${num(r.min_order)}`,
      `定价方式：${text(r.pricing_type) || '按数量阶梯价'}，业务类型：${text(r.biz_type) || '普通商品'}`,
      `销售规格：${clip(text(r.spec) || '暂无规格', 200)}`,
      text(r.intro) ? `商品简介：${clip(text(r.intro), 100)}` : '',
      '',
      text(r.embed_text),
    ]
      .filter(Boolean)
      .join('\n');
    return {
      docKey: docKey('sku', sku),
      kind: 'sku' as const,
      contentHash: hashDoc(content),
      content,
      metadata: {
        kind: 'sku',
        category: clip(category, 60),
        tenant: clip(tenant, 60),
        status,
        price: String(price),
      },
    };
  });
}

export async function countSyncDocs(sql: SqlClient, kind: SyncKind): Promise<number> {
  const rows = kind === 'kb'
    ? await sql.unsafe(`select count(*)::int as total from knowledge_docs`)
    : await sql.unsafe(`select count(*)::int as total from products`);
  return num((rows[0] as Record<string, unknown>)?.total);
}

export async function getSyncHashes(
  sql: SqlClient,
  keys: string[],
): Promise<Map<string, string>> {
  if (!keys.length) return new Map();
  const rows = await sql.unsafe(
    `select doc_key, content_hash from ai_search_sync
     where doc_key in (select value::text from jsonb_array_elements_text($1::text::jsonb))`,
    [JSON.stringify(keys)],
  );
  return new Map(
    (rows as Record<string, unknown>[]).map((r) => [text(r.doc_key), text(r.content_hash)]),
  );
}

export async function markSyncDocs(sql: SqlClient, docs: SyncDoc[]): Promise<void> {
  if (!docs.length) return;
  const rows = docs.map((d) => ({
    doc_key: d.docKey,
    doc_kind: d.kind,
    content_hash: d.contentHash,
  }));
  await sql.unsafe(
    `insert into ai_search_sync (doc_key, doc_kind, content_hash, synced_at)
     select doc_key, doc_kind, content_hash, now()
     from jsonb_to_recordset($1::text::jsonb) as x(
       doc_key text, doc_kind text, content_hash text)
     on conflict (doc_key) do update set
       content_hash = excluded.content_hash, synced_at = now()`,
    [JSON.stringify(rows)],
  );
}

export async function getSyncStats(sql: SqlClient): Promise<Record<string, unknown>[]> {
  const rows = await sql.unsafe(
    `select doc_kind, count(*)::int as total, max(synced_at) as last_synced
     from ai_search_sync group by doc_kind order by doc_kind`,
  );
  return rows as Record<string, unknown>[];
}
