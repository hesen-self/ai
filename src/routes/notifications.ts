import { Hono } from 'hono';
import { currentUser, requireAuth } from '../auth';
import {
  deleteNotification,
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  withSql,
} from '../db';
import type { HonoEnv } from '../types';

const router = new Hono<HonoEnv>();

router.use('*', requireAuth);

/** 通知列表（分页，未读在前）。 */
router.get('/', async (c) => {
  const user = currentUser(c);
  const limit = Math.min(100, parseInt(c.req.query('limit') ?? '30', 10) || 30);
  const unreadOnly = c.req.query('unread') === '1';
  const rows = await withSql(c.env, (sql) =>
    listNotifications(sql, user.id, { limit, unreadOnly }),
  );
  return c.json({
    notifications: rows.map(mapRow),
    unreadCount: await withSql(c.env, (sql) => getUnreadCount(sql, user.id)),
  });
});

/** 轻量未读计数（给铃铛角标用）。 */
router.get('/unread-count', async (c) => {
  const user = currentUser(c);
  const count = await withSql(c.env, (sql) => getUnreadCount(sql, user.id));
  return c.json({ count });
});

/** 单条标记已读。 */
router.post('/:id/read', async (c) => {
  const user = currentUser(c);
  const id = parseInt(c.req.param('id'), 10);
  if (!id) return c.json({ error: 'invalid id' }, 400);
  const marked = await withSql(c.env, (sql) => markNotificationsRead(sql, user.id, [id]));
  return c.json({ marked });
});

/** 批量标记已读。 */
router.post('/read-batch', async (c) => {
  const user = currentUser(c);
  const { ids } = await c.req.json<{ ids: number[] }>();
  if (!Array.isArray(ids) || !ids.length) return c.json({ marked: 0 });
  const marked = await withSql(c.env, (sql) => markNotificationsRead(sql, user.id, ids));
  return c.json({ marked });
});

/** 全部标记已读。 */
router.post('/read-all', async (c) => {
  const user = currentUser(c);
  const marked = await withSql(c.env, (sql) => markAllNotificationsRead(sql, user.id));
  return c.json({ marked });
});

/** 删除单条。 */
router.delete('/:id', async (c) => {
  const user = currentUser(c);
  const id = parseInt(c.req.param('id'), 10);
  if (!id) return c.json({ error: 'invalid id' }, 400);
  const ok = await withSql(c.env, (sql) => deleteNotification(sql, id, user.id));
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});

function mapRow(r: Record<string, any>) {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    type: String(r.type),
    title: String(r.title),
    content: r.content ?? null,
    payload: r.payload ?? {},
    readAt: r.read_at ?? null,
    createdAt: r.created_at,
  };
}

export default router;
