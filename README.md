# 云铺 · Cloudflare 商品知识库与智能导购

基于 **Cloudflare Workers + Workers AI + Vectorize + Hyperdrive(PostgreSQL)** 的全栈项目：把 `docs/` 下的商品 JSON 导入向量库与关系库，提供登录、商品列表、混合检索、商品知识库与意图识别驱动的对话推荐。前端是零构建的静态页面，随 Worker 一起部署。检索支持 **Cloudflare AI Search（当前默认）与 Vectorize（可回退）双引擎**，见第八节。

```
docs/*.json ── scripts/ingest.mjs ──▶ POST /api/admin/ingest ──┬─▶ PostgreSQL (Hyperdrive)
                                                              └─▶ Workers AI bge-m3 ─▶ Vectorize [namespace: sku]
PostgreSQL 聚合 ──▶ /api/admin/build-knowledge ──▶ Workers AI ─▶ Vectorize [namespace: kb]
浏览器 ──▶ /api/auth | /api/products | /api/search | /api/chat ──▶ Worker (Hono)
                                          │
                                          └─▶ Vectorize 召回 + PG 回表 + Workers AI 生成回答
```

## 目录

| 路径 | 作用 |
| --- | --- |
| `src/index.ts` | Worker 入口、路由挂载、静态资源兜底 |
| `src/routes/*.ts` | 登录 / 商品 / 检索 / 对话 / 管理接口 |
| `src/normalize.ts` | 中文原始字段规范化、向量化文本构造（`类目`加权）、内容 hash |
| `src/db.ts` | PostgreSQL 访问层、批量 upsert、聚合、会话存储 |
| `sql/*.sql` | **DDL 唯一权威源**：按 `NNN_*.sql` 编号的迁移文件，约定见 `sql/README.md` |
| `src/schema.ts` | 迁移登记 + SQL 拆句；通过 Wrangler `Text` 模块直接导入 `sql/*.sql`，无第二份副本 |
| `scripts/check-sql.mjs` | 校验新增 SQL 是否已登记（挂在 `typecheck` / `deploy` 前置钩子） |
| `src/embeddings.ts` | Workers AI 向量化、Vectorize upsert / query |
| `src/ai-search.ts` | AI Search 客户端：实例创建、文档同步、混合检索与降级判定 |
| `src/ai-search-store.ts` | PG 商品/知识文档渲染为 AI Search 文档 + 同步状态读写 |
| `src/intent.ts` | 对话意图识别：确定性规则 → Workers AI 分类 → 兜底，决定是否需要商品推荐 |
| `src/knowledge.ts` | 类目 / 供应商 / 价格带 / 选购指南知识文档生成 |
| `scripts/ingest.mjs` | 本地导入脚本：读 JSON、分批推送、断点、重试、构建知识库 |
| `scripts/sync-ai-search.mjs` | AI Search 文档同步脚本：分页、增量、断点、dry-run |
| `scripts/test-intent.mjs` / `test-frontend.mjs` | 意图规则与降级路径测试 / 前端渲染 DOM 桩测试（`npm test`） |
| `scripts/init-cloudflare.cmd`、`scripts/init-cloudflare.ps1`、`scripts/deploy-cloudflare.cmd`、`scripts/deploy-cloudflare.ps1` | Windows 一键初始化云资源 / 一键部署（`.cmd` 入口 + `.ps1` 实现） |
| `public/` | 登录、商品列表（每页 18 条）、商品详情、检索、对话、运维控制台 |

## 零、Windows 一键脚本（推荐）

`.cmd` 是入口（自动加 `-ExecutionPolicy Bypass`，不用改系统执行策略），`.ps1` 是实现，需要 Windows PowerShell 5.1+。它们把下面第 1~5 节的手动命令封装成**幂等流程**，重复运行不会重复创建资源。

**前置**：Node.js 20+、`npm install`、`npx wrangler login`、一个可被 Cloudflare 访问的 PostgreSQL、且 `hesen.dpdns.org` zone 在 Cloudflare 为 Active（见第 4 节）。

