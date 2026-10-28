# Food Recipe Worker 배포 안내

이 저장소는 GitHub Pages 프런트엔드와 Cloudflare Worker + Queues + D1 백엔드로 구성됩니다. Queue 소비자는 브라우저와 독립적으로 레시피 작업을 수행합니다.

## 1. 사전 준비

- Cloudflare 계정
- Node.js LTS 및 npm
- Gemini API 키
- Google Cloud에서 YouTube Data API v3를 활성화하고 발급한 API 키

## 2. Queue와 D1 생성

저장소 루트에서 실행합니다.

```bash
npm install
npx wrangler login
npx wrangler queues create food-recipe-jobs
npx wrangler queues create food-recipe-dead-letter
npx wrangler d1 create food-recipe-jobs
```

D1 생성 명령이 출력하는 database_id를 복사해 wrangler.toml의 database_id 항목에 넣습니다.

```bash
npx wrangler d1 execute food-recipe-jobs --remote --file=./schema.sql
```

## 3. API 키를 서버 Secret으로 등록

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put YOUTUBE_API_KEY
```

API 키를 소스 코드나 GitHub 저장소에 넣지 마세요. 필요하면 wrangler.toml의 ALLOWED_ORIGINS에 프런트엔드 도메인을 추가합니다. 기본값은 https://jeehjung.github.io 입니다.

## 4. Worker 배포

```bash
npx wrangler deploy
```

배포 성공 메시지에서 Worker URL을 확인합니다. 보통 https://food-recipe-api.<Cloudflare 계정 서브도메인>.workers.dev 형태입니다.

## 5. GitHub Pages 연결

웹앱에서 상단의 API 설정 버튼을 열고 서버 API 주소에 Worker URL을 입력합니다(끝의 슬래시 제외). 저장 후 서버 연결 확인이 성공하면 사용할 수 있습니다.

서버 API 주소만 브라우저 localStorage에 저장됩니다. Gemini/YouTube API 키는 Worker Secret으로 관리합니다. 기존 브라우저에 남아 있는 이전 API 키는 프런트엔드가 초기화 시 제거합니다.

## 6. 동작 확인

1. 음식명을 입력해 레시피 생성을 요청합니다.
2. 상태가 대기 중 → 처리 중 → 완료로 바뀌는지 확인합니다.
3. 작업 중 브라우저를 닫았다가 다시 열어도 마지막 작업을 자동으로 조회합니다.
4. 로그 확인: npx wrangler tail

## 운영 및 보안 참고

- D1의 작업 상태와 레시피 결과는 생성 시점부터 약 24시간 후 정리됩니다. 브라우저 보관함은 기존처럼 localStorage를 사용합니다.
- Worker는 IP별 시간당 최대 5회, 동시에 대기/진행 작업 최대 2개로 제한합니다. 공개 API를 완전히 인증하는 장치는 아니므로 공개 배포 전 Cloudflare WAF/Rate Limiting 또는 Turnstile 추가를 권장합니다.
- CORS는 브라우저의 교차 출처 요청을 제한하지만 단독으로 API 보안을 보장하지 않습니다.
- Gemini 모델 이름 및 Interactions API의 YouTube URL 영상 입력 지원 여부는 실제 환경에서 테스트해야 합니다.
