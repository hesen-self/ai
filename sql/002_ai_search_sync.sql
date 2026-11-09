-- 002_ai_search_sync.sql — AI Search 文档同步状态（增量上传的幂等依据）
--
-- AI Search 只接受文件/内置存储/R2/网站作为数据源，不直连 PostgreSQL。
-- 这里记录「哪一份文档、哪个内容版本」已经上传过，避免每次全量重传消耗
-- ingestion token。doc_key 就是 Items API 的 item key，与上传路径一一对应。

CREATE TABLE IF NOT EXISTS ai_search_sync (
  doc_key TEXT PRIMARY KEY,
  doc_kind TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_search_sync_kind ON ai_search_sync (doc_kind);
