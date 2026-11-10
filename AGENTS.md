# AGENTS.md · 本项目的 Agent 约定

任何在本仓库工作的 AI Agent / 编码助手，请先读这一份。

## 项目一句话
Cloudflare Workers（Hono）+ Workers AI + Vectorize + Hyperdrive(PostgreSQL) 的商品知识库与对话导购；`docs/*.json` 经 `scripts/ingest.mjs` 导入，前端在 `public/`，DDL 在 `sql/` 与 `schema.sql`。

## 开发治理 Agent
项目内置一个常驻治理 Agent：**dev-governor**，定义见 `.workbuddy/skills/dev-governor/SKILL.md`。
它负责代码质量管理与日常开发习惯记录，执行层是 `scripts/dev-agent.mjs`。

- 改动后 / 提交前：`npm run agent:check`，需要门禁时用 `npm run agent:guard`。
- 收工：`npm run agent:log -- --type=<类型> --note="..."`，事件写入 `.workbuddy/habits/events.jsonl`（append-only）。
- 复盘：`npm run agent:digest -- --days=7`。
- 规则级别与阈值：`.workbuddy/quality/rules.json`；基线 `.workbuddy/quality/baseline.json` 只拦「基线之后新增」的阻断项。

## 硬性约定
1. 不为了通过检查而关闭规则、加 `@ts-ignore`、改基线、改测试期望。
2. 改 `schema.sql` 或 `sql/*.sql` 时，同步 `src/schema.ts` 的迁移清单与 README；改模型/索引时同步 `src/config.ts` 与 `wrangler.jsonc`。
3. Workers 环境用 `c.env` 读取绑定与变量，不用 `process.env`；管理接口必须校验 `ADMIN_TOKEN`。
4. `.workbuddy/` 是项目数据不是缓存：只追加，不删除，不重写历史事件。
5. 部署、提交、推送等外部动作，必须由用户明确要求后才执行。
6. **文件树同步**：每次新增项目源文件（`src/`、`scripts/`、`sql/`、`public/` 下任何新文件），必须同步更新本文件下方的《项目文件树》描述，为新文件补充职能说明。
7. **前端路由**：必须走 `public/app.js` 中的 SPA path 路由系统（`VIEW_PATH` / `viewFromPath()` / `switchView()` / `applyPath()`），**禁止改回 hash 路由**或引入其他路由方案；新增视图必须在 `VIEW_PATH` 和 `switchView()` 中同步登记。
8. **刷新保持视图**：新增视图后必须手动在浏览器刷新 `/新路径` 验证 —— 页面必须回到正确面板、登录态保持、不闪登录页。详见下文《前端路由规范与踩坑记录》。
9. **SPA fallback**：wrangler.jsonc 的 `assets.not_found_handling: "single-page-application"` 是后端前提，**禁止删除**。
10. **TDZ 警告**：app.js 顶部的 `const VIEW_PATH` 必须在 `const state` 之前声明（`state.view` 初始化会调用 `viewFromPath()`），调整位置会触发 `ReferenceError: Cannot access 'VIEW_PATH' before initialization`。

## 常用命令
```bash
npm run typecheck        # tsc --noEmit
npm run dev              # wrangler dev
npm run agent:check      # 质量检查 + 报告
npm run agent:guard      # 提交门禁
npm run agent:digest     # 开发习惯周报
```

## 前端路由规范与踩坑记录

> 本节必须保留 —— 这是多次失败后积累的规则，后续改路由/加页面时务必逐条对照。

### 架构

本项目前端是 **单 HTML 文件（`public/index.html`）+ 原生 JS SPA path 路由**：

| 组件 | 文件 | 职责 |
|------|------|------|
| SPA fallback | `wrangler.jsonc` → `assets.not_found_handling: "single-page-application"` | 所有非 `/api/*` 路径返回 index.html |
| 路由表 | `app.js` → `const VIEW_PATH` | 视图名 → URL 路径映射；`product` 详情页由 `/product/<sku>` 正则单独处理 |
| 路径解析 | `viewFromPath()` / `skuFromPath()` | 从 `location.pathname` 反推视图名或 SKU |
| 面板切换 | `switchView(view)` | 设置 `state.view`、同步 `.nav-item.active`、控制 `main > .panel` 的 `hidden`、同步 URL |
| 路由恢复 | `applyPath()` | 启动 / popstate 时调用，从 pathname 恢复视图 |
| 后端入口 | `/api/auth/session` (GET) | 启动时 boot() 调此接口，决定显示登录还是主界面 |

### 当前路由表

```
/                → products  (不写 hash，URL 最干净)
/search          → search
/chat            → chat
/admin           → admin
/product/<SKU>   → product   (动态参数，由正则 /^\/product\/(.+)$/ 匹配)
```

### 踩坑记录（务必逐条遵守）

#### 坑 1：刷新 `/chat` 跳到商品列表（panel.hidden 从未被同步）

**根因**：`state.view` 在初始化时从 pathname 读对了，但它只是 JS 变量。真正决定面板显隐的是 `<section class="panel" hidden>` 的 DOM 属性。`switchView()` 才是设置 `panel.hidden` 的地方。

