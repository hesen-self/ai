import { EMBED_BATCH } from './config';
import {
  aggregateKnowledge,
  getKnowledgeHashes,
  markKnowledgeSynced,
  upsertKnowledgeDocs,
  withSql,
  type KnowledgeAggregate,
} from './db';
import { embedTexts, upsertKbVectors } from './embeddings';
import { clip, hashString } from './normalize';
import type { Env, KnowledgeDoc } from './types';

function money(n: number): string {
  return Number.isFinite(n) ? `${Math.round(n * 100) / 100}` : '0';
}

function samplesText(agg: KnowledgeAggregate, max = 4): string {
  return agg.samples
    .slice(0, max)
    .map((s) => `${s.name || '未命名商品'}（${money(s.price)}元${s.spec ? `，规格：${clip(s.spec, 40)}` : ''}）`)
    .join('；');
}

function categoryDoc(agg: KnowledgeAggregate): KnowledgeDoc {
  const content = [
    `【商品类目知识】${agg.key}。`,
    `该分类下共有 ${agg.count} 个在售 SKU，价格区间 ${money(agg.minPrice)} ~ ${money(agg.maxPrice)} 元，常见计量单位：${agg.units.join('、') || '个/台/件'}。`,
    `代表商品：${samplesText(agg) || '暂无'}。`,
    `主要供应商：${agg.tenants.join('、') || '平台商户'}。`,
    `当用户询问「${agg.key}」「${agg.key}设备」「${agg.key}怎么选」「食品机械选型」等需求时，可优先参考本类目商品。`,
  ].join('');
  return makeDoc('category', agg.key, `${agg.key} 类目概览`, content, {
    count: agg.count,
    minPrice: agg.minPrice,
    maxPrice: agg.maxPrice,
  });
}

function tenantDoc(agg: KnowledgeAggregate): KnowledgeDoc {
  const content = [
    `【供应商知识】${agg.key}。`,
    `该供应商在平台共有 ${agg.count} 个在售 SKU，价格区间 ${money(agg.minPrice)} ~ ${money(agg.maxPrice)} 元。`,
    `主营/代表商品：${samplesText(agg) || '暂无'}。`,
    `常见计量单位：${agg.units.join('、') || '未标注'}。`,
    `用户提出指定厂家、产地或供应商采购需求时，可参考本条知识。`,
  ].join('');
  return makeDoc('tenant', agg.key, `${agg.key} 供应商概览`, content, { count: agg.count });
}

function bandDoc(agg: KnowledgeAggregate): KnowledgeDoc {
  const content = [
    `【价格带选购指南】${agg.key}。`,
    `当前平台该价格带共有 ${agg.count} 个在售 SKU，实际价格区间 ${money(agg.minPrice)} ~ ${money(agg.maxPrice)} 元。`,
    `热门商品：${samplesText(agg) || '暂无'}。`,
    `涉及供应商：${agg.tenants.join('、') || '平台商户'}。`,
    `用户说明预算（如「预算500元以内」「要性价比高的设备」）时，可据此价格带推荐。`,
  ].join('');
  return makeDoc('price_band', agg.key, `${agg.key} 预算选购`, content, { count: agg.count });
}

function makeDoc(
  kind: KnowledgeDoc['kind'],
  refKey: string,
  title: string,
  content: string,
  meta: Record<string, unknown>,
): KnowledgeDoc {
  const id = `${kind}:${refKey}`;
  return {
    id,
    kind,
    refKey,
    title,
    // bge-m3 单次输入上限 512 token，中文按字计，控制在 300 字以内留出余量。
    content: clip(content, 300),
    meta,
    contentHash: hashString(content),
    vectorId: `kb:${id}`,
  };
}