```powershell
# ① 初始化云资源（只跑一次即可；-WhatIf 先演练，不联网、不写文件）
.\scripts\init-cloudflare.cmd -WhatIf
.\scripts\init-cloudflare.cmd -DatabaseUrl "postgres://USER:PASS@HOST:5432/DBNAME?sslmode=require"

# ② 一键部署：前置检查 → typecheck + SQL 登记校验 → deploy → 健康检查
.\scripts\deploy-cloudflare.cmd

# ③ 首次上线再加数据（DDL + 5985 条 SKU 向量化 + 知识库，消耗 Workers AI neurons 配额）
.\scripts\deploy-cloudflare.cmd -WithIngest
```

初始化脚本会：创建 `product-catalog` 索引（1024 / cosine）与 5 个 metadata 索引；创建 Hyperdrive 并**自动把 ID 回填到 `wrangler.jsonc`**；用 `wrangler secret bulk` 一次上传 4 个 secrets。secrets 优先读 `.dev.vars`（含你手动改过的值），缺失项才随机生成并追加回 `.dev.vars`，以保证 `ADMIN_TOKEN` 和导入脚本始终一致；临时 JSON 用完即删，且放在已被忽略的 `.wrangler/` 下。

| 参数 | 脚本 | 说明 |
| --- | --- | --- |
| `-DatabaseUrl` | init | PostgreSQL 连接串，创建 Hyperdrive 并回填 ID |
| `-HyperdriveId` | init | 已有 Hyperdrive 配置：直接回填，不新建 |
| `-JwtSecret` `-AdminToken` `-AdminEmail` `-AdminPassword` | init | 覆盖 `.dev.vars` 中的对应值 |
| `-ForceSecrets` | init | 覆盖已存在的 secrets（默认跳过） |
| `-SkipVectorize` `-SkipHyperdrive` `-SkipSecrets` | init | 分段执行 |
| `-WhatIf` | 两者 | 只打印将执行的命令，不联网不写文件 |
| `-WithIngest` | deploy | 部署后执行迁移 + 全量导入 + 知识库（消耗 neurons 配额） |
| `-ApiBase` | deploy | 健康检查 / 导入地址，默认 `https://ai.hesen.dpdns.org` |
| `-SkipHealthCheck` | deploy | 跳过健康检查 |

> 脚本内容全为 ASCII：Windows PowerShell 5.1 读取无 BOM 的 `.ps1` 时按 ANSI 解码，中文会乱码。说明文字放在本文档。
> 连接串里的密码若含 `&`、`@`、空格等特殊字符，请先 URL 编码并用双引号包裹；`-WhatIf` 可先确认命令文本。
> 证书签发期间健康检查可能失败，脚本会重试 3 次并提示改用 `workers.dev` 备用入口。

以下几个小节是脚本的等价手动步骤，便于排查或改造。

## 一、前置准备

Node.js ≥ 20（本项目在 Node 22 验证）、npm、Cloudflare 账号、一个可被 Cloudflare 访问的 PostgreSQL 数据库。

```bash
npm install
npx wrangler login
```

### 1. 创建 Vectorize 索引（维度锁定 1024 / cosine）

`@cf/baai/bge-m3` 输出 **1024 维**、支持中文，索引维度和距离度量创建后不可改。切换 embedding 模型必须新建索引并全量重建。

```bash
npx wrangler vectorize create product-catalog --dimensions=1024 --metric=cosine

# metadata 索引必须在写入向量之前创建，否则 filter 不生效（且已写入的向量需重新 upsert）
npx wrangler vectorize create-metadata-index product-catalog --propertyName=kind --type=string
npx wrangler vectorize create-metadata-index product-catalog --propertyName=status --type=string
npx wrangler vectorize create-metadata-index product-catalog --propertyName=category --type=string
npx wrangler vectorize create-metadata-index product-catalog --propertyName=tenant --type=string
npx wrangler vectorize create-metadata-index product-catalog --propertyName=price --type=number
npx wrangler vectorize list-metadata-index product-catalog
```

### 2. 创建 Hyperdrive（数据库连接串由你后续提供）

```bash
npx wrangler hyperdrive create product-pg \
  --connection-string="postgres://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require"
```

把输出里的 **Hyperdrive ID** 填进 `wrangler.jsonc` 的 `hyperdrive[0].id`（替换 `REPLACE_WITH_YOUR_HYPERDRIVE_ID`）。数据库账号需要有建表权限；DDL 见 `sql/001_init.sql`。

