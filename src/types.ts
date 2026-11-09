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

export interface Env {
  AI: AiBinding;
  VECTORIZE: VectorizeBinding;
  HYPERDRIVE: HyperdriveBinding;
  ASSETS: Fetcher;
  /** 通过 wrangler secret put 设置 */
  JWT_SECRET: string;
  ADMIN_TOKEN: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  EMBEDDING_MODEL?: string;
  CHAT_MODEL?: string;
  VECTORIZE_INDEX_NAME?: string;
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