function guideDocs(categories: KnowledgeAggregate[], tenants: KnowledgeAggregate[]): KnowledgeDoc[] {
  const topCategories = categories.slice(0, 12).map((c) => `${c.key}（${c.count}款）`).join('、');
  const docs: KnowledgeDoc[] = [
    makeDoc(
      'guide',
      'platform',
      '平台商品总览与选购路径',
      `【平台选购指南】当前商品库覆盖 ${categories.length} 个设备类目、${tenants.length} 家供应商。热门类目：${topCategories}。选购时建议依次明确：设备类目 → 规格参数（尺寸/电压/功率/材质）→ 预算与价格带 → 起订量与阶梯价 → 发货时效与售后维保。商品详情页的销售规格字段包含重量、长宽高、电压、功率等参数，可用于比对。`,
      { categoryCount: categories.length, tenantCount: tenants.length },
    ),
    makeDoc(
      'guide',
      'pricing',
      '定价方式与起订量说明',
      `【定价与起订指南】平台商品主要有两种定价方式：按数量阶梯价（采购量越大单价越低，见阶梯价格字段）与按规格设价（不同规格不同单价）。每个 SKU 标注最小起订量、计量单位与 SKU 售价，SPU 标价仅作参考。大批量采购时优先查看阶梯价格JSON 与最小起订量。库存为 0 的商品仍可咨询，但需确认发货时效评估字段。`,
      {},
    ),
    makeDoc(
      'guide',
      'service',
      '发货、售后与商品状态说明',
      `【服务与状态说明】商品状态分为已上架、已下架、回收站，检索与推荐默认只返回已上架商品。部分商品支持售后维保（字段「支持售后维保」为是）。物流信息字段包含重量、长、宽、高、体积，发货时效评估字段给出预估时长。平台推荐商品（字段「是否推荐」为是）可作为优先候选。`,
      {},
    ),
  ];
  return docs;
}

export function buildKnowledgeDocs(aggregates: {
  categories: KnowledgeAggregate[];
  tenants: KnowledgeAggregate[];
  bands: KnowledgeAggregate[];
}): KnowledgeDoc[] {
  const docs = [
    ...aggregates.categories.map(categoryDoc),
    ...aggregates.tenants.map(tenantDoc),
    ...aggregates.bands.map(bandDoc),
    ...guideDocs(aggregates.categories, aggregates.tenants),
  ];
  return docs.sort((a, b) => a.id.localeCompare(b.id));
}

export interface KnowledgeBuildResult {
  total: number;
  offset: number;
  processed: number;
  embedded: number;
  nextOffset: number | null;
  mutationIds: string[];
}

/** 分页构建知识库：每次只处理一批，避免单次 Worker 请求里串太多远程 AI 调用。 */
export async function buildKnowledgeBatch(
  env: Env,
  offset = 0,
  limit = 120,
  force = false,
): Promise<KnowledgeBuildResult> {
  return withSql(env, async (sql) => {
    const aggregates = await aggregateKnowledge(sql);
    const allDocs = buildKnowledgeDocs(aggregates);
    const slice = allDocs.slice(offset, offset + limit);

    // 必须先读旧 hash：upsert 之后 content_hash 就已经被刷新，无法判断是否需要重新向量化。
    const hashes = await getKnowledgeHashes(sql, slice.map((d) => d.id));
    const pending = slice.filter((d) => {
      if (force) return true;
      const previous = hashes.get(d.id);
      return !previous || previous.hash !== d.contentHash || !previous.syncedAt;
    });
    await upsertKnowledgeDocs(sql, allDocs);

    const mutationIds: string[] = [];
    for (let i = 0; i < pending.length; i += EMBED_BATCH) {
      const chunk = pending.slice(i, i + EMBED_BATCH);
      const vectors = await embedTexts(env, chunk.map((d) => `${d.title}。${d.content}`), {
        cache: true,
        source: 'knowledge-build',
      });
      const mutationId = await upsertKbVectors(env, chunk, vectors);
      if (mutationId) mutationIds.push(mutationId);
    }
    if (pending.length) await markKnowledgeSynced(sql, pending.map((d) => d.id));

    const next = offset + slice.length;
    return {
      total: allDocs.length,
      offset,
      processed: slice.length,
      embedded: pending.length,
      nextOffset: next < allDocs.length ? next : null,
      mutationIds,
    };
  });
}