> 也可以直接用 `psql "$DATABASE_URL" -f sql/001_init.sql` 建表，之后跳过 `/api/admin/migrate` 的建表部分（迁移接口仍是幂等的 `CREATE TABLE IF NOT EXISTS`）。
>
> 后续表结构变更请在 `sql/` 新增编号迁移文件并登记，见 `sql/README.md`；`npm run sql:check` 会检查是否漏登记。

### 3. 配置密钥

本地开发：项目已提供 `.dev.vars` 初版（含随机本地密钥，按文件内注释修改即可；也可从 `.dev.vars.example` 重新复制）。该文件已被 `.gitignore` 忽略，Windows 一键脚本会直接读取它作为生产 secrets 来源。生产（手动方式）：

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put ADMIN_EMAIL
npx wrangler secret put ADMIN_PASSWORD
```

- `JWT_SECRET`：会话签名密钥，≥32 位随机串
- `ADMIN_TOKEN`：管理接口与导入脚本的令牌
- `ADMIN_EMAIL` / `ADMIN_PASSWORD`：执行迁移时写入的管理员账号（密码 ≥8 位）

### 4. 自定义域名 `ai.hesen.dpdns.org`

`wrangler.jsonc` 已配置好，无需改代码：

```jsonc
"routes": [{ "pattern": "ai.hesen.dpdns.org", "custom_domain": true }],
"workers_dev": true,
```

**前置条件（没做完，`deploy` 会找不到 zone 直接失败）**：`dpdns.org` 是 DigitalPlat 免费域名，Cloudflare 的 Custom Domain 只认托管在自己账号里的 Active zone。

1. Cloudflare「添加站点」填**完整子域** `hesen.dpdns.org`（不是父域 `dpdns.org`），选 Free 计划。
2. 到 DigitalPlat 后台把该域名的 Nameserver 改为 Cloudflare 分配的两个 NS，其余 NS 清空。
3. 等 zone 状态变为 **Active**（DNS 传播几分钟到数小时）。
4. **不要**手动给 `ai` 建 CNAME/A 记录：Custom Domain 会由 Cloudflare 自动创建 DNS 记录并签发证书，已存在的冲突记录会导致绑定失败。

`npm run deploy` 后 Cloudflare 自动建记录 + 签发 Advanced Certificate，证书就绪即可访问 `https://ai.hesen.dpdns.org`。

> 配了 `routes` 之后 `workers.dev` 默认是关闭的，这里显式设 `workers_dev: true` 保留 `https://product-ai.<子域>.workers.dev` 作为备用入口（证书签发期间也能验证）。只想保留正式域名就改成 `false`。Custom Domain 不支持通配符，需要第二个主机名时再往 `routes` 加一条。

### 5. 部署

```bash
npm run typecheck
npm run deploy
```

这次部署会同时把 Worker 挂到自定义域名上。本地调试用 `npm run dev`。注意 **Workers AI 绑定始终走云端并消耗 neurons 配额**，`wrangler dev` 也不例外；Vectorize、Hyperdrive 同样需要真实资源。

## 二、初始化数据

```bash
# .dev.vars 里配好 ADMIN_TOKEN / API_BASE，或直接用环境变量
ADMIN_TOKEN=xxx API_BASE=https://ai.hesen.dpdns.org npm run ingest:migrate
```

自定义域名证书还没签发好时，先把 `API_BASE` 换成 `https://product-ai.<子域>.workers.dev` 也可以。

`npm run ingest:migrate` = 执行 DDL + 导入全部 `docs/*.json` + 构建知识库。拆开执行：

```bash
npm run ingest -- --migrate          # 迁移 + 导入 + 知识库
npm run ingest                       # 只导入 + 知识库
npm run ingest:knowledge             # 只重建知识库
npm run ingest -- --start=2000 --limit=500   # 断点续传 / 小批量验证
npm run ingest -- --force            # 忽略内容 hash，强制重新向量化
npm run ingest -- --dry-run          # 只看数据量，不写任何东西
```

