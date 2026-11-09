import { Hono } from 'hono';
import { requireAuth } from '../auth';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../config';
import { getFacets, getProductBySku, listProducts, withSql } from '../db';
import type { HonoEnv } from '../types';

const router = new Hono<HonoEnv>();

router.use('*', requireAuth);

router.get('/', async (c) => {
  const q = c.req.query();
  const number = (v: string | undefined): number | undefined => {
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const result = await withSql(c.env, (sql) =>
    listProducts(sql, {
      page: number(q.page) ?? 1,
      pageSize: Math.min(number(q.pageSize) ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
      q: q.q,
      category: q.category,
      tenant: q.tenant,
      status: q.status,
      recommended: q.recommended === 'true' || q.recommended === '1',
      minPrice: number(q.minPrice),
      maxPrice: number(q.maxPrice),
      sort: q.sort,
    }),
  );
  return c.json(result);
});

router.get('/facets', async (c) => {
  const facets = await withSql(c.env, (sql) => getFacets(sql));
  return c.json(facets);
});

router.get('/:skuCode', async (c) => {
  const product = await withSql(c.env, (sql) => getProductBySku(sql, c.req.param('skuCode')));
  if (!product) return c.json({ error: '商品不存在' }, 404);
  return c.json({ product });
});

export default router;
