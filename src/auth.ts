import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { PBKDF2_ITERATIONS, SESSION_COOKIE, SESSION_TTL_SECONDS } from './config';
import type { AuthUser, Env } from './types';

const encoder = new TextEncoder();

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64Url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  return fromBase64(padded);
}

export function randomSalt(): string {
  return base64(crypto.getRandomValues(new Uint8Array(16)));
}

export async function hashPassword(password: string, salt?: string): Promise<{ hash: string; salt: string }> {
  const usedSalt = salt ?? randomSalt();
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromBase64(usedSalt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  return { hash: base64(new Uint8Array(bits)), salt: usedSalt };
}

export async function verifyPassword(password: string, salt: string, expected: string): Promise<boolean> {
  const { hash } = await hashPassword(password, salt);
  if (hash.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i += 1) diff |= hash.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  name: string | null;
  iat: number;
  exp: number;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function signSession(user: AuthUser, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload: JwtPayload = {
    sub: String(user.id),
    email: user.email,
    role: user.role,
    name: user.displayName,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };
  const body = base64Url(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${header}.${body}`;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

export async function readSession(token: string, secret: string): Promise<AuthUser | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      fromBase64Url(parts[2]),
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]))) as JwtPayload;
    if (!payload.sub || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      displayName: payload.name,
    };
  } catch {
    return null;
  }
}

export function issueCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true, // 自定义域名 + Cloudflare 强制 HTTPS，固定 Secure 避免 HTTP 边缘 case
    sameSite: 'Strict', // 生产环境最佳实践：只在同源请求带 cookie，防御 CSRF
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 业务接口：校验会话 Cookie。 */
export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || !c.env.JWT_SECRET) {
    return c.json({ error: '未登录或服务端未配置 JWT_SECRET' }, 401);
  }
  const user = await readSession(token, c.env.JWT_SECRET as string);
  if (!user) return c.json({ error: '会话已失效，请重新登录' }, 401);
  c.set('user', user);
  await next();
}

/** 管理接口：校验 X-Admin-Token / Bearer Token。 */
export async function requireAdmin(c: Context, next: Next): Promise<Response | void> {
  const provided =
    c.req.header('X-Admin-Token') ??
    (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const expected = (c.env as unknown as Env).ADMIN_TOKEN;
  if (!expected || !provided || !timingSafeEqual(provided, expected)) {
    return c.json({ error: '无效的管理令牌' }, 401);
  }
  await next();
}

export function currentUser(c: Context): AuthUser {
  return c.get('user') as AuthUser;
}