脚本会读取 `docs/` 下所有 `.json`（也可用 `--file=docs/SKU_collation.json` 指定），按 40 条一批推送；每批在 Worker 内完成 **规范化 → PG upsert → Workers AI 向量化 → Vectorize upsert**，失败自动重试 3 次。

幂等靠 `content_hash + synced_at`：内容未变且已同步的记录会跳过；中断后重跑同一命令即可，不会重复消耗 embedding 额度。Vectorize 写入是**最终一致**的，导入完成后等几秒再做检索验证。

知识库按 `类目 / 供应商 / 价格带 / 选购指南` 从 PG 实时聚合生成，约 500 条文档，分页构建（每批 120 条）以避免单次 Worker 请求里串行太多 AI 调用。

### 额度与费用（2026-11 核实）

| 资源 | 免费额度 | 本项目实测 |
| --- | --- | --- |
| Workers AI | 10,000 neurons / 天（00:00 UTC 重置） | 全量导入约 2,200 neurons，≈22% |
| `@cf/baai/bge-m3` embedding | 1,075 neurons / 百万输入 token | 5985 条共 118 万字符 ≈ 177 万 token ≈ 1,905 neurons |
| Vectorize | 30M queried dims / 月、5M stored dims（Free） | 6448 条 × 1024 维 ≈ 6.6M stored dims |
| Workers 请求 / Hyperdrive 查询 | 各 100,000 / 天 | 150 批导入，远低于上限 |

- **免费计划超额只会让请求失败，不会产生账单**。需超量才升级 Workers Paid（$5/月起，超出每日 10,000 neurons 后按 `$0.011 / 1,000 neurons` 计）。
- 本项目 6448 条向量已全部写入成功；若账号为 Workers Free，5M stored dimensions 可能在约 4880 条处拦截写入，届时需确认套餐。
- 真正的 neurons 大户是**对话生成**：`@cf/meta/llama-3.3-70b-instruct-fp8-fast` 输出 204,805 neurons / 百万 token，约为 embedding 单价的 190 倍。对话量大时可在 `src/config.ts` 换用小模型（如 `@cf/meta/llama-3.2-1b-instruct`，18,252 neurons / 百万输出 token）。
- 模型目录会调整，价格与「需绑定付费方式」的模型清单以 [Workers AI Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) 为准。

## 三、API

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | 公开 | 绑定状态、模型与索引配置 |
| POST | `/api/auth/register` `/login` `/logout` | 公开 | 注册 / 登录 / 退出（HttpOnly Cookie + HMAC-SHA256 JWT） |
| GET | `/api/auth/session` `/me` | 公开 / 登录 | 当前用户 |
| GET | `/api/products` | 登录 | 分页、关键词、类目、供应商、状态、价格、排序、仅推荐 |
| GET | `/api/products/facets` | 登录 | 类目 / 供应商 / 状态 / 统计 |
| GET | `/api/products/:skuCode` | 登录 | 单品详情 |
| POST | `/api/search` | 登录 | `{query, mode: hybrid\|semantic\|keyword, engine?, topK, category, tenant}` |
| POST | `/api/chat` | 登录 | `{sessionId?, message, topK?, engine?}` → 意图识别 + 按需召回；回答 + 带编号的商品卡片 + `intent` / `shouldRecommend` / `engine` |
| GET/DELETE | `/api/chat/sessions[/:id]` | 登录 | 会话列表 / 消息 / 删除 |
| GET | `/api/admin/status` `/schema` | ADMIN_TOKEN | 状态 / 完整 DDL |
| POST | `/api/admin/migrate` | ADMIN_TOKEN | 建表 + 写入管理员账号 |
| POST | `/api/admin/ingest` | ADMIN_TOKEN | 商品批次导入（脚本使用） |
| POST | `/api/admin/build-knowledge` | ADMIN_TOKEN | 分页构建知识库 |
| GET | `/api/admin/ai-search/status` | ADMIN_TOKEN | AI Search 实例配置、索引进度、同步计数 |
| POST | `/api/admin/ai-search/sync` | ADMIN_TOKEN | `{kind: kb\|sku, offset, limit, force}` 分页上传文档 |

