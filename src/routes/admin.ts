import { Hono } from 'hono';
import { requireAdmin } from '../auth';
import {
  AI_SEARCH_INSTANCE,
  AI_SEARCH_SYNC_BATCH,
  CHAT_MODEL,
  DEFAULT_SEARCH_ENGINE,
  EMBED_BATCH,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_METRIC,
  EMBEDDING_MODEL,
  INDEX_NAME,
  INGEST_BATCH,
  METADATA_INDEXES,
  NS_KB,
  NS_SKU,
} from '../config';
import {
  getFacets,
  getProductHashes,
  markProductsSynced,
  migrate,
  upsertProducts,
  withSql,
} from '../db';
import { broadcastNotification } from '../db-notifications';
import { embedTexts, upsertSkuVectors } from '../embeddings';
import { aiSearchStatus, syncAiSearchBatch } from '../ai-search';
import { buildKnowledgeBatch } from '../knowledge';
import { normalizeBatch } from '../normalize';
import { SCHEMA_SQL } from '../schema';
import type { HonoEnv } from '../types';

const router = new Hono<HonoEnv>();

router.use('*', requireAdmin);

/** PostgreSQL 42P01：表尚未创建。首次部署时这是正常状态，不应让 /status 返回 500。 */
function isMissingRelation(error: unknown): boolean {
  const detail = error as { code?: string; message?: string } | null;
  return detail?.code === '42P01' || /relation .* does not exist/i.test(detail?.message ?? '');
}

router.get('/status', async (c) => {
  let database: Record<string, unknown> = {};
  let migrated = true;
  try {
    const facets = await withSql(c.env, (sql) => getFacets(sql));
    const extra = await withSql(c.env, (sql) =>
      sql.unsafe(
        `select
        (select count(*)::int from products where synced_at is null) as unsynced_products,
        (select count(*)::int from knowledge_docs) as knowledge_docs,
        (select count(*)::int from knowledge_docs where synced_at is null) as unsynced_knowledge,
        (select count(*)::int from app_users) as users,
        (select count(*)::int from chat_messages) as messages`,
      ),
    );
    database = {
      ...(facets as Record<string, unknown>),
      ...((extra[0] as Record<string, unknown>) ?? {}),
    };
  } catch (error) {
    if (!isMissingRelation(error)) throw error;
    migrated = false;
    database = {
      categories: [],
      tenants: [],
      statuses: [],
      stats: {},
      unsynced_products: 0,
      knowledge_docs: 0,
      unsynced_knowledge: 0,
      users: 0,
      messages: 0,
    };
  }
  return c.json({
    ok: true,
    migrated,
    config: {
      embeddingModel: c.env.EMBEDDING_MODEL || EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      metric: EMBEDDING_METRIC,
      chatModel: c.env.CHAT_MODEL || CHAT_MODEL,
      indexName: c.env.VECTORIZE_INDEX_NAME || INDEX_NAME,
      namespaces: [NS_SKU, NS_KB],
      metadataIndexes: METADATA_INDEXES,
      ingestBatch: INGEST_BATCH,
      embedBatch: EMBED_BATCH,
      searchEngine: c.env.SEARCH_ENGINE || DEFAULT_SEARCH_ENGINE,
      aiSearchBinding: Boolean(c.env.AI_SEARCH),
      aiSearchInstance: c.env.AI_SEARCH_INSTANCE || AI_SEARCH_INSTANCE,
    },
    database,
  });
});

/** 返回完整 DDL，便于用 psql 或数据库控制台手动执行。 */
router.get('/schema', (c) =>
  c.text(SCHEMA_SQL, 200, { 'Content-Type': 'text/plain; charset=utf-8' }),
);

router.post('/migrate', async (c) => {
  const result = await migrate(c.env);
  return c.json({ ok: true, ...result });
});

/**
 * 接收 docs/*.json 的一批原始记录：规范化 → 写 PG → 向量化 → upsert Vectorize。
 * 用 content_hash + synced_at 保证重跑幂等；失败批下次会自动重新向量化。
 */
