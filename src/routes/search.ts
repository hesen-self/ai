import { Hono } from 'hono';
import { requireAuth } from '../auth';
import { DEFAULT_TOP_K, MAX_TOP_K } from '../config';
import { getProductsBySkus, keywordSearch, withSql } from '../db';
import { embedTexts, querySkuVectors } from '../embeddings';
import type { HonoEnv, VectorizeMatch } from '../types';

const router = new Hono<HonoEnv>();

router.use('*', requireAuth);

type Mode = 'keyword' | 'semantic' | 'hybrid';

interface Candidate {
  skuCode: string;
  score: number;
  vectorScore: number | null;
  keywordScore: number | null;
  sources: string[];
}

function skuFromMatch(m: VectorizeMatch): string {
  const fromMeta = m.metadata?.sku;
  if (typeof fromMeta === 'string' && fromMeta) return fromMeta;
  return m.id.replace(/^sku:/, '');
}

/** Reciprocal Rank Fusion：关键词与语义结果按排名融合，避免两边分数不可比。 */
function fuse(
  keywordRows: Record<string, unknown>[],
  vectorMatches: VectorizeMatch[],
  topK: number,
): Candidate[] {
  const map = new Map<string, Candidate>();
  const add = (skuCode: string, rank: number, source: 'keyword' | 'semantic', rawScore: number) => {
    if (!skuCode) return;
    const item = map.get(skuCode) ?? {
      skuCode,
      score: 0,
      vectorScore: null,
      keywordScore: null,
      sources: [],
    };
    item.score += 1 / (60 + rank);
    if (source === 'keyword') item.keywordScore = rawScore;
    else item.vectorScore = rawScore;
    if (!item.sources.includes(source)) item.sources.push(source);
    map.set(skuCode, item);
  };

  keywordRows.forEach((row, i) => add(String(row.skuCode ?? ''), i + 1, 'keyword', Number(row.keywordScore ?? 0)));
  vectorMatches.forEach((m, i) => add(skuFromMatch(m), i + 1, 'semantic', m.score));

  return [...map.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}

router.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const query = String(body.query ?? '').trim();
  if (!query) return c.json({ error: '检索词不能为空' }, 400);
  if (query.length > 200) return c.json({ error: '检索词过长' }, 400);

  const mode: Mode = ['keyword', 'semantic', 'hybrid'].includes(body.mode) ? body.mode : 'hybrid';
  const topK = Math.min(MAX_TOP_K, Math.max(1, Number(body.topK) || DEFAULT_TOP_K));
  const filters = {
    category: body.category ? String(body.category) : undefined,
    tenant: body.tenant ? String(body.tenant) : undefined,
    onlyOnSale: body.onlyOnSale !== false,
  };

  let keywordRows: Record<string, unknown>[] = [];
  let vectorMatches: VectorizeMatch[] = [];

  const needKeyword = mode !== 'semantic';
  const needSemantic = mode !== 'keyword';

  const [kw, semantic] = await Promise.all([
    needKeyword
      ? withSql(c.env, (sql) => keywordSearch(sql, query, topK * 2, filters.onlyOnSale !== false))
      : Promise.resolve([] as Record<string, unknown>[]),
    needSemantic
      ? (async () => {
          const [vector] = await embedTexts(c.env, [query]);
          return querySkuVectors(c.env, vector, topK * 2, filters);
        })()
      : Promise.resolve([] as VectorizeMatch[]),
  ]);
  keywordRows = kw;
  vectorMatches = semantic;

  if (filters.category) {
    keywordRows = keywordRows.filter((r) => r.category === filters.category);
  }
  if (filters.tenant) {
    keywordRows = keywordRows.filter((r) => r.tenant === filters.tenant);
  }

  const candidates =
    mode === 'keyword'
      ? keywordRows.slice(0, topK).map((row, i) => ({
          skuCode: String(row.skuCode ?? ''),
          score: Number(row.keywordScore ?? 0) + 1 / (60 + i),
          vectorScore: null,
          keywordScore: Number(row.keywordScore ?? 0),
          sources: ['keyword'],
        }))
      : mode === 'semantic'
        ? vectorMatches.slice(0, topK).map((m, i) => ({
            skuCode: skuFromMatch(m),
            score: m.score + 1 / (60 + i),
            vectorScore: m.score,
            keywordScore: null,
            sources: ['semantic'],
          }))
        : fuse(keywordRows, vectorMatches, topK);

  const products = await withSql(c.env, (sql) =>
    getProductsBySkus(sql, candidates.map((x) => x.skuCode)),
  );
  const bySku = new Map(products.map((p) => [String(p.skuCode), p]));
  const items: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    const product = bySku.get(candidate.skuCode);
    if (!product) continue;
    items.push({
      ...product,
      score: Number(candidate.score.toFixed(6)),
      vectorScore: candidate.vectorScore,
      keywordScore: candidate.keywordScore,
      sources: candidate.sources,
    });
  }

  return c.json({
    mode,
    query,
    count: items.length,
    keywordCount: keywordRows.length,
    semanticCount: vectorMatches.length,
    items,
  });
});

export default router;