之前的代码：
```js
const view = viewFromPath();
if (view && view !== state.view) switchView(view);  // ← 守卫条件错了！
```

`state.view` 初始化已经是 `'chat'`，`viewFromPath()` 也返回 `'chat'`，守卫跳过 → `switchView` 从未被调用 → `panel.hidden` 保持 HTML 默认值（`view-products` 可见）。

**修复**：去掉 `!== state.view` 守卫。`switchView` 是幂等的，重复调用只是重复设置相同的 hidden 值：
```js
if (view) switchView(view);  // 无条件调用，保证 DOM 一定同步
```

#### 坑 2：TDZ —— `VIEW_HASH` 移到 `state` 之前才能访问

**根因**：ES6 `const` 在声明语句执行前处于 TDZ（暂时性死区），访问直接抛 `ReferenceError: Cannot access 'VIEW_HASH' before initialization`。

app.js 第 4 行 `const state = { view: viewFromPath() || 'products', ... }` 调用了 `viewFromPath()`，而它内部访问 `VIEW_HASH`/`VIEW_PATH`。如果这个常量写在 `state` 之后（之前就是第 188 行才声明），启动就崩。

**修复**：`VIEW_PATH` 必须写在文件最顶部、`state` 之前。已加注释标明：
```js
// 必须在 state 之前声明，因为 state.view 初始化时会调用 viewFromPath() 访问本常量。
const VIEW_PATH = { ... };
const state = { view: viewFromPath() || 'products', ... };
```

#### 坑 3：刷新先闪登录页再跳回主界面

**根因**：HTML 里 `#login-view` 默认可见（无 `hidden`），`#shell` 默认 hidden。boot() 里 `fetch('/api/auth/session')` 几百毫秒网络延迟期间，用户看到的是登录表单。

**修复**：三保险：
1. HTML 默认 **两个都 hidden**：`<div id="login-view" hidden>` + `<div id="shell" hidden>`
2. 新增 `#boot-loading` 占位（logo 呼吸动画 + "正在连接商品知识库…"），HTML 默认可见
3. `showLogin()` 和 `enterApp()` 里**先** `$('#boot-loading').hidden = true`，再显示正确视图

启动时序：
```
HTML 渲染 → boot-loading 可见（logo 呼吸）
boot() → /api/auth/session
  → 有用户: hide loading → hide login → show shell ✓
  → 无用户: hide loading → hide shell → show login ✓
```

#### 坑 4：hash 路由 → path 路由（已完成，禁止回退）

之前用 `#/chat` 这类 hash 路由。因 TDZ 和刷新体验问题改为 path 路由（`/chat`）。wrangler.jsonc 的 `not_found_handling: "single-page-application"` 是前提——**禁止改回 hash 或删除 fallback**。

关键变化点：
- `location.hash` → `location.pathname`
- `hashchange` 事件 → `popstate` 事件（浏览器前进/后退）
- `location.hash = target` → `history.pushState(null, '', target)`
- 路由常量名 `VIEW_HASH` → `VIEW_PATH`（值从 `'#/chat'` 变为 `'/chat'`）

### 新增视图 Checklist

每次加新页面（如 `/orders`、`/favorites` 等）必须按此清单执行：

- [ ] `public/index.html`：在 `<main>` 下加新 `<section id="view-xxx" class="panel" hidden>`，结构参考现有 panel
- [ ] `public/app.js` 顶部：`VIEW_PATH` 里加一项 `xxx: '/xxx'`
- [ ] `switchView()`：加 `if (view === 'xxx') loadXxx()` 等副作用
- [ ] `public/style.css`：新 panel 的样式（如果非通用）
- [ ] `wrangler.jsonc`：**不需要改**——fallback 已覆盖所有非 `/api/*` 路径
- [ ] **浏览器验证**：登录后访问 `/新路径`，刷新 → 必须保持在新页面、登录态保持、**无登录闪屏**
- [ ] `AGENTS.md` 文件树：同步更新

## 项目文件树

> 新增源文件时必须同步更新本节。不列出 `.git/`、`.workbuddy/`、`node_modules/` 等自动生成目录。