router.post('/ingest', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return c.json({ error: 'items 不能为空' }, 400);
  if (items.length > INGEST_BATCH * 2) {
    return c.json({ error: `单批最多 ${INGEST_BATCH * 2} 条` }, 413);
  }
  const force = body.force === true;
  const { products, rejected } = normalizeBatch(items);
  if (!products.length) return c.json({ received: items.length, upserted: 0, embedded: 0, rejected });

  const result = await withSql(c.env, async (sql) => {
    // 必须先读旧 hash：upsert 之后 content_hash 已被刷新。
    const existing = await getProductHashes(sql, products.map((p) => p.skuCode));
    const pending = products.filter((p) => {
      if (force) return true;
      const previous = existing.get(p.skuCode);
      return !previous || previous.hash !== p.contentHash || !previous.syncedAt;
    });

    await upsertProducts(sql, products);

    const mutationIds: string[] = [];
    for (let i = 0; i < pending.length; i += EMBED_BATCH) {
      const chunk = pending.slice(i, i + EMBED_BATCH);
      const vectors = await embedTexts(c.env, chunk.map((p) => p.embedText), {
        cache: true,
        source: 'admin-sync',
      });
      const mutationId = await upsertSkuVectors(c.env, chunk, vectors);
      if (mutationId) mutationIds.push(mutationId);
    }
    if (pending.length) await markProductsSynced(sql, pending.map((p) => p.skuCode));

    return {
      received: items.length,
      upserted: products.length,
      embedded: pending.length,
      skipped: products.length - pending.length,
      rejected,
      mutationIds,
    };
  });
  return c.json({ ok: true, ...result });
});

/** 分页构建商品知识库（类目 / 供应商 / 价格带 / 选购指南）。 */
router.post('/build-knowledge', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const offset = Math.max(0, Number(body.offset) || 0);
  const limit = Math.min(200, Math.max(1, Number(body.limit) || 120));
  const force = body.force === true;
  const result = await buildKnowledgeBatch(c.env, offset, limit, force);
  return c.json({ ok: true, ...result });
});

/** AI Search 实例状态：绑定、索引配置、索引进度与已同步文档数。 */
router.get('/ai-search/status', async (c) =>
  c.json({ ok: true, aiSearch: await aiSearchStatus(c.env) }),
);

/**
 * 分页把 PG 的商品 / 知识文档上传到 AI Search 内置存储。
 * 幂等依据 ai_search_sync 表的 content_hash；同名 item key 重复上传即覆盖。
 * 上传是异步索引，返回成功不代表立即可检索。
 */
router.post('/ai-search/sync', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const kind = body.kind === 'sku' ? 'sku' : 'kb';
  const offset = Math.max(0, Number(body.offset) || 0);
  const limit = Math.min(80, Math.max(1, Number(body.limit) || AI_SEARCH_SYNC_BATCH));
  const force = body.force === true;
  const result = await syncAiSearchBatch(c.env, kind, offset, limit, force);
  return c.json({ ok: true, ...result });
});

/**
 * 管理员广播站内信。
 * body: { userIds?: string[], roles?: string[], type, title, content?, payload? }
 * userIds 和 roles 可同时传，接收人取并集；两者都不传则不发。
 */
router.post('/notifications/broadcast', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const type = String(body.type ?? 'system');
  const title = String(body.title ?? '').trim();
  if (!title) return c.json({ error: 'title 必填' }, 400);
  if (!body.userIds?.length && !body.roles?.length) {
    return c.json({ error: 'userIds 或 roles 至少传一个' }, 400);
  }
  const count = await withSql(c.env, (sql) =>
    broadcastNotification(sql, {
      userIds: body.userIds,
      roles: body.roles,
      type,
      title: title.slice(0, 120),
      content: body.content,
      payload: body.payload,
    }),
  );
  return c.json({ ok: true, sent: count });
});

export default router;
