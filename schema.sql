CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  food TEXT NOT NULL,
  style TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  request_ip TEXT NOT NULL,
  result_json TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_ip_created ON jobs (request_ip, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs (status, created_at);

-- 영상 선택 목록 캐시(같은 검색어 6시간 재사용). Worker가 없으면 자동 생성합니다.
CREATE TABLE IF NOT EXISTS video_search_cache (
  query TEXT PRIMARY KEY,
  videos_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
