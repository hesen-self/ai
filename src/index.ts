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

/** 请求级结构化日志中间件：Cloudflare Observability 会自动采集 console 输出到 trace。 */
app.use('*', async (c, next) => {
  const start = Date.now();
  const path = c.req.path;
  const method = c.req.method;
  try {
    await next();
  } finally {
    const duration = Date.now() - start;
    const status = c.res.status;
    // 只对 /api/* 路径打业务日志（静态资源不打，避免噪声）
    if (path.startsWith('/api/')) {
      console.info(JSON.stringify({
        level: duration > 2000 ? 'warn' : 'info',
        ms: duration,
        method,
        path,
        status,
        ua: c.req.header('user-agent')?.slice(0, 80),
        colo: c.req.raw.cf?.colo,
      }));
    }
  }
});

app.onError((error, c) => {
  console.error(JSON.stringify({
    level: 'error',
    ms: Date.now(),
    method: c.req.method,
    path: c.req.path,
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
  }));
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
