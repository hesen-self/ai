/**
 * 站内信数据层：从 db.ts 拆出的通知 CRUD 与广播，保持行为完全一致。
 * 复用 db.ts 的 SqlClient 与 Params 占位符工具。
 */
import { Params, type SqlClient } from './db';

export interface ListNotificationsOptions {
  limit?: number;
  unreadOnly?: boolean;
}

export async function listNotifications(
  sql: SqlClient,
  userId: string,
  options: ListNotificationsOptions = {},
): Promise<Record<string, unknown>[]> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 30));
  const where = options.unreadOnly ? `user_id = $1 and read_at is null` : `user_id = $1`;
  const rows = await sql.unsafe(
    `select id, user_id, type, title, content, payload, read_at, created_at
     from notifications where ${where}
     order by read_at nulls first, created_at desc
     limit $2`,
    [userId, limit],
  );
  return rows as Record<string, unknown>[];
}

export async function getUnreadCount(sql: SqlClient, userId: string): Promise<number> {
  const rows = await sql.unsafe(
    `select count(*)::int as count from notifications where user_id = $1 and read_at is null`,
    [userId],
  );
  return Number((rows[0] as Record<string, unknown> | undefined)?.count ?? 0);
}

export async function markNotificationsRead(
  sql: SqlClient,
  userId: string,
  ids: number[],
): Promise<number> {
  if (!ids.length) return 0;
  const rows = await sql.unsafe(
    `update notifications set read_at = now()
     where user_id = $1 and read_at is null
       and id in (select value::bigint from jsonb_array_elements_text($2::text::jsonb))
     returning id`,
    [userId, JSON.stringify(ids)],
  );
  return rows.length;
}

export async function markAllNotificationsRead(sql: SqlClient, userId: string): Promise<number> {
  const rows = await sql.unsafe(
    `update notifications set read_at = now() where user_id = $1 and read_at is null returning id`,
    [userId],
  );
  return rows.length;
}

export async function deleteNotification(
  sql: SqlClient,
  id: number,
  userId: string,
): Promise<boolean> {
  const rows = await sql.unsafe(
    `delete from notifications where id = $1 and user_id = $2 returning id`,
    [id, userId],
  );
  return rows.length > 0;
}

export async function pushNotification(
  sql: SqlClient,
  userId: string,
  notification: { type: string; title: string; content?: string; payload?: Record<string, unknown> },
): Promise<void> {
  await sql.unsafe(
    `insert into notifications (user_id, type, title, content, payload)
     values ($1, $2, $3, $4, $5::text::jsonb)`,
    [userId, notification.type, notification.title, notification.content ?? null, JSON.stringify(notification.payload ?? {})],
  );
}

export interface BroadcastOptions {
  userIds?: string[];          // 指定用户 ID（可选）
  roles?: string[];            // 按角色广播（可选；admin / user）
  type: string;
  title: string;
  content?: string;
  payload?: Record<string, unknown>;
}

export async function broadcastNotification(
  sql: SqlClient,
  options: BroadcastOptions,
): Promise<number> {
  const p = new Params();
  const fromClauses: string[] = [];

  if (options.userIds?.length) {
    fromClauses.push(
      `select value::bigint as uid from jsonb_array_elements_text(${p.add(JSON.stringify(options.userIds))}::text::jsonb)`,
    );
  }
  if (options.roles?.length) {
    fromClauses.push(
      `select id as uid from app_users where role in (select value::text from jsonb_array_elements_text(${p.add(JSON.stringify(options.roles))}::text::jsonb))`,
    );
  }

  if (!fromClauses.length) return 0; // 没指定接收人，不发

  const receivers = fromClauses.length > 1
    ? `(${fromClauses.join(' union ')}) as u`
    : `(${fromClauses[0]}) as u`;

  const result = await sql.unsafe(
    `insert into notifications (user_id, type, title, content, payload)
     select u.uid, ${p.add(options.type)}, ${p.add(options.title)},
       ${p.add(options.content ?? null)}, ${p.add(JSON.stringify(options.payload ?? {}))}::text::jsonb
     from ${receivers}`,
    p.all,
  );
  return (result as { count?: number }).count ?? 0;
}
