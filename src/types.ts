/** Workers 绑定的最小类型定义（避免与 workers-types 的模型联合类型耦合）。 */
export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<any>;
}

export type VectorMetadataValue = string | number | boolean | string[];

export interface VectorizeVector {
  id: string;
  values: number[] | Float32Array;
  namespace?: string;
  metadata?: Record<string, VectorMetadataValue>;
}

export interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, VectorMetadataValue>;
  values?: number[];
  namespace?: string;
}

export interface VectorizeQueryOptions {
  topK?: number;
  namespace?: string;
  returnValues?: boolean;
  returnMetadata?: 'none' | 'indexed' | 'all';
  filter?: Record<string, Record<string, string | number | boolean | Array<string | number>>>;
}

export interface VectorizeBinding {
  upsert(vectors: VectorizeVector[]): Promise<{ mutationId?: string; count?: number }>;
  query(vector: number[], options?: VectorizeQueryOptions): Promise<{ matches: VectorizeMatch[] }>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

export interface HyperdriveBinding {
  connectionString: string;
}

/* --------------------- AI Search 绑定的最小类型定义 --------------------- */
/* 不依赖 workers-types 的联合类型；字段名与官方 Workers binding 文档一致。 */

export interface AiSearchChunkItem {
  key: string;
  timestamp?: number;
  metadata?: Record<string, string | number | boolean>;
}

export interface AiSearchChunk {
  id: string;
  type?: string;
  score: number;
  text?: string;
  item?: AiSearchChunkItem;
  instance_id?: string;
  scoring_details?: {
    vector_score?: number;
    keyword_score?: number;
    reranking_score?: number;
    fusion_method?: string;
  };
}

export interface AiSearchSearchResult {
  query_kind?: string;
  search_query?: string;
  chunks?: AiSearchChunk[];
  errors?: Array<{ instance_id?: string; message?: string }>;
}

export interface AiSearchRetrievalOptions {
  retrieval_type?: 'vector' | 'keyword' | 'hybrid';
  match_threshold?: number;
  max_num_results?: number;
  filters?: Record<string, unknown>;
  fusion_method?: 'rrf' | 'max';
  keyword_match_mode?: 'and' | 'or';
}

export interface AiSearchRequestOptions {
  instance_ids?: string[];
  retrieval?: AiSearchRetrievalOptions;
  reranking?: { enabled?: boolean; model?: string; match_threshold?: number };
  query_rewrite?: { enabled?: boolean };
  cache?: { enabled?: boolean };
}

export interface AiSearchSearchRequest {
  query?: string;
  messages?: Array<{ role: string; content: string }>;
  ai_search_options?: AiSearchRequestOptions;
}

export interface AiSearchItem {
  id: string;
  key: string;
  status?: string;
  chunks_count?: number;
  metadata?: Record<string, unknown>;
}

export interface AiSearchItemsApi {
  upload(
    name: string,
    content: string,
    options?: { metadata?: Record<string, string> },
  ): Promise<{ id: string; key: string }>;
  list(options?: {
    page?: number;
    per_page?: number;
    search?: string;
  }): Promise<{ result: AiSearchItem[]; result_info: { total_count?: number } }>;
  delete(itemId: string): Promise<void>;
}

export interface AiSearchInstanceHandle {
  search(request: AiSearchSearchRequest): Promise<AiSearchSearchResult>;
  info(): Promise<Record<string, unknown>>;
  stats(): Promise<Record<string, unknown>>;
  update(options: Record<string, unknown>): Promise<unknown>;
  items: AiSearchItemsApi;
}

export interface AiSearchNamespaceBinding {
  get(id: string): AiSearchInstanceHandle;
  create(options: Record<string, unknown>): Promise<AiSearchInstanceHandle>;
  list(options?: Record<string, unknown>): Promise<{
    result: Array<{ id: string }>;
    result_info?: { total_count?: number };
  }>;
  delete(id: string): Promise<void>;
}

export interface Env {
  AI: AiBinding;
  VECTORIZE: VectorizeBinding;
  HYPERDRIVE: HyperdriveBinding;
  ASSETS: Fetcher;
  /** ai_search_namespaces 绑定；未配置时所有 AI Search 分支自动降级。 */
  AI_SEARCH?: AiSearchNamespaceBinding;
  /** 通过 wrangler secret put 设置 */
  JWT_SECRET: string;
  ADMIN_TOKEN: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  EMBEDDING_MODEL?: string;
  CHAT_MODEL?: string;
  VECTORIZE_INDEX_NAME?: string;
  AI_SEARCH_INSTANCE?: string;
  SEARCH_ENGINE?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
}

/** 原始 JSON 记录：中文键名，值可能是字符串 / 数字 / null / 内嵌 JSON 字符串。 */
export type RawSku = Record<string, unknown>;

/** 规范化后的商品记录（camelCase，与 PG 列名一一对应）。 */
export interface Product {
  skuCode: string;
  spuCode: string;
  name: string;
  spec: string;
  status: string;
  bizType: string;
  category: string;
  tenant: string;
  price: number;
  stock: number;
  listPrice: number | null;
  spuStock: number | null;
  sales: number;
  views: number;
  reviews: number;
  minOrder: number;
  pricingType: string;
  unit: string;
  recommended: boolean;
  afterSales: boolean;
  priceRange: string;
  imageUrl: string;
  coverUrl: string;
  gallery: string[];
  intro: string;
  tierPrices: unknown[];
  logistics: Record<string, unknown> | null;
  delivery: unknown[];
  videoUrl: string;
  weightKg: number | null;
  volumeM3: number | null;
  searchText: string;
  embedText: string;
  contentHash: string;
  vectorId: string;
}

export interface KnowledgeDoc {
  id: string;
  kind: 'category' | 'tenant' | 'price_band' | 'guide';
  refKey: string;
  title: string;
  content: string;
  meta: Record<string, unknown>;
  contentHash: string;
  vectorId: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatProductRef {
  index: number;
  skuCode: string;
  name: string;
  category: string;
  price: number;
  imageUrl: string;
  score: number;
}

/** Hono 的应用上下文类型（绑定 + 中间件变量）。 */
export interface HonoEnv {
  Bindings: Env;
  Variables: {
    user: AuthUser;
  };
}
