// 내 앱 현황(jeehjung/app-dashboard) 대시보드용 Gemini 사용량 기록
// 공용 D1 app-usage(바인딩 USAGE_DB)에 한국 날짜별 호출 수를 더함. 개발 환경은 USAGE_ENV = "dev".
// 바인딩이 없거나 기록이 실패해도 앱 동작에는 영향 없음.
export async function logGemini(env, app, status, personal = false) {
  const db = env && env.USAGE_DB;
  if (!db) return;
  const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const quota = status === 429 ? 1 : 0;
  const error = !quota && !(status >= 200 && status < 300) ? 1 : 0;
  try {
    await db.prepare('INSERT INTO gemini_daily (app, env, day, key, calls, errors, quota, updated) VALUES (?, ?, ?, ?, 1, ?, ?, ?) ON CONFLICT(app, env, day, key) DO UPDATE SET calls = calls + 1, errors = errors + excluded.errors, quota = quota + excluded.quota, updated = excluded.updated')
      .bind(app, env.USAGE_ENV === 'dev' ? 'dev' : 'prod', day, personal ? 'personal' : 'default', error, quota, Date.now()).run();
  } catch (_) {}
}