```
ai/
├── AGENTS.md                     ← 本文件；所有 Agent 必须先读
├── README.md                     ← 项目文档与接口说明
├── LICENSE                       ← Apache 2.0
├── package.json / package-lock.json
├── tsconfig.json                 ← TypeScript 配置（strict 模式）
├── wrangler.jsonc                ← Cloudflare Workers 部署配置 + 绑定（VECTORIZE / AI_SEARCH / HYPERDRIVE / AI）
├── .dev.vars.example             ← 本地 dev 环境变量模板（复制为 .dev.vars 使用）
├── .githooks/pre-commit          ← Git pre-commit 钩子（由 dev-governor 生成）
│
├── src/                          ← Workers 源码（Hono 应用入口在 index.ts）
│   ├── index.ts                  ← Hono app 组装 + 路由挂载 + Workers fetch 入口
│   ├── config.ts                 ← 集中常量：模型 ID、embedding 维度、默认 topK、Vectorize namespace、AI Search 配置
│   ├── types.ts                  ← 全局类型：Env 绑定、Product、KnowledgeDoc、ChatMessage、VectorizeMatch、AI Search 类型
│   ├── auth.ts                   ← 简易令牌鉴权：currentUser() / requireAuth() / 密码 PBKDF2 校验
│   ├── db.ts                     ← PostgreSQL 数据层：连接池、CRUD、关键词搜索、迁移、同步状态表
│   ├── embeddings.ts             ← Workers AI 向量化：embedTexts()、SKU/KB Vectorize upsert 与查询
│   ├── intent.ts                 ← 对话意图识别：规则层（敏感词/寒暄/商品信号/追问）+ AI 层 + 兜底
│   ├── knowledge.ts              ← 知识库文档构建：从商品库聚合类目/供应商/价格带/选购指南
│   ├── normalize.ts              ← 商品数据规范化：中文键 → camelCase、日期/价格/布尔值解析、字段裁剪
│   ├── ai-search.ts              ← Cloudflare AI Search 客户端（知识库专属）：实例管理、批量同步、queryAiSearch()
│   ├── ai-search-store.ts        ← AI Search 同步状态表：查询待同步文档、记录同步哈希与时间
│   ├── schema.ts                 ← 迁移清单：读取 sql/*.sql → 按序执行 → SCHEMA_STATEMENTS / SCHEMA_SQL 导出
│   ├── sql-split.ts              ← 纯 SQL 分割器：按分号切 + 处理字符串/注释中的假分号
│   ├── sql.d.ts                  ← Wrangler Text 绑定的类型声明（.sql 文件作为字符串导入）
│   │
│   └── routes/                   ← Hono 路由模块（每个文件一个路由组）
│       ├── chat.ts               ← 对话导购：意图识别 → SKU(Vectorize)+KB(AI Search) 并行召回 → LLM 生成
│       ├── search.ts             ← 商品搜索：Vectorize hybrid（关键词+语义 RRF 融合），前端检索页接口
│       ├── products.ts           ← 商品 CRUD：列表/详情/更新/上架下架
│       ├── auth.ts               ← 登录/注册/会话探测
│       ├── notifications.ts      ← 站内信：列表/未读计数/标记已读/全部已读/删除；管理员广播在 admin.ts
│       └── admin.ts              ← 管理接口：DDL 查询、迁移、商品/知识库批量 upsert、知识库构建、AI Search 状态、站内信广播
│
├── scripts/                      ← 运维与开发辅助脚本（Node.js / PowerShell）
│   ├── ingest.mjs                ← 商品数据导入：读取 docs/*.json → normalize → upsert PG → upsert Vectorize
│   ├── sync-ai-search.mjs        ← AI Search 同步入口：逐 kind（sku/kb）分页上传，跳过未变化文档
│   ├── check-sql.mjs             ← SQL 迁移校验：检查 sql/*.sql 顺序是否与 src/schema.ts 一致
│   ├── dev-agent.mjs             ← 开发治理 Agent：质量检查、习惯记录、门禁、hooks 生成（dev-governor 执行层）
│   ├── test-intent.mjs           ← 意图识别规则层单元测试（Node 原生，不依赖 Workers）
│   ├── test-frontend.mjs         ← 前端逻辑测试：卡片渲染、事件委托、历史会话回放
│   ├── deploy-cloudflare.ps1/cmd ← Windows 一键部署到 Cloudflare Workers
│   └── init-cloudflare.ps1/cmd   ← Windows 首次初始化：创建 Vectorize 索引、AI Search 实例、PG 表
│
├── sql/                          ← PostgreSQL 迁移（按文件名序号执行）
│   ├── 001_init.sql              ← 建表：users、products、knowledge_docs、sessions、messages、ai_search_sync
│   ├── 002_ai_search_sync.sql    ← ai_search_sync 表补全：hash 列、索引
│   ├── 003_notifications.sql     ← 站内信：notifications 表 + 未读索引
│   └── README.md                 ← 迁移规范说明
│
├── docs/
│   └── SKU_collation.json        ← 商品原始数据（中文键），scripts/ingest.mjs 的输入
│
├── public/                       ← 前端静态资源（由 wrangler 直接托管）
│   ├── index.html                ← SPA 入口：登录页 / 检索页 / 聊天页 / 商品详情页 四个视图
│   ├── app.js                    ← 全部前端逻辑：视图切换、API 调用、卡片渲染、会话管理、站内信抽屉
│   ├── style.css                 ← 样式
│   └── favicon.svg               ← 浏览器标签页图标（云字徽标）
│
└── .workbuddy/                   ← 开发治理数据（只追加，不属于源码）
    ├── skills/dev-governor/      ← 治理 Agent 定义
    ├── habits/events.jsonl       ← 开发事件 append-only 日志
    ├── habits/digests/           ← 周期性复盘报告
    ├── memory/                   ← 会话级上下文留存
    ├── quality/rules.json        ← 质量规则与阈值
    ├── quality/baseline.json     ← 基线（只拦基线之后新增的阻断项）
    └── quality/reports/          ← 每次检查的报告快照
```