`engine` 可选 `ai_search`（当前服务端默认，`wrangler.jsonc` 的 `SEARCH_ENGINE`）或 `vectorize`；未显式传参时取该默认值。AI Search 分支返回的 `engine` 字段为 `ai_search`，失败自动降级时为 `vectorize (degraded)`。

检索的 `hybrid` 模式用 **RRF（1/(60+rank)）** 融合关键词与语义结果，避免两类分数不可比；`semantic` 走 Vectorize metadata 过滤（默认只返回「已上架」）。

**对话意图识别（按需推荐）**：`src/intent.ts` 在 `/api/chat` 最前面插入一层分类，由 `shouldRecommend` 决定是否检索商品库。

| 意图 | 是否推荐 | 典型输入 |
| --- | --- | --- |
| `recommend` | ✅ | 推荐一台香肠去皮机、预算两万、帮我找台设备 |
| `product_query` | ✅ | 香肠去皮机多少钱、起订量是多少 |
| `follow_up` | ✅ | 那第二台呢、便宜点的（存在历史会话时） |
| `general` | ❌ | 你好、谢谢、你能做什么 |
| `support` | ❌ | 怎么开发票、忘记密码、找客服 |
| `unclear` | ❌ | 输入过短，主动追问类目 / 预算 / 规格 |

判定链是**确定性规则 → Workers AI 轻量分类 → 兜底**：规则覆盖寒暄、能力询问、平台服务问题、明确找货与多轮指代，命中即返回（零额外延迟、零 neurons）；只有规则不敢下结论的模糊句才多花一次 `AI.run`（`max_tokens: 90`，默认复用 `CHAT_MODEL`，可在 `wrangler.jsonc` 的 `vars` 用 `INTENT_MODEL` 单独换成小模型）。Workers AI 对 JSON 输出既可能返回已解析对象、也可能返回带 Markdown 包裹的字符串，`classifyWithAi` 会逐个候选解析；非法 JSON、未知意图、模型异常一律安全降级——含商品信号仍按推荐处理，无商品信号的模糊句改为追问需求，不再强推商品卡片。

只有 `shouldRecommend = true` 才执行检索（默认走 AI Search，失败自动回退 Vectorize 的 embedding + 双 namespace 召回）和 PG 商品查询，并注入导购版系统提示；否则直接用通用对话提示回答（被约束为不编造商品、不承诺处理订单售后），`products` / `knowledge` 返回空数组、`engine` 为 `null`。响应新增 `intent` / `intentLabel` / `intentSource` / `intentReason` / `shouldRecommend`，前端在助手消息上显示「意图识别：xxx · 已检索商品库 / 无需商品推荐」。意图结果未持久化，历史会话回放不显示标签（商品缩略图仍会渲染）。回归测试用 `npm test`。

**前端交互约定**：

- 商品列表固定每页 18 条，由 `src/config.ts` 的 `DEFAULT_PAGE_SIZE` 统一约束（API 默认值与 DB 兜底共用）。
- 点击商品卡片进入 `#/product/<SKU>` 详情页：hash 路由可直接分享、刷新与浏览器前进/后退；展示主图与图库、完整参数、规格简介、阶梯价、物流配送、视频链接，并提供「向 AI 咨询 / 找同类商品 / 复制 SKU」以及同类目已上架商品的相关推荐。
- 对话回复里的商品卡片**只展示前 3 条**（后端仍返回最多 6 条引用），每张卡片均可点击或回车跳转详情，超出部分给出文字提示；**卡片带商品缩略图**（SKU 图 → SPU 封面 → 轮播图首张，只接受 http(s) 或站内路径，含引号 / `javascript:` 的 URL 直接丢弃，加载失败显示占位符），历史会话回放同样显示。

## 四、数据现状与处理策略

`docs/SKU_collation.json` 实测：**5985 条 SKU / 4853 个 SPU / 247 个类目 / 244 家供应商**，价格 0 ~ 105865 元，状态含「已上架 5441 / 已下架 543 / 回收站 1」。

