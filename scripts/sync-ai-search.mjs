/**
 * 把 PostgreSQL 里的知识文档 / 商品文档分页同步到 Cloudflare AI Search 内置存储。
 *
 * 与 scripts/ingest.mjs 一样通过 ADMIN_TOKEN + API_BASE 调管理接口；
 * 幂等由 Worker 侧的 ai_search_sync 表（content_hash）保证，中断后重跑即可。
 *
 * 用法：
 *   npm run sync:ai-search -- --kind=kb            # 只同步约 500 条知识文档（先跑这个）
 *   npm run sync:ai-search -- --kind=sku --limit=200  # 小批量验证商品文档
 *   npm run sync:ai-search                         # kb + sku 全量
 *   npm run sync:ai-search -- --force             # 忽略 hash，强制重传
 *   npm run sync:ai-search -- --dry-run           # 只看将同步多少条
 */
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
const LIMIT = Math.max(0, Number(argValue('limit', 0)));
const FORCE = ARGS.has('--force');
const DRY_RUN = ARGS.has('--dry-run');
const KIND_ARG = argValue('kind', 'all');
const KINDS = KIND_ARG === 'kb' ? ['kb'] : KIND_ARG === 'sku' ? ['sku'] : ['kb', 'sku'];

if (!TOKEN) {
  console.error('缺少 ADMIN_TOKEN：请设置环境变量，或在 .dev.vars 里配置。');
  process.exit(1);
}

function headers() {
  return { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN };
}

async function request(endpoint, body, method = body ? 'POST' : 'GET', retries = 6) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(`${API_BASE}${endpoint}`, {
        method,
        headers: headers(),
        body: body ? JSON.stringify(body) : undefined,
        // 单批 40 条上传可能较慢，但必须有上限，否则网络抖动会让脚本永久挂起。
        signal: AbortSignal.timeout(Number(process.env.SYNC_REQUEST_TIMEOUT_MS || 180000)),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${payload.error || JSON.stringify(payload)}`);
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        // 平台在索引队列积压时会短暂返回 503，需要比普通网络抖动更长的退避。
        const serverError = /HTTP 5\d\d/.test(String(error?.message ?? error));
        const delay = Math.min(
          (serverError ? 3000 : 500) * 2 ** (attempt - 1),
          30000,
        );
        console.warn(`  ↻ ${endpoint} 第 ${attempt} 次失败，${delay}ms 后重试：${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw new Error(`${endpoint} 连续 ${retries} 次失败：${lastError?.message}`);
}

async function syncKind(kind) {
  console.log(`\n同步 ${kind === 'kb' ? '知识库文档' : '商品文档'}（batch=${BATCH}${FORCE ? '，force' : ''}）…`);
  let offset = START;
  let processed = 0;
  let uploaded = 0;
  let skipped = 0;
  let batches = 0;

  for (;;) {
    if (LIMIT > 0 && processed >= LIMIT) {
      console.log(`  已达到 --limit=${LIMIT}，提前结束（下次可用 --start=${offset} 续传）。`);
      break;
    }
    const limit = LIMIT > 0 ? Math.min(BATCH, LIMIT - processed) : BATCH;
    if (DRY_RUN) {
      console.log(`[dry-run] 将请求 kind=${kind} offset=${offset} limit=${limit}，未发送写入请求。`);
      return;
    }
    const result = await request('/api/admin/ai-search/sync', {
      kind, offset, limit, force: FORCE,
    });
    processed += result.processed ?? 0;
    uploaded += result.uploaded ?? 0;
    skipped += result.skipped ?? 0;
    batches += 1;
    if (result.errors?.length) {
      for (const message of result.errors.slice(0, 5)) console.warn(`  ! ${message}`);
    }
    console.log(
      `  ${kind} ${result.offset + result.processed}/${result.total} 批｜本批上传 ${result.uploaded}｜跳过 ${result.skipped}`,
    );
    if (result.nextOffset === null || result.nextOffset === undefined) break;
    offset = result.nextOffset;
  }

  console.log(`✓ ${kind} 完成：${batches} 批，处理 ${processed} 条，上传 ${uploaded} 条，跳过 ${skipped} 条`);
}

async function main() {
  console.log(`目标服务：${API_BASE}`);
  const status = await request('/api/admin/ai-search/status');
  const ai = status.aiSearch ?? {};
  console.log(`绑定：${ai.bound ? '正常' : '缺失'}｜实例 ${ai.instance}｜当前引擎 ${ai.engine}`);
  if (!ai.bound) {
    throw new Error('AI_SEARCH 绑定不可用：请确认 wrangler.jsonc 已配置 ai_search_namespaces 并已部署。');
  }
  for (const kind of KINDS) await syncKind(kind);
  if (!DRY_RUN) {
    console.log('\n上传是异步索引，等几分钟后用 GET /api/admin/ai-search/status 查看 stats，再做检索验证。');
  }
}

main().catch((error) => {
  console.error(`\n✗ 失败：${error.message}`);
  process.exit(1);
});
