/** 集中管理模型 ID 与运行参数：Cloudflare 模型目录会更新，改这里即可切换。 */
export const EMBEDDING_MODEL = '@cf/baai/bge-m3';
export const EMBEDDING_DIMENSIONS = 1024;
export const EMBEDDING_METRIC = 'cosine';
export const CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
/**
 * 意图识别用的模型。默认复用对话模型（线上已验证可用）；
 * 若对话量大，可在 wrangler.jsonc 的 vars 覆盖为更小的模型以降低 neurons 消耗。
 */
export const INTENT_MODEL = CHAT_MODEL;
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

/* ---------------- AI Search（当前默认，Vectorize 回退） ---------------- */

/** 默认 namespace 由 Cloudflare 自动创建；实例在首次同步时按需创建。 */
export const AI_SEARCH_NAMESPACE = 'default';
export const AI_SEARCH_INSTANCE = 'product-catalog-search';
/** 单批同步的文档数，与 scripts/sync-ai-search.mjs 保持一致。 */
export const AI_SEARCH_SYNC_BATCH = 40;
/** Items API 单条上传约 2s，串行全量同步需数小时；限流并发以免触发平台限流。 */
export const AI_SEARCH_UPLOAD_CONCURRENCY = 10;
/** AI Search 单次 search() 的官方上限是 50 chunks；这里留出知识库条目的余量。 */
export const AI_SEARCH_MAX_RESULTS = 50;
export const AI_SEARCH_MATCH_THRESHOLD = 0.3;
export const AI_SEARCH_RERANKER = '@cf/baai/bge-reranker-base';

/** 自定义 metadata 上限 5 个字段；sku 编码不占字段，改用 item key 解析。 */
export const AI_SEARCH_METADATA_FIELDS = [
  { field_name: 'kind', data_type: 'text' },
  { field_name: 'category', data_type: 'text' },
  { field_name: 'tenant', data_type: 'text' },
  { field_name: 'status', data_type: 'text' },
  { field_name: 'price', data_type: 'number' },
] as const;

/** 兜底值：未配置 SEARCH_ENGINE 时保持原 Vectorize 链路；当前线上配置为 ai_search。 */
export const DEFAULT_SEARCH_ENGINE = 'vectorize';
export const SEARCH_ENGINES = ['vectorize', 'ai_search'] as const;
export type SearchEngine = (typeof SEARCH_ENGINES)[number];