- 「商品名称」有大量与商品无关的短句（例如「21世纪开启了一个前所未有的互联互通时代。」），「销售规格」「分类名称」「供应商」才是有效语义来源。因此 `buildEmbedText()` 把**类目放在开头并重复一次**来提权，名称降权，规格、供应商、价格、物流参数跟进；文本裁剪到 360 字以适配 bge-m3 的 512 token 上限。
- 「重量kg」「体积m3」「商品简介」100% 为 null，「SPU轮播图」「阶梯价格JSON」「物流信息JSON」是**字符串里套 JSON**，已在 `normalize.ts` 统一解析为 JSONB。
- 检索与推荐默认过滤 `status = '已上架'`，推荐上下文同时注入 SKU 召回结果和知识库条目，LLM 被约束为只能引用编号 `[1][2]`，不得编造商品；生成失败时降级为检索结果直接作答。只有命中商品类意图才检索，寒暄 / 服务类问题不消耗 embedding 与 Vectorize 查询额度。
- 对话历史、会话、推荐商品编号都持久化在 PostgreSQL。

## 五、需要你后续提供 / 确认

1. PostgreSQL 连接串：传给 `init-cloudflare.cmd -DatabaseUrl` 即可，脚本会创建 Hyperdrive 并自动回填 `wrangler.jsonc` 的 `hyperdrive[0].id`；也可手动执行第 2 节命令后自行填写。
2. 自定义域名已定为 `ai.hesen.dpdns.org`：请确认 `hesen.dpdns.org` zone 在 Cloudflare 已是 Active、NS 已切到 Cloudflare；另外确认是否给管理接口再加一层 Cloudflare Access 保护（当前仅 ADMIN_TOKEN）。
3. 是否改用外部 LLM / AI Gateway：模型 ID 集中在 `src/config.ts` 与 `wrangler.jsonc` 的 `vars`，改 `CHAT_MODEL` 即可；embedding 模型若更换，必须新建对应维度的 Vectorize 索引并 `--force` 全量重建。
4. 源数据更新频率：目前是手动导入，若要定时同步可加 Cron Triggers 或在 CI 里跑 `npm run ingest`。

## 六、上线前自检

```bash
curl https://ai.hesen.dpdns.org/api/health
curl -H "X-Admin-Token: $ADMIN_TOKEN" https://ai.hesen.dpdns.org/api/admin/status
```

`status` 里的 `unsynced_products` / `unsynced_knowledge` 应为 0，`database.stats.total` 应接近 5985。前端「运维」页也能直接看这些指标。

## 七、开发治理 Agent（代码质量 + 开发习惯）

项目内置了一个常驻的 **dev-governor** Agent：`.workbuddy/skills/dev-governor/SKILL.md` 是它的职责定义（WorkBuddy 项目级 Skill），`AGENTS.md` 是给各类编码 Agent 看的通用约定，执行层是 `scripts/dev-agent.mjs`（Node ≥ 20、零新增依赖、纯本地、不联网）。

它干两件事：

1. **代码质量管理**：`tsc --noEmit` + 项目特有的一致性校验（DDL 双份同步、模型/索引配置、绑定声明、路由挂载、批量常量、README 引用路径）+ 静态卫生扫描（硬编码凭据、`process.env`、显式 `any`、调试输出、超大文件/提交、前端 `innerHTML` 等），产出质量分与 Markdown 报告，并通过基线门禁拦截**新增**的阻断项。
2. **日常开发习惯记录**：append-only 事件流自动采集时间、分支、工作区增删行与最近质量分，按周汇总活跃度、时段分布、质量分趋势并给出可执行建议。

### 命令

| 命令 | 作用 |
| --- | --- |
| `npm run agent:check` | 质量检查，报告写入 `.workbuddy/quality/reports/` |
| `npm run agent:guard` | 严格门禁（拦新增阻断项）+ 自动记录 |
| `npm run agent:baseline` | 把当前问题登记为已知基线（确认接受现存债务后再用） |
| `npm run agent:log -- --type=refactor --note="..."` | 追加一条开发事件 |
| `npm run agent:digest -- --days=7` | 生成习惯周报到 `.workbuddy/habits/digests/` |
| `npm run agent:hooks` | 安装 `.githooks/pre-commit` 到 `.git/hooks/pre-commit` |
| `node scripts/dev-agent.mjs check --json` | 机器可读结果，供脚本/其他 Agent 消费 |

