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

## 常用命令
```bash
npm run typecheck        # tsc --noEmit
npm run dev              # wrangler dev
npm run agent:check      # 质量检查 + 报告
npm run agent:guard      # 提交门禁
npm run agent:digest     # 开发习惯周报
```
