const MODEL="minimax/h3-max-turbo/image-to-video";
const QUEUE_APP="minimax/h3-max-turbo";
const QUEUE_ORIGIN="https://queue.fal.run";
const CDN_HOST="v3b.fal.media";
const MAX_JSON_BYTES=1024*1024;

export class FalTurboError extends Error{
  constructor(code){super(code);this.name="FalTurboError";this.code=code;}
}

export function falInput(snapshot,startImageUrl,endImageUrl){
  if(!snapshot||snapshot.schemaVersion!==1||typeof snapshot.prompt!=="string"||!snapshot.prompt.trim()
    ||!(["480P","768P","1080P"].includes(snapshot.resolution))||snapshot.durationSeconds!==15
    ||snapshot.promptExpansionMode!=="disabled"||snapshot.enableSafetyChecker!==true||snapshot.syncMode!==false
    ||!validImageUrl(startImageUrl)||endImageUrl!==null&&!validImageUrl(endImageUrl))throw new FalTurboError("fal_input_invalid");
  return {prompt:snapshot.prompt,duration:15,resolution:snapshot.resolution,prompt_expansion_mode:"disabled",enable_safety_checker:true,
    sync_mode:false,image_url:startImageUrl,...(endImageUrl?{end_image_url:endImageUrl}:{})};
}

export function falRequestId(value){
  return typeof value==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(value)?value:null;
}

export function falStatusUrl(requestId){
  const id=falRequestId(requestId);
  if(!id)throw new FalTurboError("fal_request_id_invalid");
  return `${QUEUE_ORIGIN}/${QUEUE_APP}/requests/${id}/status`;
}

export function falResultUrl(requestId){
  const id=falRequestId(requestId);
  if(!id)throw new FalTurboError("fal_request_id_invalid");
  return `${QUEUE_ORIGIN}/${QUEUE_APP}/requests/${id}`;
}

export function falCancelUrl(requestId){
  const id=falRequestId(requestId);
  if(!id)throw new FalTurboError("fal_request_id_invalid");
  return `${QUEUE_ORIGIN}/${QUEUE_APP}/requests/${id}/cancel`;
}

export function falVideoUrl(value){
  if(typeof value!=="string"||value.length>2048)return null;
  try{
    const url=new URL(value);
    if(url.protocol!=="https:"||url.hostname!==CDN_HOST||url.username||url.password||url.port||url.search||url.hash
      ||!/^\/files\/b\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9._-]{1,255}$/.test(url.pathname))return null;
    return url.toString();
  }catch{return null;}
}

export function falVideoResult(value,maxBytes){
  const video=value&&typeof value==="object"&&!Array.isArray(value)?value.video:null;
  const url=falVideoUrl(video?.url);
  const bytes=video?.file_size;
  if(!url||video.content_type!=="video/mp4"||(bytes!==undefined&&(!Number.isSafeInteger(bytes)||bytes<1||bytes>maxBytes)))
    throw new FalTurboError("fal_video_result_invalid");
  return {url,bytes:bytes??null};
}

function validImageUrl(value){
  if(typeof value!=="string"||value.length>4096)return false;
  try{
    const url=new URL(value);
    const falFile=url.hostname==="v3b.fal.media"&&/^\/files\/b\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9._-]{1,255}$/.test(url.pathname);
    return url.protocol==="https:"&&!url.username&&!url.password&&!url.hash&&(Boolean(url.search)||falFile);
  }catch{return false;}
}

async function readJson(response){
  const length=Number(response.headers.get("content-length"));
  if(Number.isFinite(length)&&length>MAX_JSON_BYTES)throw new FalTurboError("fal_response_too_large");
  if(!response.body)throw new FalTurboError("fal_response_empty");
  const reader=response.body.getReader();const chunks=[];let size=0;
  try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>MAX_JSON_BYTES){await reader.cancel();throw new FalTurboError("fal_response_too_large");}chunks.push(Buffer.from(item.value));}}
  finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new FalTurboError("fal_response_invalid_json");}
}

async function falFetch(url,key,{method="GET",body,timeoutMs=10_000,headers={}}={}){
  const response=await fetch(url,{method,redirect:"error",signal:AbortSignal.timeout(timeoutMs),headers:{Authorization:`Key ${key}`,...headers,
    ...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})}).catch(()=>{throw new FalTurboError("fal_request_uncertain");});
  if(!response.ok)throw new FalTurboError(`fal_http_${response.status}`);
  return readJson(response);
}

export async function submitFalTurbo(key,snapshot,startImageUrl,endImageUrl){
  if(typeof key!=="string"||!key)throw new FalTurboError("fal_key_missing");
  const body=falInput(snapshot,startImageUrl,endImageUrl);
  const result=await falFetch(`${QUEUE_ORIGIN}/${MODEL}`,key,{method:"POST",timeoutMs:10_000,body,headers:{
    "X-Fal-No-Retry":"1","x-app-fal-disable-fallback":"true","X-Fal-Store-IO":"0","X-Fal-Request-Start-Timeout":"2400",
    "X-Fal-Object-Lifecycle-Preference":JSON.stringify({expiration_duration_seconds:3600,initial_acl:{default:"forbid",rules:[]}}),
  }});
  const requestId=falRequestId(result?.request_id);
  if(!requestId)throw new FalTurboError("fal_request_id_missing");
  return {requestId};
}

export async function falTurboStatus(key,requestId){
  const status=await falFetch(falStatusUrl(requestId),key);
  if(!["IN_QUEUE","IN_PROGRESS","COMPLETED"].includes(status?.status)||status.request_id!==requestId)
    throw new FalTurboError("fal_status_invalid");
  return status;
}

export async function falTurboResult(key,requestId){
  const result=await falFetch(falResultUrl(requestId),key,{timeoutMs:20_000});
  if(result?.request_id&&result.request_id!==requestId)throw new FalTurboError("fal_result_request_mismatch");
  return result;
}

export async function cancelFalTurbo(key,requestId){
  const response=await fetch(falCancelUrl(requestId),{method:"PUT",redirect:"error",signal:AbortSignal.timeout(10_000),headers:{Authorization:`Key ${key}`}})
    .catch(()=>{throw new FalTurboError("fal_cancel_uncertain");});
  if(![200,202,400,404].includes(response.status))throw new FalTurboError(`fal_cancel_http_${response.status}`);
  const result=await readJson(response);
  return {httpStatus:response.status,status:result?.status};
}

export async function falCdnReadToken(key){
  const result=await falFetch("https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3",key,{method:"POST",body:{expiration_seconds:300}});
  if(typeof result?.token!=="string"||result.token.length<20||result.token.length>8192)throw new FalTurboError("fal_cdn_token_invalid");
  return result.token;
}