事件类型：`check` / `commit` / `review` / `refactor` / `bugfix` / `test` / `docs` / `chore` / `learning` / `session`。`check` 与 pre-commit 的 `commit` 自动记录，其余在收工时手动补一条。

### 规则与基线

`.workbuddy/quality/rules.json` 可调整每条规则的级别（`error` / `warn` / `info` / `off`）、行数阈值和扫描排除项。`error` 会被 `guard` 拦截，但**只拦基线之后新增的**：首次接入先跑 `npm run agent:baseline` 登记现存问题，避免一装门禁就提交不了；旧账修完后重跑 baseline 收紧口径。最新结果在 `.workbuddy/quality/latest.json`，事件流在 `.workbuddy/habits/events.jsonl`（只追加，不覆盖）。

> 全局 `core.hooksPath` 已配置为 `C:/Users/Admin/.git-hooks`，其 `pre-commit` 会转发到仓库自己的 `.git/hooks/pre-commit`，所以 `npm run agent:hooks` 直接写仓库 hook 即可生效；若转发器变更，可执行 `git config --local core.hooksPath .githooks`。

习惯数据与报告属于本地个人记录，已在 `.gitignore` 中忽略；`AGENTS.md`、`.workbuddy/quality/rules.json`、`.workbuddy/quality/baseline.json`、`.workbuddy/skills/` 与 `.githooks/pre-commit` 随仓库提交，保证换机器后规则与 Agent 定义可复现。

## 八、AI Search 接入（当前默认引擎）

Cloudflare AI Search（原 AutoRAG）是托管检索服务：自动切分、embedding、BM25 + 向量混合召回、重排与相似查询缓存。本项目已把 `SEARCH_ENGINE` 切到 `ai_search` 作为默认检索引擎；结构化查询仍由 PostgreSQL + Hyperdrive 承担，Vectorize 链路完整保留作为回退。

| 继续自建 / 保留 | 交给 AI Search |
| --- | --- |
| PostgreSQL + Hyperdrive：登录、商品列表、筛选、facets、排序、会话、回表 | 文档切分、embedding、混合检索、reranking、缓存 |
| Workers AI `llama-3.3-70b` 生成回答 | 索引与同步状态托管（embedding 不再计入 Workers AI neurons） |
| Vectorize 索引与 `scripts/ingest.mjs`（回退引擎，随时可切回） | 知识库文档与商品文档的检索召回 |

### 代码落点

| 文件 | 作用 |
| --- | --- |
| `wrangler.jsonc` | `ai_search_namespaces` 绑定 + `AI_SEARCH_INSTANCE` / `SEARCH_ENGINE` |
| `src/types.ts` | AI Search 绑定的最小类型定义与 `Env` 声明 |
| `src/config.ts` | 实例名、批量、5 个 metadata 字段、引擎枚举 |
| `src/ai-search-store.ts` | PG 文档渲染 + `ai_search_sync` 增量状态 |
| `src/ai-search.ts` | 实例幂等创建、分页上传、`search()` 召回与 chunk 归类 |
| `src/routes/search.ts` `src/routes/chat.ts` | `engine` 分支、回表组装、失败降级 |
| `src/routes/admin.ts` | 同步与状态接口（沿用 `requireAdmin`） |
| `sql/002_ai_search_sync.sql` | 同步状态表 DDL，已登记到 `src/schema.ts` |
| `scripts/sync-ai-search.mjs` | 本地同步脚本，`npm run sync:ai-search` |

### 前置条件

- Wrangler ≥ 4.68.1、`compatibility_date` ≥ 2026-03-27、`@cloudflare/workers-types` ≥ 4.20260304.0；本项目当前 4.158.0 / 2026-11-09 / 5.20261109.1 均满足。
- `wrangler.jsonc` 已配置 `ai_search_namespaces`（namespace `default` 由平台自动创建），实例 `product-catalog-search` 在**首次同步时自动创建**，无需手工建 R2 桶。
- 若账号**从未创建过 AI Search 实例**，平台要求先注册 service API token：Worker 内自动创建会报 `AiSearchInternalError`，`wrangler ai-search create` 会报 `No AI Search API token found`。两种解法：① 在 Dashboard 的 `AI Search → Tokens` 注册 token 后用 CLI 创建；② 直接用账号凭据调 REST API `POST /accounts/{account_id}/ai-search/namespaces/default/instances`，body 为 `{"id":"product-catalog-search"}`（本次采用，无需 service token）。之后同步脚本会复用该实例并自动补齐 5 个 metadata 字段。
- 本地调试用 `npx wrangler dev --remote`：AI Search 不在本地模拟，和 Workers AI 一样走云端。

