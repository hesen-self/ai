/** 集中管理模型 ID 与运行参数：Cloudflare 模型目录会更新，改这里即可切换。 */
export const EMBEDDING_MODEL = '@cf/baai/bge-m3';
export const EMBEDDING_DIMENSIONS = 1024;
export const EMBEDDING_METRIC = 'cosine';
export const CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const INDEX_NAME = 'product-catalog';

/** Vectorize 命名空间：SKU 向量与知识库文档向量分开放，检索时分别召回。 */
export const NS_SKU = 'sku';
export const NS_KB = 'kb';

export const SESSION_COOKIE = 'cf_product_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
export const PBKDF2_ITERATIONS = 100_000;

/** 单次 AI.run 的文本条数（同时受 512 token / 条的约束）。 */
export const EMBED_BATCH = 40;
/** 管理接口单批接收的原始记录数，与 scripts/ingest.mjs 保持一致。 */
export const INGEST_BATCH = 40;
export const DEFAULT_TOP_K = 8;
export const MAX_TOP_K = 20;
/** 商品列表每页条数；API 默认值、DB 兜底值与前端保持一致。 */
export const DEFAULT_PAGE_SIZE = 18;
export const MAX_PAGE_SIZE = 60;

/** metadata 索引字段（必须在使用 wrangler 创建索引后、写入向量之前建立）。 */
export const METADATA_INDEXES = [
  { propertyName: 'kind', type: 'string' },
  { propertyName: 'status', type: 'string' },
  { propertyName: 'category', type: 'string' },
  { propertyName: 'tenant', type: 'string' },
  { propertyName: 'price', type: 'number' },
] as const;
