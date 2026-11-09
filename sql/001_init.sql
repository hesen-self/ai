-- 001_init.sql — 初始建表 DDL（本目录是 DDL 的唯一权威源，不要再维护第二份副本）
--
-- 消费方式：
--   1) src/schema.ts 以 Wrangler Text 模块导入，供 POST /api/admin/migrate 在 Worker 内逐条执行；
--   2) 本地直接执行：psql "$DATABASE_URL" -f sql/001_init.sql
--
-- 约定见 sql/README.md：新增变更请建 0NN_*.sql 并在 src/schema.ts 的 MIGRATIONS 中登记。
-- 迁移会全量重放，因此每条语句必须幂等（CREATE ... IF NOT EXISTS）。
-- 注：chat_sessions.id 为 UUID，由应用层生成，不依赖 gen_random_uuid() 扩展。

CREATE TABLE IF NOT EXISTS app_users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS products (
  sku_code TEXT PRIMARY KEY,
  spu_code TEXT NOT NULL,
  name TEXT NOT NULL,
  spec TEXT,
  status TEXT NOT NULL DEFAULT '',
  biz_type TEXT,
  category TEXT,
  tenant TEXT,
  price NUMERIC(14,2) NOT NULL DEFAULT 0,
  stock NUMERIC(16,3) NOT NULL DEFAULT 0,
  list_price NUMERIC(14,2),
  spu_stock NUMERIC(16,3),
  sales INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  reviews INTEGER NOT NULL DEFAULT 0,
  min_order INTEGER NOT NULL DEFAULT 1,
  pricing_type TEXT,
  unit TEXT,
  recommended BOOLEAN NOT NULL DEFAULT false,
  after_sales BOOLEAN NOT NULL DEFAULT false,
  price_range TEXT,
  image_url TEXT,
  cover_url TEXT,
  gallery JSONB NOT NULL DEFAULT '[]'::jsonb,
  intro TEXT,
  tier_prices JSONB NOT NULL DEFAULT '[]'::jsonb,
  logistics JSONB,
  delivery JSONB NOT NULL DEFAULT '[]'::jsonb,
  video_url TEXT,
  weight_kg NUMERIC(14,3),
  volume_m3 NUMERIC(14,3),
  search_text TEXT NOT NULL DEFAULT '',
  embed_text TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  vector_id TEXT,
  synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_spu ON products (spu_code);
CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);
CREATE INDEX IF NOT EXISTS idx_products_status ON products (status);
CREATE INDEX IF NOT EXISTS idx_products_price ON products (price);
CREATE INDEX IF NOT EXISTS idx_products_updated ON products (updated_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_docs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_hash TEXT NOT NULL DEFAULT '',
  vector_id TEXT,
  synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_kind ON knowledge_docs (kind);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '新对话',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  products JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages (session_id, created_at);