### 首次上线步骤（部署与同步属于外部动作，需明确要求后再执行）

```bash
# 1. 建同步状态表（DDL 幂等，重放安全）
curl -X POST -H "X-Admin-Token: $ADMIN_TOKEN" $API_BASE/api/admin/migrate

# 2. 先同步约 500 条知识文档（推荐第一步）
ADMIN_TOKEN=xxx API_BASE=https://ai.hesen.dpdns.org npm run sync:ai-search -- --kind=kb

# 3. 小批量验证商品文档，确认召回与费用
npm run sync:ai-search -- --kind=sku --limit=200

# 4. 全量同步（约 5985 条 SKU + 500 条知识文档）
npm run sync:ai-search

# 5. 查看索引进度 / 同步计数
curl -H "X-Admin-Token: $ADMIN_TOKEN" $API_BASE/api/admin/ai-search/status
```

上传是**异步索引**，同步返回成功不等于立即可检索，等几分钟再验证。脚本参数：`--kind=kb|sku|all`、`--batch=40`、`--start`、`--limit`、`--force`（忽略 hash 强制重传）、`--dry-run`。中断后直接重跑即可，已同步且内容未变的文档会跳过。

### 灰度与回退

- 前端「商品检索」页的「检索引擎」开关即时生效，检索与对话共用这个选择；服务端默认值已在 `wrangler.jsonc` 的 `SEARCH_ENGINE` 设为 `ai_search`，前端开关可临时切回 Vectorize。
- `GET /api/health` 返回 `bindings.aiSearch` 与 `search.engine`；`GET /api/admin/ai-search/status` 对应「运维」页的「AI Search 状态」按钮。
- AI Search 抛错时 `src/routes/search.ts` 与 `src/routes/chat.ts` 自动回退到 Vectorize，响应 `engine` 标为 `vectorize (degraded)`，不影响线上可用性。
- 回退只需把 `SEARCH_ENGINE` 改回 `vectorize` 并重新部署（前端开关可即时切回做验证），**不需要删代码或删索引**。

### 实现约束

- 自定义 metadata 上限 **5 个字段**，本项目用 `kind / category / tenant / status / price`，已用满；sku 编码不占字段，而是编码在 item key（`sku/<urlencoded>.md`、`kb/<urlencoded>.md`），检索后解析出来再回 PG 取完整商品信息。item key 的文件名有长度上限，中文 URI 编码会膨胀约 9 倍，因此超长 id（如供应商全称）自动退化为稳定短哈希 `kb/h<hash>.md`，原始来源仍写在文档正文的「关联键」中。
- 字符串只有前 64 个 UTF-8 字节可过滤，改 metadata schema 会触发全量重索引。
- 数据源不同步：PG 是权威源，商品改价或上下架后需重跑同步脚本，否则 AI Search 索引会滞后；检索侧用 `status` 过滤兜住下架商品。
- 默认关闭 query rewriting（额外走 Workers AI 计费），开启 reranking 与 hybrid（`rrf` 融合）。

### 费用（2026-11 核实，见官方 Limits & pricing）

| 项目 | 每月免费 | 超出单价 |
| --- | --- | --- |
| ingestion tokens | 5M | $0.75 / 1M tokens |
| 存储 | 10 GB-month | $2.00 / GB-month |
| 语义 / 混合查询 | 1,000 次 | $0.75 / 1,000 次 |
| 全文查询 | 1,000 次 | $0.10 / 1,000 次 |

官方页面当前写 **2026-12-01 起计费**。Workers AI 的 embedding 与 reranking 用量包含在 AI Search 用量里，不进 Workers AI 账单；**答案生成仍走 Workers AI neurons**。本项目全量文本约 177 万 token，落在免费 ingestion 额度内，但 1,000 次/月的语义查询对导购站偏低，灰度时需观测实际查询量。

