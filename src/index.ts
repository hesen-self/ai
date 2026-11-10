import { Hono } from 'hono';
import { AI_SEARCH_INSTANCE, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, INDEX_NAME } from './config';
import { resolveEngine } from './ai-search';
import type { HonoEnv } from './types';

import adminRoutes from './routes/admin';
import authRoutes from './routes/auth';
import chatRoutes from './routes/chat';
import notificationsRoutes from './routes/notifications';
import productsRoutes from './routes/products';
import searchRoutes from './routes/search';

const app = new Hono<HonoEnv>();

app.onError((error, c) => {
  console.error('[cf-product-ai]', error);
  const message = error instanceof Error ? error.message : '服务端内部错误';
  return c.json({ error: message }, 500);
});

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: 'cf-product-ai',
    bindings: {
      ai: Boolean(c.env.AI),
      vectorize: Boolean(c.env.VECTORIZE),
      hyperdrive: Boolean(c.env.HYPERDRIVE?.connectionString),
      assets: Boolean(c.env.ASSETS),
      aiSearch: Boolean(c.env.AI_SEARCH),
    },
    index: {
      name: c.env.VECTORIZE_INDEX_NAME || INDEX_NAME,
      model: c.env.EMBEDDING_MODEL || EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
    },
    search: {
      engine: resolveEngine(c.env),
      aiSearchInstance: c.env.AI_SEARCH_INSTANCE || AI_SEARCH_INSTANCE,
    },
    time: new Date().toISOString(),
  }),
);

app.route('/api/auth', authRoutes);
app.route('/api/products', productsRoutes);
app.route('/api/search', searchRoutes);
app.route('/api/chat', chatRoutes);
app.route('/api/notifications', notificationsRoutes);
app.route('/api/admin', adminRoutes);

app.all('/api/*', (c) => c.json({ error: '接口不存在' }, 404));

// 静态资源默认由 assets 直接返回；这里保留兜底，便于 SPA 路由与本地开发。
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
