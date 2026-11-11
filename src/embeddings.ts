import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, NS_KB, NS_SKU } from './config';
import { aiContentCacheKey, aiGatewayOptions } from './ai-gateway';
import { clip } from './normalize';
import type {
  Env,
  KnowledgeDoc,
  Product,
  VectorizeMatch,
  VectorizeQueryOptions,
  VectorizeVector,
} from './types';

export interface EmbedTextsOptions {
  /** 用户检索文本不缓存；后台重复构建的商品和知识库文本可按内容缓存。 */
  cache?: boolean;
  source?: 'user-request' | 'admin-sync' | 'knowledge-build';
}

/** Workers AI 文本向量化。始终以数组形式传 text，返回与输入等长的向量数组。 */
export async function embedTexts(
  env: Env,
  texts: string[],
  options: EmbedTextsOptions = {},
): Promise<number[][]> {
  if (!texts.length) return [];
  const model = env.EMBEDDING_MODEL || EMBEDDING_MODEL;
  const cache = options.cache
    ? { key: await aiContentCacheKey(model, texts), ttl: 60 * 60 * 24 * 7 }
    : undefined;
  const result = await env.AI.run(
    model,
    { text: texts },
    aiGatewayOptions(env, { operation: 'embedding', source: options.source || 'user-request', cache }),
  );
  const payload = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const raw: unknown = payload.data ?? payload.embedding;
  if (!Array.isArray(raw)) throw new Error(`Workers AI 未返回向量数据：${model}`);

  const vectors: number[][] =
    typeof raw[0] === 'number'
      ? [raw as number[]]
      : (raw as unknown[]).map((v) => (Array.isArray(v) ? (v as number[]) : []));

  if (vectors.length !== texts.length) {
    throw new Error(`向量数量不匹配：期望 ${texts.length}，实际 ${vectors.length}`);
  }
  const dimensions = vectors[0]?.length ?? 0;
  if (dimensions !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `向量维度 ${dimensions} 与索引维度 ${EMBEDDING_DIMENSIONS} 不一致；切换模型时必须重建 Vectorize 索引`,
    );
  }
  return vectors;
}

export function productMetadata(p: Product): VectorizeVector['metadata'] {
  return {
    kind: 'sku',
    sku: p.skuCode,
    spu: p.spuCode,
    name: clip(p.name, 60),
    category: p.category || '未分类',
    tenant: p.tenant || '未知',
    status: p.status,
    price: p.price,
    image: p.imageUrl || '',
  };
}

export function knowledgeMetadata(doc: KnowledgeDoc): VectorizeVector['metadata'] {
  return {
    kind: 'kb',
    kbKind: doc.kind,
    ref: doc.refKey,
    title: clip(doc.title, 60),
    status: '已上架',
    price: 0,
  };
}

export async function upsertSkuVectors(
  env: Env,
  products: Product[],
  vectors: number[][],
): Promise<string | undefined> {
  if (!products.length) return undefined;
  const payload: VectorizeVector[] = products.map((p, i) => ({
    id: p.vectorId,
    values: vectors[i],
    namespace: NS_SKU,
    metadata: productMetadata(p),
  }));
  const result = await env.VECTORIZE.upsert(payload);
  return result?.mutationId;
}

export async function upsertKbVectors(
  env: Env,
  docs: KnowledgeDoc[],
  vectors: number[][],
): Promise<string | undefined> {
  if (!docs.length) return undefined;
  const payload: VectorizeVector[] = docs.map((doc, i) => ({
    id: doc.vectorId,
    values: vectors[i],
    namespace: NS_KB,
    metadata: knowledgeMetadata(doc),
  }));
  const result = await env.VECTORIZE.upsert(payload);
  return result?.mutationId;
}

export interface SearchFilters {
  category?: string;
  tenant?: string;
  onlyOnSale?: boolean;
}

function buildFilter(filters: SearchFilters): VectorizeQueryOptions['filter'] {
  const filter: Record<string, Record<string, string | number | boolean | Array<string | number>>> = {
    kind: { $eq: 'sku' },
  };
  if (filters.onlyOnSale !== false) filter.status = { $eq: '已上架' };
  if (filters.category) filter.category = { $eq: filters.category };
  if (filters.tenant) filter.tenant = { $eq: filters.tenant };
  return filter;
}

export async function querySkuVectors(
  env: Env,
  queryVector: number[],
  topK: number,
  filters: SearchFilters = {},
): Promise<VectorizeMatch[]> {
  const result = await env.VECTORIZE.query(queryVector, {
    topK,
    namespace: NS_SKU,
    returnMetadata: 'all',
    filter: buildFilter(filters),
  });
  return result?.matches ?? [];
}

export async function queryKbVectors(
  env: Env,
  queryVector: number[],
  topK = 3,
): Promise<VectorizeMatch[]> {
  const result = await env.VECTORIZE.query(queryVector, {
    topK,
    namespace: NS_KB,
    returnMetadata: 'all',
  });
  return result?.matches ?? [];
}
