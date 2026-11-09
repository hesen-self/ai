import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  clearCookie,
  currentUser,
  issueCookie,
  readSession,
  requireAuth,
  signSession,
  verifyPassword,
} from '../auth';
import { SESSION_COOKIE } from '../config';
import { createUser, findUserByEmail, withSql } from '../db';
import type { AuthUser, HonoEnv } from '../types';

const router = new Hono<HonoEnv>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(row: Record<string, any>): AuthUser {
  return {
    id: String(row.id),
    email: row.email,
    displayName: row.display_name ?? null,
    role: row.role ?? 'user',
  };
}

router.post('/register', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const displayName = String(body.displayName ?? '').trim().slice(0, 40);

  if (!EMAIL_RE.test(email)) return c.json({ error: '邮箱格式不正确' }, 400);
  if (password.length < 8) return c.json({ error: '密码至少 8 位' }, 400);
  if (!c.env.JWT_SECRET) return c.json({ error: '服务端未配置 JWT_SECRET' }, 500);

  try {
    const user = await withSql(c.env, async (sql) => {
      const existing = await findUserByEmail(sql, email);
      if (existing) throw new Error('EMAIL_TAKEN');
      return publicUser(await createUser(sql, email, password, displayName || email.split('@')[0]));
    });
    const token = await signSession(user, c.env.JWT_SECRET as string);
    issueCookie(c, token);
    return c.json({ user }, 201);
  } catch (error) {
    if (error instanceof Error && error.message === 'EMAIL_TAKEN') {
      return c.json({ error: '该邮箱已注册' }, 409);
    }
    throw error;
  }
});

router.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!email || !password) return c.json({ error: '请输入邮箱和密码' }, 400);
  if (!c.env.JWT_SECRET) return c.json({ error: '服务端未配置 JWT_SECRET' }, 500);

  const row = await withSql(c.env, (sql) => findUserByEmail(sql, email));
  if (!row) return c.json({ error: '邮箱或密码错误' }, 401);

  const valid = await verifyPassword(password, row.password_salt, row.password_hash);
  if (!valid) return c.json({ error: '邮箱或密码错误' }, 401);

  const user = publicUser(row);
  const token = await signSession(user, c.env.JWT_SECRET as string);
  issueCookie(c, token);
  await withSql(c.env, (sql) =>
    sql.unsafe(`update app_users set last_login_at = now() where id = $1`, [String(row.id)]),
  );
  return c.json({ user });
});

router.post('/logout', (c) => {
  clearCookie(c);
  return c.json({ ok: true });
});

router.get('/me', requireAuth, (c) => c.json({ user: currentUser(c) }));

/** 无需登录即可探测会话状态（前端决定显示登录页还是主界面）。 */
router.get('/session', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || !c.env.JWT_SECRET) return c.json({ user: null });
  const user = await readSession(token, c.env.JWT_SECRET as string);
  return c.json({ user });
});

export default router;
