/**
 * Cloudflare AI Search 客户端（知识库专属检索引擎；商品 SKU 检索走 Vectorize）。
 *
 * 设计原则：
 * - AI Search 只负责客服知识库的 chunk 级检索（hybrid + reranking），
 *   SKU 商品的关键词/语义/RRF 融合统一交给 Vectorize + PostgreSQL；
 * - queryAiSearch() 同时返回 skuHits 和 kbHits，但调用方可按需忽略；
 * - 数据同步、幂等创建实例、运维状态查询等能力仍保留，供管理接口使用。
 */
import {
  AI_SEARCH_INSTANCE,
  AI_SEARCH_MATCH_THRESHOLD,
  AI_SEARCH_MAX_RESULTS,
  AI_SEARCH_METADATA_FIELDS,
  AI_SEARCH_NAMESPACE,
  AI_SEARCH_UPLOAD_CONCURRENCY,
  AI_SEARCH_RERANKER,
  DEFAULT_SEARCH_ENGINE,
  SEARCH_ENGINES,
  type SearchEngine,
} from './config';
import { withSql } from './db';
import {
  countSyncDocs,
  getSyncHashes,
  getSyncStats,
  loadKnowledgeSyncDocs,
  loadProductSyncDocs,
  markSyncDocs,
  type SyncDoc,
  type SyncKind,
} from './ai-search-store';
import type {
  AiSearchChunk,
  AiSearchInstanceHandle,
  AiSearchSearchRequest,
  Env,
} from './types';

export function resolveEngine(env: Env, requested?: unknown): SearchEngine {
  const candidate =
    typeof requested === 'string' && requested
      ? requested
      : env.SEARCH_ENGINE || DEFAULT_SEARCH_ENGINE;
  return (SEARCH_ENGINES as readonly string[]).includes(candidate)
    ? (candidate as SearchEngine)
    : DEFAULT_SEARCH_ENGINE;
}

export function aiSearchAvailable(env: Env): boolean {
  return Boolean(env.AI_SEARCH);
}

function instanceIdOf(env: Env): string {
  return env.AI_SEARCH_INSTANCE || AI_SEARCH_INSTANCE;
}

/**
 * 幂等取得实例：首次同步时按 5 个 metadata 字段与混合检索配置创建。
 * 实例带内置存储，文档通过 Items API 上传，不需要额外的 R2 桶。
 */
