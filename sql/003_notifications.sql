-- 003_notifications.sql — 站内信 / 通知
-- 每条通知归属一个用户；支持管理员广播（批量插入）和业务事件触发（单条插入）。

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'system',            -- system | product | chat | admin
  title TEXT NOT NULL,
  content TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,     -- 扩展数据：skuCode / sessionId / link 等
  read_at TIMESTAMPTZ,                            -- NULL = 未读
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 列表查询：按未读优先、时间倒序
CREATE INDEX IF NOT EXISTS idx_notifications_user
  ON notifications (user_id, read_at NULLS FIRST, created_at DESC);

-- 未读计数：覆盖索引，轻量查询
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications (user_id) WHERE read_at IS NULL;
