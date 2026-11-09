#!/usr/bin/env node
/**
 * dev-agent.mjs — 开发治理 Agent 的执行层（零新增依赖，Node >= 20）
 *
 * 两个职责：
 *   1. 代码质量管理：类型检查 + 项目特有一致性校验 + 静态卫生扫描 + 基线门禁
 *   2. 日常开发习惯记录：append-only 事件流 + 周报/趋势 digest
 *
 * 命令：
 *   check [--strict] [--json] [--no-typecheck]   质量检查并生成报告
 *   baseline                                    把当前结果设为已知基线
 *   log --type=... [--note=...] [--source=...]   记录一条开发事件
 *   digest [--days=7]                           汇总习惯与质量趋势
 *   guard [--hook]                              check(strict) + 自动记录，供 pre-commit 使用
 *   install-hooks                               安装 .git/hooks/pre-commit
 *
 * 所有产物写入 .workbuddy/，不改动业务代码，不联网，不调用 LLM。
 */

import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WB = join(ROOT, '.workbuddy');
const QUALITY_DIR = join(WB, 'quality');
const REPORT_DIR = join(QUALITY_DIR, 'reports');
const HABITS_DIR = join(WB, 'habits');
const DIGEST_DIR = join(HABITS_DIR, 'digests');
const EVENTS_FILE = join(HABITS_DIR, 'events.jsonl');
const RULES_FILE = join(QUALITY_DIR, 'rules.json');
const BASELINE_FILE = join(QUALITY_DIR, 'baseline.json');
const LATEST_FILE = join(QUALITY_DIR, 'latest.json');
const HOOK_SRC = join(ROOT, '.githooks', 'pre-commit');
const HOOK_DEST = join(ROOT, '.git', 'hooks', 'pre-commit');

const EVENT_TYPES = [
  'check',
  'commit',
  'review',
  'refactor',
  'bugfix',
  'test',
  'docs',
  'chore',
  'learning',
  'session',
];

const DEFAULT_SEVERITY = {
  typescript: 'error',
  'schema-sync': 'error',
  'config-sync': 'error',
  'secret-literal': 'error',
  'process-env': 'error',
  'batch-sync': 'warn',
  'bindings-declared': 'warn',
  'docs-paths': 'warn',
  'routes-mounted': 'warn',
  'debug-log': 'warn',
  'explicit-any': 'warn',
  'ts-suppress': 'warn',
  'large-file': 'warn',
  'staged-size': 'warn',
  'unsafe-html': 'info',
  'swallowed-error': 'info',
  'todo-debt': 'info',
  'sql-template': 'info',
};