export async function ensureAiSearchInstance(env: Env): Promise<AiSearchInstanceHandle> {
  const namespace = env.AI_SEARCH;
  if (!namespace) throw new Error('AI_SEARCH 绑定未配置');
  const id = instanceIdOf(env);
  const handle = namespace.get(id);

  let info: Record<string, unknown>;
  try {
    info = await handle.info();
  } catch {
    // 实例不存在：首次同步时创建；账号首次使用 AI Search 可能需要先注册 service token。
    try {
      await namespace.create({
        id,
        index_method: { vector: true, keyword: true },
        fusion_method: 'rrf',
        custom_metadata: AI_SEARCH_METADATA_FIELDS,
        reranking: true,
        reranking_model: AI_SEARCH_RERANKER,
        cache: true,
        rewrite_query: false,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `AI Search 实例 ${id} 不存在且自动创建失败：${reason}。` +
          '若账号首次使用 AI Search，请先在 Dashboard 或用 wrangler ai-search create 创建同名实例并注册 service token。',
      );
    }
    return handle;
  }

  // 手动创建的实例可能没声明 metadata schema，此时上传带 metadata 会被拒绝。
  // 只在字段缺失时 update（改 schema 会触发全量重索引，不能每次请求都调）。
  const declared = Array.isArray(info.custom_metadata) ? info.custom_metadata : [];
  const names = new Set(
    declared.map((field) =>
      String((field as Record<string, unknown>)?.field_name ?? '').toLowerCase(),
    ),
  );
  if (!AI_SEARCH_METADATA_FIELDS.every((field) => names.has(field.field_name))) {
    await handle.update({ custom_metadata: AI_SEARCH_METADATA_FIELDS });
  }
  return handle;
}

export interface AiSearchSyncResult {
  kind: SyncKind;
  total: number;
  offset: number;
  processed: number;
  uploaded: number;
  skipped: number;
  nextOffset: number | null;
  errors: string[];
}

/** 分页把 PG 文档上传到 AI Search；同名 item key 覆盖，未变化的跳过。 */
export async function syncAiSearchBatch(
  env: Env,
  kind: SyncKind,
  offset = 0,
  limit = 40,
  force = false,
): Promise<AiSearchSyncResult> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(80, Math.max(1, Math.floor(limit)));

  const { total, docs, hashes } = await withSql(env, async (sql) => {
    const totalCount = await countSyncDocs(sql, kind);
    const slice = kind === 'kb'
      ? await loadKnowledgeSyncDocs(sql, safeOffset, safeLimit)
      : await loadProductSyncDocs(sql, safeOffset, safeLimit);
    const known = await getSyncHashes(sql, slice.map((d) => d.docKey));
    return { total: totalCount, docs: slice, hashes: known };
  });

  const nextOffset = safeOffset + docs.length < total ? safeOffset + docs.length : null;
  if (!docs.length) {
    return { kind, total, offset: safeOffset, processed: 0, uploaded: 0, skipped: 0, nextOffset, errors: [] };
  }

  const pending = force ? docs : docs.filter((d) => hashes.get(d.docKey) !== d.contentHash);
  if (!pending.length) {
    return {
      kind, total, offset: safeOffset, processed: docs.length,
      uploaded: 0, skipped: docs.length, nextOffset, errors: [],
    };
  }

  const instance = await ensureAiSearchInstance(env);
  const uploaded: SyncDoc[] = [];
  const errors: string[] = [];
  // 单条 upload 约 2s，串行跑完 6k+ 文档需数小时；按小并发分组，兼顾速度与平台限流。
  const size = AI_SEARCH_UPLOAD_CONCURRENCY;
  for (let start = 0; start < pending.length; start += size) {
    const group = pending.slice(start, start + size);
    const results = await Promise.allSettled(
      group.map(async (doc) => {
        await instance.items.upload(doc.docKey, doc.content, { metadata: doc.metadata });
        return doc;
      }),
    );
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        uploaded.push(result.value);
      } else {
        const reason = result.reason;
        errors.push(
          `${group[index].docKey}: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
      }
    });
  }
  if (uploaded.length) await withSql(env, (sql) => markSyncDocs(sql, uploaded));

  return {
    kind, total, offset: safeOffset, processed: docs.length,
    uploaded: uploaded.length, skipped: docs.length - pending.length,
    nextOffset, errors,
  };
}

export interface AiSearchHit {
  kind: SyncKind;
  /** sku 编码或知识文档 id，从 item key 还原。 */
  id: string;
  score: number;
  text: string;
  vectorScore: number | null;
  keywordScore: number | null;
}

export interface AiSearchQueryResult {
  skuHits: AiSearchHit[];
  kbHits: AiSearchHit[];
  rawCount: number;
  searchQuery: string;
  errors: string[];
}

export interface AiSearchQueryOptions {
  topK: number;
  mode: 'keyword' | 'semantic' | 'hybrid';
  category?: string;
  tenant?: string;
  onlyOnSale?: boolean;
  kbLimit?: number;
}

function parseDocKey(key: string): { kind: SyncKind; id: string } | null {
  const slash = key.indexOf('/');
  if (slash < 0 || !key.endsWith('.md')) return null;
  const prefix = key.slice(0, slash);
  if (prefix !== 'sku' && prefix !== 'kb') return null;
  const encoded = key.slice(slash + 1, -3);
  if (!encoded) return null;
  try {
    return { kind: prefix, id: decodeURIComponent(encoded) };
  } catch {
    return null;
  }
}

/** 一次 search() 同时召回商品与知识库 chunks，再按 item key 前缀归类。 */
export async function queryAiSearch(
  env: Env,
  query: string,
  options: AiSearchQueryOptions,
): Promise<AiSearchQueryResult> {
  const instance = await ensureAiSearchInstance(env);
  const kbLimit = options.kbLimit ?? 3;
  const retrievalType =
    options.mode === 'keyword' ? 'keyword' : options.mode === 'semantic' ? 'vector' : 'hybrid';

  const filters: Record<string, unknown> = {};
  if (options.onlyOnSale !== false) filters.status = { $eq: '已上架' };
  if (options.category) filters.category = { $eq: options.category };
  if (options.tenant) filters.tenant = { $eq: options.tenant };

  const request: AiSearchSearchRequest = {
    query,
    ai_search_options: {
      retrieval: {
        retrieval_type: retrievalType,
        match_threshold: AI_SEARCH_MATCH_THRESHOLD,
        max_num_results: Math.min(AI_SEARCH_MAX_RESULTS, Math.max(1, options.topK + kbLimit + 3)),
        filters,
        fusion_method: 'rrf',
        keyword_match_mode: 'or',
      },
      reranking: { enabled: true, model: AI_SEARCH_RERANKER },
      query_rewrite: { enabled: false },
      cache: { enabled: true },
    },
  };

  const response = await instance.search(request);
  const chunks: AiSearchChunk[] = Array.isArray(response.chunks) ? response.chunks : [];
  const skuHits: AiSearchHit[] = [];
  const kbHits: AiSearchHit[] = [];

  for (const chunk of chunks) {
    const parsed = parseDocKey(chunk.item?.key ?? '');
    if (!parsed) continue;
    const hit: AiSearchHit = {
      kind: parsed.kind,
      id: parsed.id,
      score: Number(chunk.score ?? 0),
      text: String(chunk.text ?? ''),
      vectorScore: chunk.scoring_details?.vector_score ?? null,
      keywordScore: chunk.scoring_details?.keyword_score ?? null,
    };
    if (parsed.kind === 'sku' && skuHits.length < options.topK) skuHits.push(hit);
    if (parsed.kind === 'kb' && kbHits.length < kbLimit) kbHits.push(hit);
  }

  return {
    skuHits,
    kbHits,
    rawCount: chunks.length,
    searchQuery: String(response.search_query ?? query),
    errors: (response.errors ?? []).map((e) => String(e.message ?? '未知错误')),
  };
}

/** 运维状态：绑定、实例、索引配置与同步计数。 */
export async function aiSearchStatus(env: Env): Promise<Record<string, unknown>> {
  const id = instanceIdOf(env);
  const base: Record<string, unknown> = {
    bound: aiSearchAvailable(env),
    namespace: AI_SEARCH_NAMESPACE,
    instance: id,
    engine: resolveEngine(env),
    metadataFields: AI_SEARCH_METADATA_FIELDS,
    maxResults: AI_SEARCH_MAX_RESULTS,
  };
  if (!env.AI_SEARCH) return { ...base, exists: false };
  try {
    const handle = env.AI_SEARCH.get(id);
    const [info, stats] = await Promise.all([handle.info(), handle.stats()]);
    let sync: Record<string, unknown>[] = [];
    let syncError: string | null = null;
    try {
      sync = await withSql(env, (sql) => getSyncStats(sql));
    } catch {
      syncError = 'ai_search_sync 表不存在，请先调用 POST /api/admin/migrate';
    }
    return { ...base, exists: true, info, stats, sync, syncError };
  } catch (error) {
    return {
      ...base,
      exists: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
