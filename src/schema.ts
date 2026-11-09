/**
 * PostgreSQL DDL 注册中心。
 *
 * SQL 文件是唯一权威源，放在 sql/ 目录，由 wrangler.jsonc 中 type 为 Text 的
 * rules 规则把 .sql 文件作为文本模块内联进 Worker。
 * 这里只负责：登记迁移顺序、导出可逐条执行的语句、导出合并文本。
 */
import initSql from '../sql/001_init.sql';
import aiSearchSyncSql from '../sql/002_ai_search_sync.sql';
import { splitStatements } from './sql-split';

export interface Migration {
  file: string;
  sql: string;
}

/**
 * 迁移清单：新增 sql/NNN_*.sql 后，在此 import 并追加一项。
 * 顺序必须与文件名排序一致；scripts/check-sql.mjs 会校验目录与清单是否同步。
 */
export const MIGRATIONS: Migration[] = [
  { file: '001_init.sql', sql: initSql },
  { file: '002_ai_search_sync.sql', sql: aiSearchSyncSql },
];

/** 供 /api/admin/migrate 逐条执行，保持与原实现相同的接口。 */
export const SCHEMA_STATEMENTS: string[] = MIGRATIONS.flatMap((m) => splitStatements(m.sql));

/** 供 GET /api/admin/schema 返回：带文件名分隔的完整 SQL 文本（保留原始注释）。 */
export const SCHEMA_SQL: string = MIGRATIONS.map(
  (m) => `-- ==================== ${m.file} ====================\n${m.sql.trim()}`,
).join('\n\n');
