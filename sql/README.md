# SQL 迁移目录

本目录是 **DDL 的唯一权威源**。Worker 里没有第二份手工维护的 SQL 字符串：`src/schema.ts` 直接 import 这里的 `.sql` 文件，由 `wrangler.jsonc` 的 `Text` 模块规则作为独立 Text 模块随 Worker 一起上传（`wrangler deploy --dry-run --outdir dist` 可在 `dist/` 看到该模块）。

## 文件命名

```
sql/
  001_init.sql        初始建表
  002_add_xxx.sql     后续变更（示例）
  003_yyy.sql
  README.md           本文件
```

- 前缀 `NNN_`：三位数字决定执行顺序，按文件名排序，编号不要复用。
- 文件名只用小写字母、数字、下划线，便于登记与校验。
- **所有语句必须幂等**：`CREATE TABLE/INDEX IF NOT EXISTS`、`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`、`ON CONFLICT DO NOTHING` 等。`/api/admin/migrate` 每次都会把登记过的文件全量重放一遍，不记录已执行版本。
- 每条语句以分号结尾；支持 `--` 行注释、`/* */` 块注释、单引号字符串和 `$$ ... $$` dollar-quoted 函数体（拆句逻辑见 `src/sql-split.ts` 的 `splitStatements`）。

## 新增一个迁移

1. 在 `sql/` 新建 `NNN_description.sql`，写幂等 DDL。
2. 在 `src/schema.ts` 顶部 `import`，并往 `MIGRATIONS` 数组追加一项（顺序必须与文件名顺序一致）：

   ```ts
   import initSql from '../sql/001_init.sql';
   import addXxxSql from '../sql/002_add_xxx.sql';

   export const MIGRATIONS = [
     { file: '001_init.sql', sql: initSql },
     { file: '002_add_xxx.sql', sql: addXxxSql },
   ];
   ```

   > 忘了登记不会静默生效：`npm run sql:check`（已挂在 `typecheck` / `deploy` 的前置钩子上）会对比目录文件与登记项，漏登或残留都会报错。

3. 本地验证：`npm run typecheck`，再 `npx wrangler deploy --dry-run` 确认 SQL 被打进包。
4. 执行：部署后调用 `POST /api/admin/migrate`（需 `X-Admin-Token`），或直接用 psql 按编号顺序执行：

   ```bash
   psql "$DATABASE_URL" -f sql/002_add_xxx.sql
   ```

> `psql` 单文件执行不受 `MIGRATIONS` 约束，但两条路径最终执行的内容要保持一致，否则线上与本地表结构会分叉。

## 相关接口

| 接口 | 作用 |
| --- | --- |
| `GET /api/admin/schema` | 返回当前登记的全部 SQL 文本（合并后，带文件名分隔），供运维核对 |
| `POST /api/admin/migrate` | 按登记顺序逐条执行全部语句，并按需写入初始管理员账号 |
