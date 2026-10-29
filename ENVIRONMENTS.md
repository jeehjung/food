# 개발/운영 환경 분리

## 현재 구성

- 운영: `main` 브랜치 + GitHub Pages 운영 주소 + Cloudflare Worker `food-recipe-api` + D1 `food-recipe-jobs`
- 개발: `develop` 브랜치 + 별도 Cloudflare Pages 프로젝트(`food-dev`) + Worker `food-recipe-api-dev` + D1 `food-recipe-jobs-dev`
- 개발 환경의 Queue 이름은 운영과 겹치지 않도록 `food-recipe-jobs-dev`, DLQ는 `food-recipe-dead-letter-dev`로 분리한다.

## 개발 환경 최초 1회 설정

Cloudflare 계정에 개발용 리소스를 별도로 생성해야 한다. 운영 DB/Queue를 개발 환경에 연결하지 않는다.

1. Cloudflare D1에서 `food-recipe-jobs-dev` 데이터베이스를 생성한다.
2. 생성된 D1 database_id를 `wrangler.toml`의 `env.development.d1_databases[0].database_id`에 입력한다. 현재 값 `REPLACE_WITH_DEV_D1_DATABASE_ID`는 배포 전 반드시 교체해야 한다.
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
6. 저장소 `jeehjung/food`를 Cloudflare Workers Builds에 연결해 빌드 브랜치를 `develop`으로 지정하고 Worker 이름이 `food-recipe-api-dev`인지 확인한다. 또는 로컬 Wrangler 로그인 환경에서 `npx wrangler deploy --env development`로 배포한다.
7. Cloudflare Pages에 별도 프로젝트 `food-dev`를 만들고 동일 저장소의 Production branch를 `develop`으로 지정한다. 정적 HTML 프로젝트이므로 별도 빌드가 필요하지 않으며 출력 디렉터리는 저장소 루트로 설정한다.
8. 개발 사이트의 `index.html`에서 `DEFAULT_SERVER_URL`을 개발 Worker의 실제 `workers.dev` 주소로 지정한다. 개발 Worker의 `ALLOWED_ORIGINS`도 개발 Pages의 실제 도메인과 일치시킨다.

## 일상적인 개발/배포 절차

1. 기능 수정은 항상 `develop` 브랜치에서 한다.
2. 개발 Pages와 `food-recipe-api-dev`에서 검증한다.
3. 검증이 끝나면 GitHub에서 `develop` → `main` Pull Request를 만든다.
4. 변경 내용을 확인하고 승인/병합하면 운영 Pages와 `food-recipe-api`에 반영한다.
5. 운영 D1 및 운영 Queue는 개발 과정에서 변경하지 않는다.

## 주의

- 현재 운영 Pages/Worker/D1/Queue 설정은 변경하지 않는다.
- 개발용 D1 ID와 개발 Worker URL은 Cloudflare에서 리소스를 만든 후 확정된다. 따라서 이 문서와 개발용 Wrangler 환경은 준비됐지만, Cloudflare 대시보드에서 리소스를 생성하고 연결하기 전까지 개발 서버 배포가 완료된 것은 아니다.
- 운영용 `main` 브랜치는 계속 기존 운영 배포 대상으로 유지한다.
