# 개발/운영 환경 분리

## 현재 구성

- 운영: `main` 브랜치 + Cloudflare Pages `recipe`(`https://recipe-2vx.pages.dev`) + Cloudflare Worker `food-recipe-api` + D1 `food-recipe-jobs`
- 개발: `develop` 브랜치 + Cloudflare Pages `recipe-dev`(`https://recipe-dev.pages.dev`) + Worker `food-recipe-api-dev` + D1 `food-recipe-jobs-dev`
- 개발 환경의 Queue 이름은 운영과 겹치지 않도록 `food-recipe-jobs-dev`, DLQ는 `food-recipe-dead-letter-dev`로 분리한다.

## 개발 환경 최초 1회 설정

Cloudflare 계정에 개발용 리소스를 별도로 생성해야 한다. 운영 DB/Queue를 개발 환경에 연결하지 않는다.

1. Cloudflare D1에서 `food-recipe-jobs-dev` 데이터베이스를 생성한다.
2. 생성된 D1 database_id를 `wrangler.dev.toml`의 `d1_databases[0].database_id`에 입력한다. (현재 입력 완료)
3. 개발용 Queue `food-recipe-jobs-dev`와 DLQ `food-recipe-dead-letter-dev`를 생성한다.
4. 개발용 D1에 아래 SQL을 실행한다.

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  food TEXT NOT NULL,
  style TEXT NOT NULL,
  status TEXT NOT NULL,
  request_ip TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  result_json TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_request_ip_created
ON jobs(request_ip, created_at);

CREATE INDEX IF NOT EXISTS idx_jobs_status
ON jobs(status);
```

5. 개발 Worker의 Secret을 별도로 등록한다. 운영 Secret을 공유하거나 운영 키를 문서/코드에 저장하지 않는다.
   - `npx wrangler secret put YOUTUBE_API_KEY --env development`
6. 저장소 `JungJeehyun/recipe`를 Cloudflare Workers Builds에 연결해 빌드 브랜치를 `develop`으로 지정하고 Worker 이름이 `food-recipe-api-dev`인지 확인한다. 또는 로컬 Wrangler 로그인 환경에서 `npx wrangler deploy --config wrangler.dev.toml`로 배포한다.
7. 프런트엔드는 GitHub Actions(`.github/workflows/deploy-pages.yml`)가 Cloudflare Pages에 직접 업로드한다. `main` → `recipe`, `develop` → `recipe-dev`. API 토큰에 Cloudflare Pages Edit 권한이 필요하다.
8. `index.html`은 접속 도메인으로 개발/운영을 자동 판별한다. `recipe-dev.pages.dev`(및 프리뷰 하위 도메인)·localhost에서는 개발 Worker와 `develop` 브랜치를, 그 외에는 운영 Worker와 `main` 브랜치를 사용한다. 각 Worker의 `ALLOWED_ORIGINS`는 해당 Pages 도메인과 일치시킨다.

## 일상적인 개발/배포 절차

1. 기능 수정은 항상 `develop` 브랜치에서 한다.
2. 개발 Pages와 `food-recipe-api-dev`에서 검증한다.
3. 검증이 끝나면 GitHub에서 `develop` → `main` Pull Request를 만든다.
4. 변경 내용을 확인하고 승인/병합하면 운영 Pages와 `food-recipe-api`에 반영한다.
5. 운영 D1 및 운영 Queue는 개발 과정에서 변경하지 않는다.

## 주의

- `index.html`은 main과 develop에서 동일해야 한다. 브랜치별로 Worker 주소를 바꿔 커밋하지 않는다.

- 현재 운영 Pages/Worker/D1/Queue 설정은 변경하지 않는다.
- 운영용 `main` 브랜치는 계속 기존 운영 배포 대상으로 유지한다.
