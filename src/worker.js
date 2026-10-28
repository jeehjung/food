const ALLOWED_METHODS = "GET,POST,OPTIONS";
const MAX_FOOD_LENGTH = 100;
const JOB_TTL_SECONDS = 24 * 60 * 60;
const HOURLY_JOB_LIMIT = 5;

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
function errorMessage(service, status, body) {
  const detail = body?.error?.message || body?.message || body?.status || "";
  if (status === 429) return service + " API 사용 한도 또는 요청 횟수를 초과했습니다.";
  if (status === 401 || status === 403) return service + " API 접근이 거부되었습니다. 서버 Secret과 API 권한을 확인하세요.";
  if (status === 404) return service + " 모델 또는 API 주소를 찾을 수 없습니다. 모델 이름을 확인하세요.";
  if (status >= 500) return service + " 서버 오류입니다. 잠시 후 다시 시도하세요.";
  return service + " 요청 실패 (HTTP " + status + ")" + (detail ? ": " + String(detail).slice(0, 300) : "");
}
async function searchVideos(food, apiKey) {
  const params = new URLSearchParams({part:"snippet",type:"video",maxResults:"50",order:"viewCount",regionCode:"KR",relevanceLanguage:"ko",q:food,key:apiKey});
  const response = await fetch("https://www.googleapis.com/youtube/v3/search?" + params);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorMessage("YouTube Data API", response.status, data));
  let videos = (data.items || []).filter(x => x.id?.videoId).map(x => ({
    id:x.id.videoId,title:x.snippet?.title || "제목 없음",description:x.snippet?.description || "",
    channel:x.snippet?.channelTitle || "채널 정보 없음",publishedAt:x.snippet?.publishedAt || "",
    url:"https://www.youtube.com/watch?v=" + x.id.videoId,views:0
  }));
  const terms = food.toLocaleLowerCase("ko-KR").split(/\s+/).filter(Boolean);
  videos = videos.filter(v => { const title=v.title.toLocaleLowerCase("ko-KR"); return terms.every(term => title.includes(term)); });
  if (!videos.length) throw new Error("유튜브 영상 제목에 입력한 음식명의 모든 단어가 포함된 영상이 없습니다. 음식명을 바꾸어 다시 시도하세요.");
  try {
    const statsResponse = await fetch("https://www.googleapis.com/youtube/v3/videos?" + new URLSearchParams({part:"statistics",id:videos.map(v=>v.id).join(","),key:apiKey}));
    const statsData = await statsResponse.json().catch(() => ({}));
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
  return "당신은 한국어 레시피 에디터입니다. 기준 영상 1개를 주된 출처로 사용하고 보조 영상은 양과 시간 추정에 꼭 필요할 때만 제한적으로 참고하세요.\n음식: "+food+"\n옵션: "+style+"\n기준 양: 2인분\n\n[기준 영상 — 재료 구성과 조리 순서를 결정하는 유일한 출처]\n"+context+"\n\n[보조 영상 — 양과 조리 시간 추정에만 사용 가능]\n"+(refContext||"보조 영상 없음")+"\n\n필수 규칙:\n1) 기준 영상의 음성, 자막, 화면에 실제로 등장하는 재료와 양념을 빠짐없이 확인하세요. 다시다, 맛소금, 설탕, 후추처럼 소량이거나 마지막에 추가되는 재료도 놓치지 마세요.\n2) 재료 종류, 양념 종류, 투입 순서, 조리법은 기준 영상만 따르세요. 보조 영상에만 등장하는 재료를 추가하지 마세요.\n3) 기준 영상에서 양이나 시간이 확인되지 않을 때에만 보조 영상으로 추정할 수 있습니다. 기준 영상에 이미 있는 재료에 한정하고, 추정한 양이나 시간은 '추정'이라고 표시하세요.\n4) 영상에서 확인되지 않는 정보를 확인했다고 주장하지 마세요. 보조 영상이 기준 영상과 다르면 기준 영상을 우선하세요.\n5) '아이들도 먹기 좋은' 옵션이면 기준 영상 레시피에서 맵기와 자극적인 재료만 조정하세요.\n6) 출력은 반드시 '🥕 필요한 재료 (2인분)'과 '👩‍🍳 조리 순서' 두 항목만 작성하세요. 재료는 '- 재료명: 양' 형식, 조리 순서는 번호를 붙여 짧게 작성하세요.\n7) 조리 단계마다 재료명과 용량을 명시하고 재료 목록과 일치시키세요. 조리 시간은 추정이면 밝혀 주세요. 소개나 결론은 쓰지 마세요.";
}
async function callGemini(model, prompt, primary, references, apiKey) {
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method:"POST",headers:{"content-type":"application/json","x-goog-api-key":apiKey},
    body:JSON.stringify({model,input:[{type:"text",text:prompt},{type:"video",uri:primary.url},...references.map(v=>({type:"video",uri:v.url}))]})
  });
  return {response,data:await response.json().catch(()=>({}))};
}
async function generateRecipe(food, style, env) {
  const videos=await searchVideos(food,env.YOUTUBE_API_KEY),primary=videos[0],references=videos.slice(1,4);
  const prompt=buildPrompt(food,style,primary,references),started=Date.now();
  let model="gemini-3.5-flash-lite",result=await callGemini(model,prompt,primary,references,env.GEMINI_API_KEY);
  if (!result.response.ok) {
    const firstError=errorMessage("Gemini Flash-Lite",result.response.status,result.data);
    result=await callGemini("gemini-3.8-flash",prompt,primary,references,env.GEMINI_API_KEY);
    if (!result.response.ok) throw new Error(firstError+" 대체 모델도 실패했습니다. "+errorMessage("Gemini 대체 모델",result.response.status,result.data));
    model="gemini-3.8-flash";
  }
  const d=result.data,parts=Array.isArray(d?.steps)?d.steps.flatMap(s=>Array.isArray(s.content)?s.content:[]):[];
  const text=String(d?.output_text||parts.map(p=>p.text||"").join("\n")||(Array.isArray(d?.output)?d.output.flatMap(s=>s.content||[]).map(p=>p.text||"").join("\n"):"")).trim();
  if (!text) throw new Error("Gemini가 레시피 내용을 반환하지 않았습니다."+(d?.error?.message?" ("+String(d.error.message).slice(0,250)+")":""));
  return {food,style,text,sources:[primary,...references].map(v=>({title:v.title,url:v.url,channel:v.channel,publishedAt:v.publishedAt,views:v.views})),model,elapsedSeconds:Number(((Date.now()-started)/1000).toFixed(1))};
}
async function updateJob(db,id,status,fields={}) {
  await db.prepare("UPDATE jobs SET status=?,updated_at=?,result_json=COALESCE(?,result_json),error_message=COALESCE(?,error_message) WHERE id=?")
    .bind(status,Math.floor(Date.now()/1000),fields.resultJson??null,fields.errorMessage??null,id).run();
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
  if (request.method==="GET"&&url.pathname==="/api/health") return json({ok:true,service:"food-recipe-api"},200,origin);
  if (request.method==="POST"&&url.pathname==="/api/jobs") {
    if (!env.GEMINI_API_KEY||!env.YOUTUBE_API_KEY) return json({error:"GEMINI_API_KEY와 YOUTUBE_API_KEY 서버 Secret을 설정하세요."},503,origin);
    let body; try {body=await request.json();} catch (_) {return json({error:"요청 본문은 JSON이어야 합니다."},400,origin);}
    const food=String(body?.food||"").trim(),style=body?.style==="아이들도 먹기 좋은"?"아이들도 먹기 좋은":"가장 인기 많은";
    if (!food||food.length>MAX_FOOD_LENGTH) return json({error:"음식명은 1~"+MAX_FOOD_LENGTH+"자여야 합니다."},400,origin);
    const ip=request.headers.get("CF-Connecting-IP")||"unknown",now=Math.floor(Date.now()/1000);
    const recent=await env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE request_ip=? AND created_at>?").bind(ip,now-3600).first();
    if (Number(recent?.count||0)>=HOURLY_JOB_LIMIT) return json({error:"IP별 시간당 최대 "+HOURLY_JOB_LIMIT+"회까지 요청할 수 있습니다."},429,origin);
    const active=await env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE request_ip=? AND status IN ('queued','running')").bind(ip).first();
    if (Number(active?.count||0)>=2) return json({error:"이미 처리 중인 작업이 2개 있습니다. 완료 후 다시 시도하세요."},429,origin);
    const id=crypto.randomUUID();
    await env.DB.prepare("INSERT INTO jobs (id,food,style,status,request_ip,created_at,updated_at) VALUES (?,?,?,'queued',?,?,?)").bind(id,food,style,ip,now,now).run();
    try {await env.RECIPE_QUEUE.send({id,food,style,createdAt:now});}
    catch (_) {await updateJob(env.DB,id,"failed",{errorMessage:"Queue에 작업을 등록하지 못했습니다. Cloudflare Queue 설정을 확인하세요."});return json({error:"작업 대기열 등록 실패. 서버 Queue 설정을 확인하세요."},503,origin);}
    return json({id,status:"queued",food,createdAt:now},202,origin);
  }
  const match=url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})$/i);
  if (request.method==="GET"&&match) {
    const row=await env.DB.prepare("SELECT id,food,style,status,result_json,error_message,created_at,updated_at FROM jobs WHERE id=?").bind(match[1]).first();
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
        await updateJob(env.DB,job.id,"running");
        const result=await generateRecipe(job.food,job.style,env);
        await updateJob(env.DB,job.id,"completed",{resultJson:JSON.stringify(result)});
      } catch (error) {
        console.error("Recipe job failed",job.id,error);
        await updateJob(env.DB,job.id,"failed",{errorMessage:String(error?.message||"레시피 생성 실패").slice(0,1000)});
      }
      message.ack();
    }
  },
  async scheduled(controller,env) {
    const cutoff=Math.floor(Date.now()/1000)-JOB_TTL_SECONDS;
    await env.DB.prepare("DELETE FROM jobs WHERE created_at<?").bind(cutoff).run();
  }
};
