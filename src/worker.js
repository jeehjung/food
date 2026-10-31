const ALLOWED_METHODS = "GET,POST,OPTIONS";
const MAX_FOOD_LENGTH = 100;
const JOB_TTL_SECONDS = 7 * 24 * 60 * 60;
const JOB_TIMEOUT_SECONDS = 120;
const JOB_TIMEOUT_ERROR = "Gemini API가 생성 요청 후 2분 안에 응답하지 않아 실패 처리했습니다. 브라우저 대기 시간이나 Worker 상태 조회 시간은 이 제한에 포함되지 않습니다.";

function json(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "access-control-allow-origin": origin, "access-control-allow-methods": ALLOWED_METHODS,
    "access-control-allow-headers": "content-type", "vary": "Origin"
  }});
}
function corsOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "https://jeehjung.github.io").split(",").map(x => x.trim()).filter(Boolean);
  const matches = allowed.some(rule => {
    if (rule === origin) return true;
    if (rule.startsWith("https://*.") && origin.startsWith("https://")) {
      const suffix = rule.slice("https://*".length).toLowerCase();
      const hostname = origin.slice("https://".length).toLowerCase();
      return hostname.endsWith(suffix) && hostname.length > suffix.length && !hostname.slice(0, -suffix.length).includes("/");
    }
    return false;
  });
  return matches ? origin : "";
}
function isQuotaError(status, body) {
  const error = body?.error || body || {};
  const reasons = (Array.isArray(error.errors) ? error.errors : [])
    .map(item => String(item.reason || "")).join(" ").toLowerCase();
  const code = String(error.status || body?.status || "").toLowerCase();
  const detail = String(error.message || body?.message || "").toLowerCase();
  // YouTube의 명시적인 quota reason 또는 HTTP 429만 한도 오류로 분류합니다.
  // 단순히 메시지에 quota/billing이라는 단어가 있다는 이유만으로 분류하지 않습니다.
  return status === 429 || [
    "quotaexceeded", "dailylimitexceeded", "ratelimitexceeded"
  ].some(reason => reasons.includes(reason) || code.includes(reason) || detail.includes(reason));
}
function errorMessage(service, status, body) {
  const error = body?.error || body || {};
  const detail = String(error.message || body?.message || error.status || body?.status || "");
  const reasons = (Array.isArray(error.errors) ? error.errors : []).map(item => String(item.reason || item.message || "")).join(" ");
  const code = String(error.status || body?.status || "");
  const info = (detail + " " + reasons + " " + code).toLowerCase();
  if (isQuotaError(status, body)) {
    if (service === "YouTube Data API") {
      return "YouTube Data API 요청 한도 또는 할당량을 초과했습니다. Google Cloud Console에서 YouTube Data API v3의 일일 할당량과 사용량을 확인해 주세요." +
        (detail ? " (상세: " + detail.slice(0, 250) + ")" : "");
    }
    return service + " 요청 한도 또는 할당량을 초과했습니다. 해당 API 제공자의 사용량과 한도 설정을 확인해 주세요." +
      (detail ? " (상세: " + detail.slice(0, 250) + ")" : "");
  }
  if (status === 401) return service + " API 키가 유효하지 않습니다. Cloudflare 서버 Secret을 확인해 주세요.";
  if (status === 403) {
    return service + " API 접근이 거부되었습니다. API 키 권한, API 활성화 및 키 제한을 확인해 주세요." +
      (detail ? " (상세: " + detail.slice(0, 250) + ")" : "");
  }
  if (status === 404) return service + " 모델 또는 API 주소를 찾을 수 없습니다. 모델 이름과 API 설정을 확인해 주세요.";
  if (status >= 500) return service + " 서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
  return service + " 요청 실패 (HTTP " + status + ")" + (detail ? ": " + detail.slice(0, 300) : "");
}
function jobTimeoutError() { return new Error(JOB_TIMEOUT_ERROR); }
async function fetchJsonBeforeDeadline(url, options, deadlineAt = null) {
  if (deadlineAt == null) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    return {response,data};
  }
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw jobTimeoutError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => {
      if (controller.signal.aborted) throw jobTimeoutError();
      return {};
    });
    if (controller.signal.aborted) throw jobTimeoutError();
    return {response,data};
  } catch (error) {
    if (controller.signal.aborted) throw jobTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function searchVideos(food, apiKey) {
  const normalize = value => String(value || "").toLocaleLowerCase("ko-KR").replace(/[\s\p{P}\p{S}]+/gu, "");
  const queryText = String(food || "").trim();
  const normalizedQuery = normalize(queryText);
  // 입력한 모든 검색어를 유지합니다. 띄어쓰기·붙여쓰기 차이만 정규화해 비교합니다.
  const terms = queryText.toLocaleLowerCase("ko-KR").split(/\s+/).map(normalize).filter(term => term.length >= 2);
  const searchQuery = /레시피\s*$/u.test(queryText) ? queryText : queryText + " 레시피";
  const searchQueries = [searchQuery];
  const found = new Map();

  // 상호명·인물명·음식명이 함께 입력된 경우를 고려해 원문 검색을 먼저 수행합니다.
  // 원문 검색에서 조리 영상이 충분히 확인되지 않을 때만 '레시피'를 붙여 재검색합니다.
  const fetchSearchResults = async query => {
    const params = new URLSearchParams({part:"snippet",type:"video",maxResults:"50",order:"viewCount",regionCode:"KR",relevanceLanguage:"ko",q:query,key:apiKey});
    const {response,data} = await fetchJsonBeforeDeadline("https://www.googleapis.com/youtube/v3/search?" + params, {});
    if (!response.ok) throw new Error(errorMessage("YouTube Data API", response.status, data));
    for (const item of data.items || []) {
      if (!item.id?.videoId || found.has(item.id.videoId)) continue;
      found.set(item.id.videoId, {
        id:item.id.videoId,title:item.snippet?.title || "제목 없음",description:item.snippet?.description || "",
        channel:item.snippet?.channelTitle || "채널 정보 없음",publishedAt:item.snippet?.publishedAt || "",
        url:"https://www.youtube.com/watch?v=" + item.id.videoId,views:0
      });
    }
  };

  const rankCandidates = () => {
    const cookingSignals = ["레시피","만드는법","만들기","요리법","조리법","요리","조리","황금레시피","간단요리","집밥","양념","볶음","찜닭","조림","계란밥"];
    const excludeSignals = ["먹방","시식","맛집탐방","식당리뷰","방문후기"];
    return [...found.values()].map(video => {
      const title = normalize(video.title);
      const description = normalize(video.description);
      // 제목·설명에 포함된 해시태그도 별도로 추출해 검색어 일치 여부에 반영합니다.
      const hashtagText = normalize(
        [...(String(video.title || "") + " " + String(video.description || "")).matchAll(/#[\\p{L}\\p{N}_]+/gu)]
          .map(match => match[0].slice(1))
          .join(" ")
      );
      const channel = normalize(video.channel);
      const titleHits = terms.filter(term => title.includes(term)).length;
      const descriptionHits = terms.filter(term => description.includes(term)).length;
      const hashtagHits = terms.filter(term => hashtagText.includes(term)).length;
      const exactTitleMatch = !!normalizedQuery && title.includes(normalizedQuery);
      const hasCookingContext = cookingSignals.some(term => title.includes(normalize(term)) || description.includes(normalize(term)));
      const looksLikeNonRecipe = excludeSignals.some(term => title.includes(normalize(term))) && !hasCookingContext;
      // 입력한 모든 단어가 제목·설명 또는 해시태그에 포함되면 통과합니다.
      // 해시태그는 # 기호를 제외하고 비교하며 띄어쓰기 차이는 정규화합니다.
      const allTermsIncluded = terms.length > 0 && terms.every(term =>
        title.includes(term) || description.includes(term) || hashtagText.includes(term)
      );
      const relevant = !looksLikeNonRecipe && allTermsIncluded;
      const score = (exactTitleMatch ? 100 : 0) + titleHits * 20 + descriptionHits * 3 + hashtagHits * 12 + (hasCookingContext ? 15 : 0) + (channel.includes(normalizedQuery) ? 5 : 0);
      return {video,relevant,score};
    }).filter(item => item.relevant).sort((a,b) => b.score-a.score).map(item => item.video);
  };

  let videos = [];
  // 입력 검색어 전체를 유지한 검색만 수행하고, 띄어쓰기 차이만 정규화해 판별합니다.
  for (const query of searchQueries) {
    await fetchSearchResults(query);
    videos = rankCandidates();
    if (videos.length >= 5) break;
  }
  if (!videos.length) throw new Error("입력한 음식명과 관련된 조리 영상을 찾지 못했습니다. 음식명만 입력하거나 '음식명 만드는 법'처럼 검색어를 바꾸어 다시 시도해 주세요.");

  // 검색 후보를 먼저 관련도순으로 정리한 뒤 조회수를 가져와, 관련 영상 안에서 인기순으로 표시합니다.
  try {
    const {response:statsResponse,data:statsData} = await fetchJsonBeforeDeadline("https://www.googleapis.com/youtube/v3/videos?" + new URLSearchParams({part:"statistics",id:videos.slice(0,50).map(v=>v.id).join(","),key:apiKey}), {});
    if (statsResponse.ok) {
      const stats = new Map((statsData.items || []).map(v => [v.id, Number(v.statistics?.viewCount || 0)]));
      videos.forEach(v => { v.views=stats.get(v.id)||0; });
      videos.sort((a,b) => b.views-a.views);
    }
  } catch (_) {}
  return videos;
}
function buildPrompt(food, style, primary, references) {
  const context = "제목: "+primary.title+"\n채널: "+primary.channel+"\n게시일: "+(primary.publishedAt?primary.publishedAt.slice(0,10):"미상")+"\n조회수: "+primary.views+"\n설명: "+primary.description.slice(0,900)+"\nURL: "+primary.url;
  const refContext = references.map((v,i)=>"보조 영상 "+(i+1)+": "+v.title+"\n채널: "+v.channel+"\n조회수: "+v.views+"\n설명: "+v.description.slice(0,500)+"\nURL: "+v.url).join("\n\n");
  return "당신은 한국어 레시피 에디터입니다. 기준 영상 1개를 주된 출처로 사용하고 보조 영상은 양과 시간 추정에 꼭 필요할 때만 제한적으로 참고하세요.\n음식: "+food+"\n옵션: "+style+"\n기준 양: 2인분\n\n[기준 영상 — 재료 구성과 조리 순서를 결정하는 유일한 출처]\n"+context+"\n\n[보조 영상 — 양과 조리 시간 추정에만 사용 가능]\n"+(refContext||"보조 영상 없음")+"\n\n필수 규칙:\n1) 기준 영상의 음성, 자막, 화면에 실제로 등장하는 재료와 양념을 빠짐없이 확인하세요. 다시다, 맛소금, 설탕, 후추처럼 소량이거나 마지막에 추가되는 재료도 놓치지 마세요.\n2) 재료 종류, 양념 종류, 투입 순서, 조리법은 기준 영상만 따르세요. 보조 영상에만 등장하는 재료를 추가하지 마세요.\n3) 기준 영상에서 양이나 시간이 확인되지 않을 때에만 보조 영상으로 추정할 수 있습니다. 기준 영상에 이미 있는 재료에 한정하고, 추정한 양이나 시간은 '추정'이라고 표시하세요.\n4) 영상에서 확인되지 않는 정보를 확인했다고 주장하지 마세요. 보조 영상이 기준 영상과 다르면 기준 영상을 우선하세요.\n5) '아이들도 먹기 좋은' 옵션이면 기준 영상 레시피에서 맵기와 자극적인 재료만 조정하세요.\n6) 출력은 반드시 '🥕 필요한 재료 (2인분)'과 '👩‍🍳 조리 순서' 두 항목만 작성하세요. 재료는 '- 재료명: 양' 형식, 조리 순서는 번호를 붙여 짧게 작성하세요.\n7) 조리 단계마다 재료명과 용량을 명시하고 재료 목록과 일치시키세요.\\n8) 재료 양을 '적당량', '약간', '조금', '취향껏', '필요한 만큼'으로 뭉뚱그리지 마세요. 영상에서 양이 확인되지 않더라도 2인분 기준으로 현실적인 수치와 단위를 추정해 제시하세요. 예: 간장 1큰술(추정), 설탕 1작은술(추정), 물 300ml(추정), 대파 1/2대(추정).\\n9) '적당량' 표기는 소금·후추처럼 마지막 간을 보며 조절하는 재료, 고명처럼 개인 취향에 따라 생략 가능한 재료에만 제한적으로 허용하세요. 이 경우에도 가능한 경우 시작 권장량을 함께 적으세요(예: 소금 1/3작은술부터, 마지막에 간 조절).\\n10) 영상에서 양이 확인된 재료는 영상의 양을 우선하고, 추정한 양은 반드시 '(추정)'이라고 표시하세요. 계량은 g/ml, 큰술(15ml), 작은술(5ml), 개수·대·쪽 등 가정에서 바로 계량할 수 있는 단위를 사용하세요.\\n11) 재료 목록의 추정량과 조리 순서에 적는 양을 일치시키고, '적당량'만 적힌 재료가 여러 개 생기지 않도록 마지막으로 검토하세요.\\n12) 조리시간을 절대 생략하지 마세요. 기준 영상에서 시간이 확인되면 그 시간을 사용하고, 확인되지 않으면 재료량과 조리법을 바탕으로 현실적인 시간을 추정해 '(추정)'이라고 표시하세요. 보조 영상이 없어도 반드시 시간 정보를 작성하세요.\\n13) 재료 손질·준비 시간과 실제 가열·조리 시간을 각각 표시하고, 마지막 조리 단계 문장 끝에 '(총 소요 시간 약 N분, 추정)' 형식으로 총 시간을 반드시 표시하세요. 각 단계 시간도 '(약 N분)'처럼 괄호 안에 표시하세요.\\n14) 인분 조정 기능이 시간을 인식할 수 있도록 모든 단계별 시간과 총 소요 시간을 괄호 안에 '약 10분' 또는 '약 10~15분' 형식으로 표기하세요. 소개나 결론은 쓰지 마세요.";
}
async function callGemini(model, prompt, primary, apiKey, deadlineAt) {
  return await fetchJsonBeforeDeadline("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method:"POST",headers:{"content-type":"application/json","x-goog-api-key":apiKey},
    body:JSON.stringify({
      model,
      input:[
        {type:"video",uri:primary.url,processing:"agentic"},
        {type:"text",text:prompt}
      ]
    })
  }, deadlineAt);
}
async function generateRecipe(food, style, env, geminiApiKey, videoIndex = 0) {
  const videos=await searchVideos(food,env.YOUTUBE_API_KEY);
  const selectedIndex=Math.max(0,Math.min(49,Math.floor(Number(videoIndex)||0)));
  const primary=videos[selectedIndex],references=[];
  if (!primary) throw new Error("검색 조건에 맞는 영상이 "+(selectedIndex+1)+"번째까지 없습니다. 다른 검색어로 시도해 주세요.");
  const prompt=buildPrompt(food,style,primary,references),started=Date.now();
  // Only Gemini generation has a 2-minute deadline. Queue wait, YouTube lookup, browser inactivity,\n  // and /api/jobs polling do not consume this timeout.
  const deadlineAt=Date.now()+JOB_TIMEOUT_SECONDS*1000;
  const model="gemini-3.5-flash-lite";
  const result=await callGemini(model,prompt,primary,geminiApiKey,deadlineAt);
  if (!result.response.ok) {
    throw new Error(errorMessage("Gemini Flash-Lite",result.response.status,result.data));
  }
  const d=result.data,parts=Array.isArray(d?.steps)?d.steps.flatMap(s=>Array.isArray(s.content)?s.content:[]):[];
  const text=String(d?.output_text||parts.map(p=>p.text||"").join("\n")||(Array.isArray(d?.output)?d.output.flatMap(s=>s.content||[]).map(p=>p.text||"").join("\n"):"")).trim();
  if (!text) throw new Error("Gemini가 레시피 내용을 반환하지 않았습니다."+(d?.error?.message?" ("+String(d.error.message).slice(0,250)+")":""));
  return {food,style,videoIndex:selectedIndex,text,sources:[primary].map(v=>({title:v.title,url:v.url,channel:v.channel,publishedAt:v.publishedAt,views:v.views})),model,videoProcessing:"agentic",elapsedSeconds:Number(((Date.now()-started)/1000).toFixed(1))};
}
async function updateJob(db,id,status,fields={}) {
  const now=Math.floor(Date.now()/1000);
  return await db.prepare(
    "UPDATE jobs SET status=?,updated_at=?,result_json=COALESCE(?,result_json),error_message=COALESCE(?,error_message) " +
    "WHERE id=? AND status IN ('queued','running')"
  ).bind(status,now,fields.resultJson??null,fields.errorMessage??null,id).run();
}
async function handleRequest(request,env) {
  const origin=corsOrigin(request,env),requestOrigin=request.headers.get("Origin")||"";
  if (request.method==="OPTIONS") {
    if (!origin) return new Response(null,{status:403});
    return new Response(null,{status:204,headers:{"access-control-allow-origin":origin,"access-control-allow-methods":ALLOWED_METHODS,"access-control-allow-headers":"content-type","access-control-max-age":"86400","vary":"Origin"}});
  }
  if (requestOrigin&&!origin) return json({error:"허용되지 않은 웹사이트에서의 요청입니다."},403,"");
  if (!env.DB||!env.RECIPE_QUEUE) return json({error:"서버 바인딩 설정이 완료되지 않았습니다."},503,origin);
  const url=new URL(request.url);
  if (request.method==="GET"&&url.pathname==="/api/health") {
    const service=url.hostname.startsWith("food-recipe-api-dev.")?"food-recipe-api-dev":"food-recipe-api";
    return json({ok:true,service},200,origin);
  }
  if (request.method==="POST"&&url.pathname==="/api/jobs") {
    if (!env.YOUTUBE_API_KEY) return json({error:"YOUTUBE_API_KEY 서버 Secret을 설정하세요."},503,origin);
    let body; try {body=await request.json();} catch (_) {return json({error:"요청 본문은 JSON이어야 합니다."},400,origin);}
    const geminiApiKey=String(body?.geminiApiKey||env.GEMINI_API_KEY||"").trim();
    if (!geminiApiKey) return json({error:"Gemini API 키를 브라우저 설정에 입력하세요."},400,origin);
    const food=String(body?.food||"").trim(),style=body?.style==="아이들도 먹기 좋은"?"아이들도 먹기 좋은":"가장 인기 많은",videoIndex=Math.max(0,Math.min(2,Number(body?.videoIndex)||0));
    if (!food||food.length>MAX_FOOD_LENGTH) return json({error:"음식명은 1~"+MAX_FOOD_LENGTH+"자여야 합니다."},400,origin);
    const ip=request.headers.get("CF-Connecting-IP")||"unknown",now=Math.floor(Date.now()/1000);
    const id=crypto.randomUUID();
    const admission=await env.DB.prepare(
      "INSERT INTO jobs (id,food,style,status,request_ip,created_at,updated_at) " +
      "SELECT ?,?,?, 'queued',?,?,? " +
      "WHERE (SELECT COUNT(*) FROM jobs WHERE request_ip=? AND status IN ('queued','running'))<2"
    ).bind(id,food,style,ip,now,now,ip).run();
    if (Number(admission.meta?.changes||0)!==1) {
      return json({error:"이미 처리 중인 작업이 2개 있습니다. 완료 후 다시 시도하세요."},429,origin);
    }
    try {await env.RECIPE_QUEUE.send({id,food,style,videoIndex,geminiApiKey,createdAt:now});}
    catch (_) {await updateJob(env.DB,id,"failed",{errorMessage:"Queue에 작업을 등록하지 못했습니다. Cloudflare Queue 설정을 확인하세요."});return json({error:"작업 대기열 등록 실패. 서버 Queue 설정을 확인하세요."},503,origin);}
    return json({id,status:"queued",food,createdAt:now},202,origin);
  }
  const cancelMatch=url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})\/cancel$/i);
  if (request.method==="POST"&&cancelMatch) {
    const id=cancelMatch[1];
    const existing=await env.DB.prepare("SELECT status FROM jobs WHERE id=?").bind(id).first();
    if (!existing) return json({error:"작업을 찾을 수 없거나 보관 기간이 지났습니다."},404,origin);
    if (existing.status==="completed") return json({status:"completed",message:"이미 완료된 작업입니다."},200,origin);
    if (existing.status==="failed"||existing.status==="cancelled") return json({status:existing.status,message:"작업이 이미 종료되었습니다."},200,origin);
    await env.DB.prepare("UPDATE jobs SET status='cancelled',updated_at=?,error_message=? WHERE id=? AND status IN ('queued','running')")
      .bind(Math.floor(Date.now()/1000),"사용자가 레시피 생성을 중지했습니다.",id).run();
    return json({id,status:"cancelled",message:"레시피 생성 작업을 중지했습니다."},200,origin);
  }
  const match=url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})$/i);
  if (request.method==="GET"&&match) {
    let row=await env.DB.prepare("SELECT id,food,style,status,result_json,error_message,created_at,updated_at FROM jobs WHERE id=?").bind(match[1]).first();
    if (!row) return json({error:"작업을 찾을 수 없거나 보관 기간이 지났습니다."},404,origin);
    return json({id:row.id,food:row.food,style:row.style,status:row.status,result:row.result_json?JSON.parse(row.result_json):null,error:row.error_message||null,createdAt:row.created_at,updatedAt:row.updated_at},200,origin);
  }
  return json({error:"요청한 API 경로가 없습니다."},404,origin);
}
export default {
  async fetch(request,env) {
    try {return await handleRequest(request,env);}
    catch (error) {console.error("Request failed",error);return json({error:"서버 요청 처리 실패. 설정과 로그를 확인하세요."},500,corsOrigin(request,env));}
  },
  async queue(batch,env) {
    for (const message of batch.messages) {
      const job=message.body;
      try {
        const current=await env.DB.prepare("SELECT status FROM jobs WHERE id=?").bind(job.id).first();
        if (!current || current.status==="cancelled" || current.status==="failed" || current.status==="completed") {
          message.ack();
          continue;
        }
        await updateJob(env.DB,job.id,"running");
        const result=await generateRecipe(job.food,job.style,env,job.geminiApiKey||env.GEMINI_API_KEY,job.videoIndex||0);
        const afterGeneration=await env.DB.prepare("SELECT status FROM jobs WHERE id=?").bind(job.id).first();
        if (!afterGeneration || afterGeneration.status==="cancelled") {
          message.ack();
          continue;
        }
        await updateJob(env.DB,job.id,"completed",{resultJson:JSON.stringify(result)});
      } catch (error) {
        console.error("Recipe job failed",job.id,error);
        const detail=String(error?.message||"레시피 생성 실패");
        const transient=/서버 오류|fetch|network|timeout|timed out/i.test(detail);
        if (detail!==JOB_TIMEOUT_ERROR && transient && Number(message.attempts||1)<3) {
          await updateJob(env.DB,job.id,"queued");
          message.retry({delaySeconds:30});
          continue;
        }
        await updateJob(env.DB,job.id,"failed",{errorMessage:detail.slice(0,1000)});
      }
      message.ack();
    }
  },
  async scheduled(controller,env) {
    const cutoff=Math.floor(Date.now()/1000)-JOB_TTL_SECONDS;
    await env.DB.prepare("DELETE FROM jobs WHERE created_at<?").bind(cutoff).run();
  }
};
