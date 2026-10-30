const ALLOWED_METHODS = "GET,POST,OPTIONS";
const MAX_FOOD_LENGTH = 100;
const JOB_TTL_SECONDS = 7 * 24 * 60 * 60;
const JOB_TIMEOUT_SECONDS = 120;
const JOB_TIMEOUT_ERROR = "Gemini API가 생성 요청 후 2분 안에 응답하지 않아 실패 처리했습니다. 브라우저 대기 시간이나 Worker 상태 조회 시간은 이 제한에 포함되지 않습니다.";
const HOURLY_JOB_LIMIT = 10;

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
  return allowed.includes(origin) ? origin : "";
}
function isQuotaError(status, body) {
  const error = body?.error || body || {};
  const detail = String(error.message || body?.message || error.status || body?.status || "");
  const reasons = (Array.isArray(error.errors) ? error.errors : []).map(item => String(item.reason || item.message || "")).join(" ");
  const code = String(error.status || body?.status || "");
  const info = (detail + " " + reasons + " " + code).toLowerCase();
  return status === 429 || [
    "quotaexceeded", "dailylimitexceeded", "ratelimitexceeded", "resource_exhausted",
    "resource exhausted", "quota", "rate limit", "rate_limit", "requests per day",
    "per day limit", "daily limit", "free tier", "free_tier", "billing"
  ].some(signal => info.includes(signal));
}
function errorMessage(service, status, body) {
  const error = body?.error || body || {};
  const detail = String(error.message || body?.message || error.status || body?.status || "");
  const reasons = (Array.isArray(error.errors) ? error.errors : []).map(item => String(item.reason || item.message || "")).join(" ");
  const code = String(error.status || body?.status || "");
  const info = (detail + " " + reasons + " " + code).toLowerCase();
  if (isQuotaError(status, body)) {
    return service + " 무료 사용량(할당량) 또는 요청 한도를 초과했습니다. " +
      "Google AI Studio의 API 사용량/한도와 결제 설정을 확인해 주세요. 사용량이 초기화되거나 한도가 조정된 뒤 다시 시도해 주세요.";
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
  const params = new URLSearchParams({part:"snippet",type:"video",maxResults:"50",order:"viewCount",regionCode:"KR",relevanceLanguage:"ko",q:food,key:apiKey});
  const {response,data} = await fetchJsonBeforeDeadline("https://www.googleapis.com/youtube/v3/search?" + params, {});
  if (!response.ok) throw new Error(errorMessage("YouTube Data API", response.status, data));
  let videos = (data.items || []).filter(x => x.id?.videoId).map(x => ({
    id:x.id.videoId,title:x.snippet?.title || "제목 없음",description:x.snippet?.description || "",
    channel:x.snippet?.channelTitle || "채널 정보 없음",publishedAt:x.snippet?.publishedAt || "",
    url:"https://www.youtube.com/watch?v=" + x.id.videoId,views:0
  }));
  // 검색어의 모든 핵심 단어가 제목·설명·채널명 중 하나에는 포함된 영상만 유지합니다.
  // 공백과 특수문자를 제거해 '옥동자표 제육볶음'처럼 단어가 붙거나 표현 순서가 달라도 매칭합니다.
  const normalize = value => String(value || "").toLocaleLowerCase("ko-KR").replace(/[\s\p{P}\p{S}]+/gu, "");
  const searchTerms = food.toLocaleLowerCase("ko-KR").trim().split(/\s+/).filter(Boolean);
  videos = videos.filter(video => {
    const searchableText = normalize([video.title, video.description, video.channel].join(" "));
    return searchTerms.every(term => searchableText.includes(normalize(term)));
  });
  if (!videos.length) throw new Error("검색어의 핵심 단어가 포함된 유튜브 영상을 찾지 못했습니다. 음식명이나 스타일 이름을 조금 바꾸어 다시 시도하세요.");
  try {
    const {response:statsResponse,data:statsData} = await fetchJsonBeforeDeadline("https://www.googleapis.com/youtube/v3/videos?" + new URLSearchParams({part:"statistics",id:videos.map(v=>v.id).join(","),key:apiKey}), {});
    if (statsResponse.ok) {
      const stats = new Map((statsData.items || []).map(v => [v.id, Number(v.statistics?.viewCount || 0)]));
      videos.forEach(v => { v.views=stats.get(v.id)||0; }); videos.sort((a,b)=>b.views-a.views);
    }
  } catch (_) {}
  return videos;
}
function buildPrompt(food, style, primary, references) {
  const context = "제목: "+primary.title+"\n채널: "+primary.channel+"\n게시일: "+(primary.publishedAt?primary.publishedAt.slice(0,10):"미상")+"\n조회수: "+primary.views+"\n설명: "+primary.description.slice(0,900)+"\nURL: "+primary.url;
  const refContext = references.map((v,i)=>"보조 영상 "+(i+1)+": "+v.title+"\n채널: "+v.channel+"\n조회수: "+v.views+"\n설명: "+v.description.slice(0,500)+"\nURL: "+v.url).join("\n\n");
  return "당신은 한국어 레시피 에디터입니다. 기준 영상 1개를 주된 출처로 사용하고 보조 영상은 양과 시간 추정에 꼭 필요할 때만 제한적으로 참고하세요.\n음식: "+food+"\n옵션: "+style+"\n기준 양: 2인분\n\n[기준 영상 — 재료 구성과 조리 순서를 결정하는 유일한 출처]\n"+context+"\n\n[보조 영상 — 양과 조리 시간 추정에만 사용 가능]\n"+(refContext||"보조 영상 없음")+"\n\n필수 규칙:\n1) 기준 영상의 음성, 자막, 화면에 실제로 등장하는 재료와 양념을 빠짐없이 확인하세요. 다시다, 맛소금, 설탕, 후추처럼 소량이거나 마지막에 추가되는 재료도 놓치지 마세요.\n2) 재료 종류, 양념 종류, 투입 순서, 조리법은 기준 영상만 따르세요. 보조 영상에만 등장하는 재료를 추가하지 마세요.\n3) 기준 영상에서 양이나 시간이 확인되지 않을 때에만 보조 영상으로 추정할 수 있습니다. 기준 영상에 이미 있는 재료에 한정하고, 추정한 양이나 시간은 '추정'이라고 표시하세요.\n4) 영상에서 확인되지 않는 정보를 확인했다고 주장하지 마세요. 보조 영상이 기준 영상과 다르면 기준 영상을 우선하세요.\n5) '아이들도 먹기 좋은' 옵션이면 기준 영상 레시피에서 맵기와 자극적인 재료만 조정하세요.\n6) 출력은 반드시 '🥕 필요한 재료 (2인분)'과 '👩‍🍳 조리 순서' 두 항목만 작성하세요. 재료는 '- 재료명: 양' 형식, 조리 순서는 번호를 붙여 짧게 작성하세요.\n7) 조리 단계마다 재료명과 용량을 명시하고 재료 목록과 일치시키세요.\\n8) 조리시간을 절대 생략하지 마세요. 기준 영상에서 시간이 확인되면 그 시간을 사용하고, 확인되지 않으면 재료량과 조리법을 바탕으로 현실적인 시간을 추정해 '(추정)'이라고 표시하세요. 보조 영상이 없어도 반드시 시간 정보를 작성하세요.\\n9) 재료 손질·준비 시간과 실제 가열·조리 시간을 각각 표시하고, 마지막 조리 단계 문장 끝에 '(총 소요 시간 약 N분, 추정)' 형식으로 총 시간을 반드시 표시하세요. 각 단계 시간도 '(약 N분)'처럼 괄호 안에 표시하세요.\\n10) 인분 조정 기능이 시간을 인식할 수 있도록 모든 단계별 시간과 총 소요 시간을 괄호 안에 '약 10분' 또는 '약 10~15분' 형식으로 표기하세요. 소개나 결론은 쓰지 마세요.";
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
      "WHERE (SELECT COUNT(*) FROM jobs WHERE request_ip=? AND " +
      "((status='completed' AND updated_at>?) OR (status IN ('queued','running') AND created_at>?)))<? " +
      "AND (SELECT COUNT(*) FROM jobs WHERE request_ip=? AND status IN ('queued','running'))<2"
    ).bind(id,food,style,ip,now,now,ip,now-3600,now-3600,HOURLY_JOB_LIMIT,ip).run();
    if (Number(admission.meta?.changes||0)!==1) {
      const recent=await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE request_ip=? AND " +
        "((status='completed' AND updated_at>?) OR (status IN ('queued','running') AND created_at>?))"
      ).bind(ip,now-3600,now-3600).first();
      if (Number(recent?.count||0)>=HOURLY_JOB_LIMIT) {
        return json({error:"IP별 시간당 최대 "+HOURLY_JOB_LIMIT+"회까지 요청할 수 있습니다."},429,origin);
      }
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
