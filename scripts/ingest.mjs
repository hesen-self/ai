import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = new Set(process.argv.slice(2));
const argValue = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

async function loadDevVars() {
  const vars = {};
  try {
    const content = await fs.readFile(path.join(ROOT, '.dev.vars'), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && !line.trim().startsWith('#')) vars[match[1]] = match[2].trim();
    }
  } catch {
    /* .dev.vars 不存在时忽略 */
  }
  return vars;
}

const dev = await loadDevVars();
const API_BASE = (process.env.API_BASE || dev.API_BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_TOKEN || dev.ADMIN_TOKEN || '';
const BATCH = Math.max(1, Math.min(80, Number(argValue('batch', 40))));
const START = Math.max(0, Number(argValue('start', 0)));
const LIMIT = Number(argValue('limit', 0));
const FORCE = ARGS.has('--force');
const DRY_RUN = ARGS.has('--dry-run');
const MIGRATE = ARGS.has('--migrate');
const KNOWLEDGE_ONLY = ARGS.has('--knowledge-only');
const FILE_ARG = argValue('file', '');

if (!TOKEN) {
  console.error('缺少 ADMIN_TOKEN：请设置环境变量，或复制 .dev.vars.example 为 .dev.vars 并填写。');
  process.exit(1);
}

async function request(endpoint, body, method = body ? 'POST' : 'GET', retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(`${API_BASE}${endpoint}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': TOKEN,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${payload.error || JSON.stringify(payload)}`);
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        const delay = 500 * 2 ** (attempt - 1);
        console.warn(`  ↻ ${endpoint} 第 ${attempt} 次失败，${delay}ms 后重试：${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw new Error(`${endpoint} 连续 ${retries} 次失败：${lastError?.message}`);
}

async function collectRawItems() {
  const files = FILE_ARG
    ? [FILE_ARG]
    : (await fs.readdir(path.join(ROOT, 'docs')))
        .filter((name) => name.toLowerCase().endsWith('.json'))
        .map((name) => path.join(ROOT, 'docs', name));

  const items = [];
  for (const file of files) {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [];
    if (!list.length) {
      console.warn(`跳过 ${path.basename(file)}：未找到商品数组`);
      continue;
    }
    console.log(`读取 ${path.basename(file)}：${list.length} 条`);
    items.push(...list);
  }
  return items;
}

async function buildKnowledge() {
  console.log('\n[3/3] 构建商品知识库（类目 / 供应商 / 价格带 / 选购指南）…');
  let offset = 0;
  let total = 0;
  let embedded = 0;
  let batches = 0;
  for (;;) {
    const result = await request('/api/admin/build-knowledge', { offset, limit: 120, force: FORCE });
    total = result.total;
    embedded += result.embedded;
    batches += 1;
    process.stdout.write(`  知识文档 ${result.total} 条，已处理 offset=${offset}，本批向量化 ${result.embedded} 条\n`);
    if (result.nextOffset === null || result.nextOffset === undefined) break;
    offset = result.nextOffset;
  }
  console.log(`✓ 知识库完成：${total} 条文档，${embedded} 条重新向量化，${batches} 批`);
}

async function main() {
  console.log(`目标服务：${API_BASE}`);
  const status = await request('/api/admin/status');
  console.log(`绑定状态：${status.ok ? '正常' : '异常'}｜模型 ${status.config.embeddingModel}｜索引 ${status.config.indexName}`);
  console.log(`当前数据库：${status.database.stats?.total ?? 0} 个 SKU，${status.database.knowledge_docs ?? 0} 条知识文档`);

  if (MIGRATE) {
    console.log('\n[1/3] 执行数据库迁移…');
    const result = await request('/api/admin/migrate', {});
    console.log(`✓ 迁移完成：${result.statements} 条 DDL，管理员账号 ${result.adminSeeded ? '已写入' : '未配置'}`);
  }

  if (!KNOWLEDGE_ONLY) {
    console.log('\n[2/3] 导入 docs/*.json → PostgreSQL + Vectorize…');
    const all = await collectRawItems();
    const end = LIMIT > 0 ? Math.min(all.length, START + LIMIT) : all.length;
    const target = all.slice(START, end);
    if (!target.length) throw new Error('没有可导入的商品记录');
    if (DRY_RUN) {
      console.log(`[dry-run] 将导入 ${target.length} 条（从第 ${START} 条开始，每批 ${BATCH} 条），未发送任何写入请求。`);
      return;
    }

    const tally = { received: 0, upserted: 0, embedded: 0, skipped: 0, rejected: 0 };
    const started = Date.now();
    const batchCount = Math.ceil(target.length / BATCH);
    for (let i = 0; i < batchCount; i += 1) {
      const chunk = target.slice(i * BATCH, (i + 1) * BATCH);
      const result = await request('/api/admin/ingest', { items: chunk, force: FORCE });
      for (const key of Object.keys(tally)) tally[key] += Number(result[key] ?? 0);
      if ((i + 1) % 10 === 0 || i + 1 === batchCount) {
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`  ${String(i + 1).padStart(4)}/${batchCount} 批｜已向量化 ${tally.embedded}｜跳过 ${tally.skipped}｜耗时 ${elapsed}s`);
      }
    }
    console.log(`✓ 商品导入完成：${JSON.stringify(tally)}`);
  }

  if (!DRY_RUN) await buildKnowledge();
  console.log('\n全部完成。Vectorize 写入是最终一致的，建议等待几秒后再做检索验证。');
}

main().catch((error) => {
  console.error(`\n✗ 失败：${error.message}`);
  process.exit(1);
});
