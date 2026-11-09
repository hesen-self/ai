/**
 * 校验 sql/ 目录下的迁移文件与 src/schema.ts 的 MIGRATIONS 登记是否一致。
 * 已挂在 pretypecheck / predeploy 钩子上，防止新增 SQL 后漏登记而静默不生效。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL_DIR = path.join(ROOT, 'sql');
const REGISTRY = path.join(ROOT, 'src', 'schema.ts');

const NAMING = /^\d{3}_[a-z0-9_]+\.sql$/;
const allSqlFiles = fs.readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort();
const files = allSqlFiles.filter((f) => NAMING.test(f));
const badNames = allSqlFiles.filter((f) => !NAMING.test(f));

const source = fs.readFileSync(REGISTRY, 'utf8');
const registered = [...source.matchAll(/from '\.\.\/sql\/([^']+\.sql)'/g)].map((m) => m[1]);
const listed = [...source.matchAll(/file:\s*'([^']+\.sql)'/g)].map((m) => m[1]);

const problems = [];
if (badNames.length) {
  problems.push(`命名不符合 NNN_xxx.sql 规范：${badNames.join(', ')}`);
}
if (!files.length) {
  problems.push('sql/ 目录下没有符合命名规范的迁移文件');
}
for (const file of files) {
  if (!registered.includes(file)) problems.push(`未 import：sql/${file}`);
  if (!listed.includes(file)) problems.push(`MIGRATIONS 未登记：${file}`);
}
for (const file of registered) {
  if (!files.includes(file)) problems.push(`src/schema.ts 仍 import 已不存在的文件：${file}`);
}
for (const file of listed) {
  if (!files.includes(file)) problems.push(`MIGRATIONS 仍登记已不存在的文件：${file}`);
}

const expectedOrder = [...files].sort();
const actualOrder = listed.filter((f) => files.includes(f));
if (actualOrder.join('|') !== expectedOrder.join('|')) {
  problems.push(`MIGRATIONS 顺序应为 ${expectedOrder.join(' → ')}，当前为 ${actualOrder.join(' → ')}`);
}
const duplicates = listed.filter((f, i) => listed.indexOf(f) !== i);
if (duplicates.length) problems.push(`MIGRATIONS 存在重复登记：${[...new Set(duplicates)].join(', ')}`);

if (problems.length) {
  console.error('SQL 迁移登记校验失败：');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\n参考 sql/README.md：新增文件后需在 src/schema.ts 中 import 并追加 MIGRATIONS 项。');
  process.exit(1);
}

console.log(`sql: ${files.length} 个迁移文件已登记且顺序正确 (${files.join(' → ')})`);