const DEFAULT_THRESHOLDS = {
  maxFileLines: 600,
  maxTodoCount: 20,
  maxStagedChangedLines: 800,
};

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function ensure(...dirs) {
  for (const dir of dirs) if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function read(file) {
  try {
    return readFileSync(join(ROOT, file), 'utf8');
  } catch {
    return '';
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function rel(absOrRel) {
  return relative(ROOT, absOrRel.startsWith(ROOT) ? absOrRel : join(ROOT, absOrRel))
    .split(sep)
    .join('/');
}

function now() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const tz = `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return {
    iso: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${tz}`,
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hour: d.getHours(),
    weekday: d.getDay(),
    stamp: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`,
  };
}

function git(...args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 && !r.error ? (r.stdout || '').trim() : '';
}

// 逐字符剥离 JSONC 注释：glob 字符串里的星号斜杠不能当成块注释起止符。
function stripJsonc(text) {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, text.length);
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function walk(dir, exts, out = []) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs)) {
    const full = join(abs, name);
    if (statSync(full).isDirectory()) {
      if (['node_modules', '.git', '.wrangler', 'dist'].includes(name)) continue;
      walk(rel(full), exts, out);
    } else if (exts.some((e) => name.endsWith(e))) {
      out.push(rel(full));
    }
  }
  return out;
}

function lines(text) {
  return text.split(/\r?\n/);
}

function loadRules() {
  const cfg = readJson(RULES_FILE, {});
  return {
    severity: { ...DEFAULT_SEVERITY, ...(cfg.severity || {}) },
    thresholds: { ...DEFAULT_THRESHOLDS, ...(cfg.thresholds || {}) },
    off: cfg.off || [],
    excludePaths: cfg.excludePaths || [],
  };
}

function isExcluded(file, patterns) {
  return patterns.some((pattern) => {
    if (pattern.endsWith('/**')) return file.startsWith(pattern.slice(0, -2));
    if (pattern.startsWith('*.')) return file.endsWith(pattern.slice(1));
    return file === pattern || file.startsWith(`${pattern}/`);
  });
}

// ---------------------------------------------------------------------------
// 代码质量检查
// ---------------------------------------------------------------------------

function runCheck(opts = {}) {
  const rules = loadRules();
  const findings = [];
  const checkedAt = now();
  let typecheckFailed = false;

  const add = (rule, file, line, message) => {
    const severity = rules.severity[rule] || 'info';
    if (severity === 'off' || rules.off.includes(rule)) return;
    findings.push({
      rule,
      severity,
      file: file || '(project)',
      line: line || 0,
      message,
      fingerprint: `${rule}|${file || '(project)'}|${message}`,
    });
  };

  // --- 1. TypeScript 类型检查 -------------------------------------------------
  if (!opts.noTypecheck) {
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    if (existsSync(tsc)) {
      const r = spawnSync(process.execPath, [tsc, '--noEmit'], { cwd: ROOT, encoding: 'utf8' });
      const output = `${r.stdout || ''}${r.stderr || ''}`;
      if (r.status !== 0) {
        typecheckFailed = true;
        const matched = output.match(/^.*error TS\d+:.*$/gm) || [];
        const items = matched.length ? matched : [`类型检查失败（exit ${r.status}）`];
        for (const item of items.slice(0, 40)) {
          const m = /^(.+?)\((\d+),\d+\):\s*(.+)$/.exec(item);
          add('typescript', m ? rel(m[1].trim()) : '(project)', m ? Number(m[2]) : 0, m ? m[3] : item.trim());
        }
      }
    } else {
      add('typescript', 'node_modules/typescript', 0, '未安装 typescript，跳过类型检查');
    }
  }

  // --- 2. 配置一致性：src/config.ts ↔ wrangler.jsonc -------------------------
  const configTs = read('src/config.ts');
  const wranglerText = read('wrangler.jsonc');
  let wrangler = {};
  try {
    wrangler = JSON.parse(stripJsonc(wranglerText));
  } catch {
    add('config-sync', 'wrangler.jsonc', 0, 'wrangler.jsonc 无法解析（含注释的 JSONC 解析失败）');
  }
  const configValue = (name) => {
    const m = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`).exec(configTs);
    return m ? m[1] : null;
  };
  const pairs = [
    ['EMBEDDING_MODEL', wrangler.vars?.EMBEDDING_MODEL],
    ['CHAT_MODEL', wrangler.vars?.CHAT_MODEL],
    ['INDEX_NAME', wrangler.vars?.VECTORIZE_INDEX_NAME],
  ];
  for (const [key, declared] of pairs) {
    const actual = configValue(key);
    if (declared === undefined) {
      add('config-sync', 'wrangler.jsonc', 0, `vars 中缺少与 src/config.ts 的 ${key} 对应的声明`);
    } else if (actual && actual !== declared) {
      add('config-sync', 'src/config.ts', 0, `${key} 不一致：config.ts=${actual} / wrangler.jsonc=${declared}`);
    }
  }

  // --- 3. 批量大小一致性：config.ts ↔ scripts/ingest.mjs -------------------
  const ingest = read('scripts/ingest.mjs');
  const serverBatch = /export\s+const\s+INGEST_BATCH\s*=\s*(\d+)/.exec(configTs)?.[1];
  const clientBatch = /argValue\(['"]batch['"],\s*(\d+)\)/.exec(ingest)?.[1];
  if (serverBatch && clientBatch && serverBatch !== clientBatch) {
    add('batch-sync', 'scripts/ingest.mjs', 0, `默认批量不一致：config.INGEST_BATCH=${serverBatch} / ingest.mjs=${clientBatch}`);
  }

  // --- 4. DDL 一致性：schema.sql ↔ sql/*.sql -------------------------------
  const parseTables = (text) => {
    const tables = new Map();
    const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s*\(([\s\S]*?)\n\);/gi;
    let m;
    while ((m = re.exec(text))) {
      const cols = new Set();
      for (const raw of lines(m[2])) {
        const line = raw.trim();
        if (!line || line.startsWith('--') || /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)/i.test(line)) continue;
        const col = /^([a-zA-Z_][\w]*)/.exec(line)?.[1];
        if (col) cols.add(col.toLowerCase());
      }
      tables.set(m[1].toLowerCase(), cols);
    }
    return tables;
  };
  const rootDdl = parseTables(read('schema.sql'));
  const sqlFiles = walk('sql', ['.sql']);
  if (rootDdl.size && sqlFiles.length) {
    const migrationDdl = parseTables(sqlFiles.map((f) => read(f)).join('\n'));
    for (const [table, cols] of rootDdl) {
      if (!migrationDdl.has(table)) {
        add('schema-sync', 'schema.sql', 0, `schema.sql 中的表 ${table} 在 sql/*.sql 迁移里不存在`);
        continue;
      }
      const other = migrationDdl.get(table);
      const missing = [...cols].filter((c) => !other.has(c));
      const extra = [...other].filter((c) => !cols.has(c));
      if (missing.length || extra.length) {
        add(
          'schema-sync',
          'schema.sql',
          0,
          `表 ${table} 列不一致：schema.sql 独有 [${missing.join(', ') || '无'}] / 迁移独有 [${extra.join(', ') || '无'}]`,
        );
      }
    }
    for (const table of migrationDdl.keys()) {
      if (!rootDdl.has(table)) add('schema-sync', 'sql/001_init.sql', 0, `迁移中的表 ${table} 未同步到 schema.sql`);
    }
  }

  // --- 5. 绑定声明一致性 ----------------------------------------------------
  const bindings = [
    wrangler.ai?.binding,
    wrangler.assets?.binding,
    ...(wrangler.vectorize || []).map((v) => v.binding),
    ...(wrangler.hyperdrive || []).map((v) => v.binding),
  ].filter(Boolean);
  const typesTs = read('src/types.ts');
  for (const b of bindings) {
    if (!new RegExp(`\\b${b}\\b`).test(typesTs)) {
      add('bindings-declared', 'src/types.ts', 0, `wrangler.jsonc 绑定 ${b} 未在 Env 接口中声明`);
    }
  }

  // --- 6. 路由挂载一致性 ----------------------------------------------------
  const indexTs = read('src/index.ts');
  const routeImports = [...indexTs.matchAll(/import\s+(\w+)\s+from\s+['"]\.\/routes\/([^'"]+)['"]/g)];
  for (const [, name, file] of routeImports) {
    if (!new RegExp(`app\\.route\\([^)]*\\b${name}\\b`).test(indexTs)) {
      add('routes-mounted', 'src/index.ts', 0, `路由模块 ${file} 已导入但未通过 app.route 挂载`);
    }
  }
  const routeFiles = walk('src/routes', ['.ts']);
  const imported = new Set(routeImports.map((m) => `${m[2]}.ts`));
  for (const f of routeFiles) {
    const base = f.split('/').pop();
    if (base !== 'index.ts' && !imported.has(base)) {
      add('routes-mounted', f, 0, '路由文件存在但 src/index.ts 未导入');
    }
  }

  // --- 7. README 引用路径存在性 ---------------------------------------------
  const readme = lines(read('README.md'));
  const seenPaths = new Set();
  readme.forEach((text, i) => {
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
      const candidate = m[1];
      if (!/^(src|scripts|public|docs|sql|wrangler|schema|package|tsconfig|\.workbuddy|\.githooks)(\/|\.|$)/.test(candidate)) continue;
      if (/\s|[|]/.test(candidate)) continue;
      if (seenPaths.has(candidate)) continue;
      seenPaths.add(candidate);
      const target = candidate.includes('*') ? candidate.slice(0, candidate.indexOf('*')).replace(/\/$/, '') : candidate;
      if (target && !existsSync(join(ROOT, target))) {
        add('docs-paths', 'README.md', i + 1, `文档引用的路径不存在：\`${candidate}\``);
      }
    }
  });

  // --- 8. 静态卫生扫描 ------------------------------------------------------
  const scanFiles = [...walk('src', ['.ts']), ...walk('scripts', ['.mjs']), ...walk('public', ['.js'])];
  let todoCount = 0;
  let scannedCount = 0;
  const secretPlaceholder = /^(xxx+|your|replace|change|example|placeholder|sample|test|dev|<\$|\$\{|REPLACE_WITH|CHANGEME)/i;

  for (const file of scanFiles) {
    if (isExcluded(file, rules.excludePaths)) continue;
    scannedCount += 1;
    const content = read(file);
    const rows = lines(content);
    const inSrc = file.startsWith('src/');

    if (rows.length > rules.thresholds.maxFileLines) {
      add('large-file', file, 0, `文件 ${rows.length} 行，超过阈值 ${rules.thresholds.maxFileLines} 行，建议拆分`);
    }

    rows.forEach((text, i) => {
      const line = i + 1;
      const trimmed = text.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

      if (inSrc && /\bconsole\.log\s*\(/.test(text)) {
        add('debug-log', file, line, '生产代码中的 console.log 调试输出，请改用结构化日志或删除');
      }
      if (/:\s*any\b|\bas\s+any\b|<any>/.test(text)) {
        add('explicit-any', file, line, '显式 any 绕过了 strict 类型检查');
      }
      if (/@ts-ignore|@ts-nocheck|@ts-expect-error|eslint-disable/.test(text)) {
        add('ts-suppress', file, line, '类型/规则抑制注释，请补充原因或改用类型修复');
      }
      if (inSrc && /\bprocess\.env\b/.test(text)) {
        add('process-env', file, line, 'Workers 环境没有 process.env，应通过 c.env 读取绑定与变量');
      }
      const secret = /(?:JWT_SECRET|ADMIN_PASSWORD|ADMIN_TOKEN|PASSWORD|SECRET|API_KEY|apiKey|accessToken)\s*[:=]\s*['"`]([^'"`]{8,})['"`]/i.exec(text);
      if (secret && !secretPlaceholder.test(secret[1]) && !/\.example$/.test(file)) {
        add('secret-literal', file, line, '疑似硬编码凭据，请改用 wrangler secret / 环境变量');
      }
      if (/\b(?:TODO|FIXME|HACK|XXX)\b/.test(text)) todoCount += 1;
      if (/catch\s*\{\s*\}/.test(text) || /\.catch\(\s*\(\)\s*=>\s*(?:undefined|null|\{\})\s*\)/.test(text)) {
        add('swallowed-error', file, line, '异常被静默吞掉，排障时会失去线索');
      }
      if (file.startsWith('public/') && /\.innerHTML\s*=/.test(text)) {
        add('unsafe-html', file, line, 'innerHTML 直出，拼接服务端数据时需确认已转义');
      }
      if (/\.unsafe\s*\(/.test(text) && /\$\{/.test(text)) {
        add('sql-template', file, line, 'sql.unsafe 中的动态拼接，确认片段只来自白名单或已参数化，不接受用户输入');
      }
    });
  }
  if (todoCount > rules.thresholds.maxTodoCount) {
    add('todo-debt', '(project)', 0, `TODO/FIXME 共 ${todoCount} 处，超过阈值 ${rules.thresholds.maxTodoCount}`);
  }

  // --- 9. 暂存区提交粒度 ----------------------------------------------------
  const staged = git('diff', '--cached', '--shortstat');
  const changed = /(\d+)\s+insertion/.exec(staged)?.[1] || 0;
  const deleted = /(\d+)\s+deletion/.exec(staged)?.[1] || 0;
  const stagedLines = Number(changed) + Number(deleted);
  if (stagedLines > rules.thresholds.maxStagedChangedLines) {
    add('staged-size', '(git)', 0, `本次暂存变更 ${stagedLines} 行，超过 ${rules.thresholds.maxStagedChangedLines} 行，建议拆分提交`);
  }

  // --- 汇总与基线对比 -------------------------------------------------------
  const counts = {
    error: findings.filter((f) => f.severity === 'error').length,
    warn: findings.filter((f) => f.severity === 'warn').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
  const score = Math.max(0, Math.round((100 - counts.error * 10 - counts.warn * 2 - counts.info * 0.5) * 10) / 10);
  const baseline = readJson(BASELINE_FILE, null);
  const known = new Set((baseline?.fingerprints || []));
  const newFindings = baseline
    ? findings.filter((f) => f.severity !== 'info' && !known.has(f.fingerprint))
    : findings.filter((f) => f.severity !== 'info');
  const fixedCount = baseline
    ? (baseline.fingerprints || []).filter((fp) => !findings.some((f) => f.fingerprint === fp)).length
    : 0;

  const result = {
    checkedAt: checkedAt.iso,
    score,
    counts,
    newIssues: newFindings.length,
    fixedSinceBaseline: fixedCount,
    filesScanned: scannedCount,
    typecheck: opts.noTypecheck ? 'skipped' : typecheckFailed ? 'failed' : 'passed',
    stagedLines,
    findings,
  };
  return { result, rules };
}

function renderReport(result) {
  const order = { error: 0, warn: 1, info: 2 };
  const sorted = [...result.findings].sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file));
  const label = { error: '阻断', warn: '警告', info: '提示' };
  const out = [
    `# 代码质量报告 · ${result.checkedAt}`,
    '',
    `- 质量分：**${result.score} / 100**`,
    `- 阻断 ${result.counts.error} / 警告 ${result.counts.warn} / 提示 ${result.counts.info}`,
    `- 相对基线：新增问题 ${result.newIssues} 个，已修复 ${result.fixedSinceBaseline} 个`,
    `- 扫描文件 ${result.filesScanned} 个｜TypeScript：${result.typecheck}｜暂存变更 ${result.stagedLines} 行`,
    '',
  ];
  if (!sorted.length) {
    out.push('未发现问题。干净得让人怀疑是不是没扫到文件。', '');
  } else {
    out.push('| 级别 | 规则 | 位置 | 说明 |', '| --- | --- | --- | --- |');
    for (const f of sorted) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      out.push(`| ${label[f.severity]} | \`${f.rule}\` | \`${loc}\` | ${f.message.replace(/\|/g, '\\|')} |`);
    }
    out.push('');
  }
  out.push(
    '## 说明',
    '',
    '- `阻断` 会拦下 `guard` / pre-commit 门禁（仅拦「基线之后新增」的问题）。',
    '- 规则阈值与级别在 `.workbuddy/quality/rules.json` 调整；`npm run agent:baseline` 可重设基线。',
    '- 每次检查结果会作为 `check` 事件写入习惯事件流，用于趋势分析。',
    '',
  );
  return out.join('\n');
}

function saveCheck(result, { quiet = false } = {}) {
  ensure(QUALITY_DIR, REPORT_DIR, HABITS_DIR, DIGEST_DIR);
  const stamp = now();
  writeFileSync(LATEST_FILE, JSON.stringify(result, null, 2), 'utf8');
  const reportFile = join(REPORT_DIR, `${stamp.stamp}.md`);
  writeFileSync(reportFile, renderReport(result), 'utf8');
  if (!quiet) {
    console.log(`[dev-agent] 质量分 ${result.score}/100｜阻断 ${result.counts.error} 警告 ${result.counts.warn} 提示 ${result.counts.info}｜新增 ${result.newIssues} 修复 ${result.fixedSinceBaseline}`);
    for (const f of result.findings.filter((x) => x.severity === 'error')) {
      console.log(`  x [${f.rule}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.message}`);
    }
    for (const f of result.findings.filter((x) => x.severity === 'warn').slice(0, 8)) {
      console.log(`  ! [${f.rule}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.message}`);
    }
    const rest = result.findings.filter((x) => x.severity !== 'error' && x.severity !== 'warn').length;
    if (rest) console.log(`  … 另有 ${rest} 条提示`);
    console.log(`  报告：${rel(reportFile)}`);
  }
  return reportFile;
}

// ---------------------------------------------------------------------------
// 开发习惯记录
// ---------------------------------------------------------------------------

function collectGit() {
  const shortstat = git('diff', '--shortstat');
  const stagedStat = git('diff', '--cached', '--shortstat');
  const parse = (s) => ({
    insertions: Number(/(\d+)\s+insertion/.exec(s)?.[1] || 0),
    deletions: Number(/(\d+)\s+deletion/.exec(s)?.[1] || 0),
  });
  const working = parse(shortstat);
  const staged = parse(stagedStat);
  const statusLines = git('status', '--porcelain').split('\n').filter(Boolean);
  const lastCommit = git('log', '-1', '--format=%h %s');
  return {
    branch: git('rev-parse', '--abbrev-ref', 'HEAD') || '(no-git)',
    lastCommit: lastCommit || '',
    changedFiles: statusLines.length,
    untrackedFiles: statusLines.filter((l) => l.startsWith('??')).length,
    insertions: working.insertions + staged.insertions,
    deletions: working.deletions + staged.deletions,
  };
}

function appendEvent(event) {
  ensure(HABITS_DIR);
  appendFileSync(EVENTS_FILE, `${JSON.stringify(event)}\n`, 'utf8');
}

function readEvents() {
  if (!existsSync(EVENTS_FILE)) return [];
  return lines(readFileSync(EVENTS_FILE, 'utf8'))
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function cmdLog(args, extra = {}) {
  const t = now();
  const type = String(args.type || extra.type || 'session');
  if (!EVENT_TYPES.includes(type)) {
    console.error(`[dev-agent] 未知事件类型 ${type}，可选：${EVENT_TYPES.join(', ')}`);
    return 1;
  }
  const latest = readJson(LATEST_FILE, null);
  const event = {
    ts: t.iso,
    date: t.date,
    hour: t.hour,
    weekday: t.weekday,
    type,
    note: String(args.note || extra.note || '').slice(0, 500),
    source: String(args.source || extra.source || 'cli'),
    quality: latest ? { score: latest.score, errors: latest.counts.error, warns: latest.counts.warn } : null,
    ...collectGit(),
  };
  appendEvent(event);
  if (!args.quiet) {
    console.log(`[dev-agent] 已记录 ${type} @ ${t.iso}${event.note ? `｜${event.note}` : ''}`);
    console.log(`  ${rel(EVENTS_FILE)}（append-only，共 ${readEvents().length} 条）`);
  }
  return 0;
}

function cmdDigest(args) {
  const days = Math.max(1, Math.min(90, Number(args.days || 7)));
  const all = readEvents();
  const since = Date.now() - days * 86400_000;
  const events = all.filter((e) => new Date(e.ts).getTime() >= since);
  const byType = {};
  const byDay = {};
  const byHour = { 深夜: 0, 上午: 0, 下午: 0, 晚上: 0 };
  let insertions = 0;
  let deletions = 0;
  let maxUntracked = 0;
  let lateCommits = 0;
  let bigCommits = 0;
  const scores = [];
  for (const e of events) {
    byType[e.type] = (byType[e.type] || 0) + 1;
    byDay[e.date] = (byDay[e.date] || 0) + 1;
    const h = Number(e.hour || 0);
    if (h < 6) byHour.深夜 += 1;
    else if (h < 12) byHour.上午 += 1;
    else if (h < 18) byHour.下午 += 1;
    else byHour.晚上 += 1;
    if (h >= 23 || h < 6) lateCommits += 1;
    insertions += Number(e.insertions || 0);
    deletions += Number(e.deletions || 0);
    maxUntracked = Math.max(maxUntracked, Number(e.untrackedFiles || 0));
    if (Number(e.insertions || 0) + Number(e.deletions || 0) > 800) bigCommits += 1;
    if (e.quality && typeof e.quality.score === 'number') scores.push(e.quality.score);
  }
  const activeDays = Object.keys(byDay).length;
  const checkCount = byType.check || 0;
  const firstScore = scores[0];
  const lastScore = scores[scores.length - 1];
  const advice = [];
  if (!events.length) {
    advice.push('这段时期没有任何记录。先跑 `npm run agent:log -- --type=session --note="今天做了什么"`，或者装上 pre-commit 门禁自动记。');
  } else {
    if (checkCount < activeDays) advice.push(`活跃 ${activeDays} 天只做了 ${checkCount} 次质量检查，建议每天收工前固定跑一次 \`npm run agent:check\`。`);
    if (lateCommits / events.length > 0.3) advice.push(`深夜（23:00–06:00）事件占比 ${Math.round((lateCommits / events.length) * 100)}%，熬夜写的代码第二天自己都看不懂。`);
    if (scores.length && lastScore < firstScore) advice.push(`质量分从 ${firstScore} 降到 ${lastScore}，先清掉新增的阻断项再开新功能。`);
    if (scores.some((s) => s < 80)) advice.push('期间出现过质量分低于 80 的检查，翻 `.workbuddy/quality/reports/` 找当时的报告。');
    if (bigCommits) advice.push(`有 ${bigCommits} 次超大变更（>800 行），大提交会让 review 和回滚都变痛苦。`);
    if (!byType.test) advice.push('没有 `test` 类事件：测试写了没记，还是压根没写？');
    if (!byType.review && !byType.learning) advice.push('没有 review / learning 记录，习惯日志不该只是流水账。');
    if (activeDays >= 5) advice.push(`连续记录 ${activeDays} 天，数据终于够看出趋势了，保持住。`);
    if (!advice.length) advice.push('节奏平稳，没有明显坏习惯。继续保持，别飘。');
  }

  const t = now();
  const fmt = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}：${v}`).join('\n') || '- 无';
  const md = [
    `# 开发习惯周报 · 近 ${days} 天`,
    '',
    `生成时间：${t.iso}｜事件 ${events.length} 条｜活跃 ${activeDays} 天`,
    '',
    '## 概况',
    '',
    `- 代码变更：+${insertions} / -${deletions} 行（git diff 口径；未跟踪的新文件不计入，期间最多 ${maxUntracked} 个）`,
    `- 质量检查：${checkCount} 次，质量分 ${scores.length ? `${Math.min(...scores)} ~ ${Math.max(...scores)}（末次 ${lastScore}）` : '无数据'}`,
    `- 时段分布：${Object.entries(byHour).map(([k, v]) => `${k} ${v}`).join('｜')}`,
    '',
    '## 事件类型',
    '',
    fmt(byType),
    '',
    '## 每日活跃度',
    '',
    fmt(byDay),
    '',
    '## 建议',
    '',
    ...advice.map((a) => `- ${a}`),
    '',
    '> 数据源：`.workbuddy/habits/events.jsonl`（append-only）。质量分来自每次 `check` 事件。',
    '',
  ].join('\n');

  ensure(DIGEST_DIR);
  const out = join(DIGEST_DIR, `${t.date}.md`);
  writeFileSync(out, md, 'utf8');
  console.log(`[dev-agent] 近 ${days} 天：${events.length} 条事件 / 活跃 ${activeDays} 天 / 检查 ${checkCount} 次`);
  for (const a of advice) console.log(`  - ${a.replace(/`/g, '')}`);
  console.log(`  周报：${rel(out)}`);
  return 0;
}

// ---------------------------------------------------------------------------
// 门禁 / 基线 / hooks
// ---------------------------------------------------------------------------

function cmdGuard(args) {
  const { result } = runCheck({ noTypecheck: Boolean(args['no-typecheck']) });
  saveCheck(result, { quiet: Boolean(args.quiet) });
  cmdLog({ type: 'check', source: args.hook ? 'pre-commit' : 'cli', note: `质量分 ${result.score}，阻断 ${result.counts.error}`, quiet: args.quiet }, {});
  if (args.hook && result.stagedLines > 0) {
    cmdLog({ type: 'commit', source: 'pre-commit', note: `暂存变更 ${result.stagedLines} 行`, quiet: args.quiet }, {});
  }
  const baseline = readJson(BASELINE_FILE, null);
  const known = new Set(baseline?.fingerprints || []);
  const blocking = result.findings.filter((f) => f.severity === 'error');
  const newBlocking = blocking.filter((f) => !known.has(f.fingerprint));
  const fail = baseline ? newBlocking.length > 0 : blocking.length > 0;
  if (fail) {
    console.error(`[dev-agent] 门禁未通过：${baseline ? '基线之后新增 ' : ''}${newBlocking.length || blocking.length} 个阻断项，先修再提交。`);
    for (const f of (baseline ? newBlocking : blocking).slice(0, 10)) {
      console.error(`  x [${f.rule}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.message}`);
    }
    return 1;
  }
  if (blocking.length) {
    console.log(`[dev-agent] 存在 ${blocking.length} 个基线内已知阻断项，本次不拦截。`);
  } else {
    console.log('[dev-agent] 门禁通过。');
  }
  return 0;
}

function cmdBaseline() {
  const { result } = runCheck({});
  ensure(QUALITY_DIR);
  writeFileSync(
    BASELINE_FILE,
    JSON.stringify(
      {
        generatedAt: result.checkedAt,
        score: result.score,
        counts: result.counts,
        fingerprints: result.findings.filter((f) => f.severity !== 'info').map((f) => f.fingerprint),
      },
      null,
      2,
    ),
    'utf8',
  );
  saveCheck(result, { quiet: true });
  console.log(`[dev-agent] 基线已写入 ${rel(BASELINE_FILE)}：质量分 ${result.score}，登记 ${result.findings.filter((f) => f.severity !== 'info').length} 个已知问题。`);
  console.log('  之后 guard 只拦截「基线之后新增」的阻断项；修完旧账记得重跑 baseline 收紧口径。');
  return 0;
}

function cmdInstallHooks() {
  const hookSource = `#!/bin/sh
# 由 npm run agent:hooks 生成：提交前执行开发治理门禁
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$ROOT" || exit 0
node scripts/dev-agent.mjs guard --hook --quiet
`;
  if (!existsSync(join(ROOT, '.git'))) {
    console.error('[dev-agent] 未找到 .git 目录，跳过 hook 安装。');
    return 1;
  }
  ensure(join(ROOT, '.githooks'), join(ROOT, '.git', 'hooks'));
  writeFileSync(HOOK_SRC, hookSource, 'utf8');
  if (existsSync(HOOK_DEST)) {
    const existing = readFileSync(HOOK_DEST, 'utf8');
    if (!/dev-agent/.test(existing)) {
      const backup = `${HOOK_DEST}.dev-agent-backup`;
      copyFileSync(HOOK_DEST, backup);
      console.log(`[dev-agent] 已有 pre-commit，先备份到 ${rel(backup)} 再覆盖。`);
    }
  }
  copyFileSync(HOOK_SRC, HOOK_DEST);
  try {
    chmodSync(HOOK_DEST, 0o755);
  } catch {
    // Windows 上 chmod 可能无效，git 仍可通过 sh 调用
  }
  const globalHooksPath = git('config', '--get', 'core.hooksPath');
  console.log(`[dev-agent] 已安装 ${rel(HOOK_DEST)}（源文件 ${rel(HOOK_SRC)}）`);
  if (globalHooksPath) {
    console.log(`  检测到 core.hooksPath=${globalHooksPath}；该目录下的 pre-commit 若会转发到仓库 .git/hooks，则无需额外配置。`);
    console.log('  若提交时没有触发门禁，请确认转发器存在，或执行 git config --local core.hooksPath .githooks');
  }
  console.log('  门禁只拦「基线之后新增」的阻断项；可用 git commit --no-verify 临时跳过（不推荐）。');
  return 0;
}

function help() {
  console.log(`dev-agent — 代码质量管理 + 开发习惯记录

用法：node scripts/dev-agent.mjs <command> [选项]

  check [--json] [--no-typecheck] [--quiet]   质量检查，输出报告到 .workbuddy/quality/reports/
  baseline                                    把当前结果登记为已知基线
  log --type=<类型> [--note="..."]            记录一条开发事件
     类型：${EVENT_TYPES.join(' / ')}
  digest [--days=7]                           生成习惯周报到 .workbuddy/habits/digests/
  guard [--hook] [--quiet]                    严格检查 + 自动记录，供 pre-commit 使用
  install-hooks                               安装 .git/hooks/pre-commit

推荐 npm 脚本：npm run agent:check | agent:baseline | agent:log | agent:digest | agent:guard | agent:hooks
规则配置：.workbuddy/quality/rules.json
`);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';
  switch (cmd) {
    case 'check': {
      const { result } = runCheck({ noTypecheck: Boolean(args['no-typecheck']) });
      saveCheck(result, { quiet: Boolean(args.json || args.quiet) });
      if (args.json) console.log(JSON.stringify(result, null, 2));
      // 记录检查事件，便于趋势分析（--json 模式也写，避免漏记）
      cmdLog(
        { type: 'check', source: 'cli', note: `质量分 ${result.score}，阻断 ${result.counts.error}`, quiet: args.json || args.quiet },
        {},
      );
      return args.strict && result.counts.error > 0 ? 1 : 0;
    }
    case 'baseline':
      return cmdBaseline();
    case 'log':
      return cmdLog(args);
    case 'digest':
      return cmdDigest(args);
    case 'guard':
      return cmdGuard(args);
    case 'install-hooks':
      return cmdInstallHooks();
    case 'help':
      help();
      return 0;
    default:
      console.error(`[dev-agent] 未知命令：${cmd}`);
      help();
      return 1;
  }
}

process.exitCode = main();
