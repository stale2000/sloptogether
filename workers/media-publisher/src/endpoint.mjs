import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const MODEL="omni-moderation-latest";
const execFileAsync=promisify(execFile);
const JPEG_SOF_MARKERS=new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
const DEFAULT_FRAME_LIMIT=16*1024*1024;

export function moderationKeyFrom(env=process.env){
  const dedicated=typeof env.SLOPTOGETHER_OPENAI_MODERATION_KEY==="string"?env.SLOPTOGETHER_OPENAI_MODERATION_KEY.trim():"";
  return dedicated||null;
}

export class EndpointUnavailableError extends Error{
  constructor(code,message=code){super(message);this.name="EndpointUnavailableError";this.code=code;}
}

function sha(bytes){return createHash("sha256").update(bytes).digest()}

/** Must match preflight.ts: hash the trimmed prompt digest followed by image digests. */
export function deriveInputDigests(prompt,images){
  const normalized=typeof prompt==="string"?prompt.trim():"";
  if(!normalized||normalized.length>12_000)throw new EndpointUnavailableError("endpoint_prompt_invalid");
  if(!Array.isArray(images)||images.length<1||images.length>8)throw new EndpointUnavailableError("endpoint_images_invalid");
  const promptDigest=sha(Buffer.from(normalized,"utf8"));
  const imageDigests=images.map(image=>{
    if(!image||!Buffer.isBuffer(image.bytes)||image.bytes.length<1||image.bytes.length>DEFAULT_FRAME_LIMIT
      ||!(["image/png","image/jpeg","image/webp"].includes(image.contentType)))throw new EndpointUnavailableError("endpoint_image_invalid");
    return sha(image.bytes);
  });
  const digest=sha(Buffer.concat([promptDigest,...imageDigests]));
  return {prompt:normalized,digest:digest.toString("hex"),promptDigest:promptDigest.toString("hex"),imageDigests:imageDigests.map(value=>value.toString("hex"))};
}

export function parseJpegDimensions(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length<4||bytes[0]!==0xff||bytes[1]!==0xd8)
    throw new EndpointUnavailableError("endpoint_jpeg_invalid");
  let offset=2;
  while(offset+4<=bytes.length){
    if(bytes[offset]!==0xff){offset++;continue}
    while(offset<bytes.length&&bytes[offset]===0xff)offset++;
    if(offset>=bytes.length)break;
    const marker=bytes[offset++];
    if(marker===0xd9||marker===0xda)break;
    if(marker===0xd8||marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
    if(offset+2>bytes.length)break;
    const segmentLength=bytes.readUInt16BE(offset);
    if(segmentLength<2||offset+segmentLength>bytes.length)break;
    if(JPEG_SOF_MARKERS.has(marker)&&segmentLength>=8){
      const height=bytes.readUInt16BE(offset+3),width=bytes.readUInt16BE(offset+5);
      if(width<64||height<64||width>8192||height>8192||width*height>32_000_000)
        throw new EndpointUnavailableError("endpoint_dimensions_invalid");
      return {width,height};
    }
    offset+=segmentLength;
  }
  throw new EndpointUnavailableError("endpoint_jpeg_dimensions_missing");
}

export function validateEndpointFrame(bytes,options={}){
  const maxBytes=Number.isSafeInteger(options.maxBytes)&&options.maxBytes>0?Math.min(options.maxBytes,DEFAULT_FRAME_LIMIT):DEFAULT_FRAME_LIMIT;
  if(!Buffer.isBuffer(bytes)||bytes.length<4||bytes.length>maxBytes)throw new EndpointUnavailableError("endpoint_frame_size_invalid");
  const dimensions=parseJpegDimensions(bytes);
  if(options.width!==undefined&&dimensions.width!==Number(options.width))throw new EndpointUnavailableError("endpoint_width_mismatch");
  if(options.height!==undefined&&dimensions.height!==Number(options.height))throw new EndpointUnavailableError("endpoint_height_mismatch");
  return {...dimensions,byteSize:bytes.length,contentType:"image/jpeg"};
}

function categoriesRecord(value){
  if(!value||typeof value!=="object"||Array.isArray(value))return {};
  return Object.fromEntries(Object.entries(value).filter(([,flag])=>typeof flag==="boolean"));
}

function appliedTypesRecord(value){
  if(!value||typeof value!=="object"||Array.isArray(value))return {};
  return Object.fromEntries(Object.entries(value).filter(([,types])=>Array.isArray(types))
    .map(([key,types])=>[key,types.filter(type=>typeof type==="string")]));
}

function unavailable(code,digests){
  return {decision:"unavailable",unavailableCode:code,model:MODEL,...(digests??{}),categories:{},appliedInputTypes:{}};
}

export async function moderateEndpointPrompt({prompt,imageBytes,apiKey=process.env.SLOPTOGETHER_OPENAI_MODERATION_KEY,fetchImpl=fetch,timeoutMs=4000}){
  let digests,frame;
  try{frame=validateEndpointFrame(imageBytes);digests=deriveInputDigests(prompt,[{bytes:imageBytes,contentType:"image/jpeg"}]);}
  catch(error){return unavailable(error?.code??"endpoint_input_invalid")}
  if(!apiKey)return {...unavailable("input_moderation_not_configured",digests),...frame};
  const input=[{type:"text",text:digests.prompt},{type:"image_url",image_url:{url:`data:image/jpeg;base64,${imageBytes.toString("base64")}`}}];
  try{
    const response=await fetchImpl("https://api.openai.com/v1/moderations",{
      method:"POST",cache:"no-store",signal:AbortSignal.timeout(timeoutMs),
      headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},
      body:JSON.stringify({model:MODEL,input}),
    });
    if(!response.ok)return {...unavailable("input_moderation_unavailable",digests),...frame};
    const payload=await response.json();
    const result=payload?.results?.[0];
    if(!result||typeof result.flagged!=="boolean")return {...unavailable("input_moderation_invalid_response",digests),...frame};
    return {
      decision:result.flagged?"held":"clear",
      model:MODEL,
      moderationId:typeof payload.id==="string"?payload.id:undefined,
      categories:categoriesRecord(result.categories),
      appliedInputTypes:appliedTypesRecord(result.category_applied_input_types),
      ...digests,
      ...frame,
    };
  }catch{
    return {...unavailable("input_moderation_pending",digests),...frame};
  }
}

function boundedSettings(config){
  const maxBytes=Number.isSafeInteger(config?.maxFrameBytes)&&config.maxFrameBytes>0?Math.min(config.maxFrameBytes,DEFAULT_FRAME_LIMIT):DEFAULT_FRAME_LIMIT;
  const timeoutMs=Number.isSafeInteger(config?.timeoutMs)&&config.timeoutMs>=1000?Math.min(config.timeoutMs,120_000):30_000;
  return {ffmpeg:config?.ffmpeg??"ffmpeg",ffprobe:config?.ffprobe??"ffprobe",maxBytes,timeoutMs,tempDir:config?.tempDir??tmpdir()};
}

/** Extract the frame closest to the clip's end through a bounded stdout-to-file pipe. */
export async function extractEndpointFrame({videoPath,outputPath,config={},spawnImpl=spawn,execFileImpl=execFileAsync}){
  if(typeof videoPath!=="string"||!videoPath||typeof outputPath!=="string"||!outputPath)
    throw new EndpointUnavailableError("endpoint_path_invalid");
  const settings=boundedSettings(config);
  let frameCount;
  try{
    const probe=await execFileImpl(settings.ffprobe,["-v","error","-select_streams","v:0","-count_frames","-show_entries","stream=nb_read_frames","-of","default=noprint_wrappers=1:nokey=1",videoPath],
      {timeout:settings.timeoutMs,maxBuffer:64*1024,windowsHide:true});
    frameCount=Number(String(probe.stdout??"").trim());
    if(!Number.isSafeInteger(frameCount)||frameCount<1||frameCount>100_000)throw new Error("frame_count_invalid");
  }catch(error){
    if(error?.code==="ENOENT")throw new EndpointUnavailableError("endpoint_ffprobe_missing");
    if(error?.code==="ETIMEDOUT"||error?.killed)throw new EndpointUnavailableError("endpoint_frame_count_timeout");
    throw new EndpointUnavailableError("endpoint_frame_count_unavailable");
  }
  const filter=`select=eq(n\\,${frameCount-1})`;
  const args=["-hide_banner","-nostdin","-v","error","-xerror","-i",videoPath,
    "-map","0:v:0","-vf",filter,"-frames:v","1","-fps_mode","passthrough","-f","image2pipe","-vcodec","mjpeg","-q:v","2","pipe:1"];
  const child=spawnImpl(settings.ffmpeg,args,{stdio:["ignore","pipe","pipe"],windowsHide:true});
  let timedOut=false,tooLarge=false;
  const timeout=setTimeout(()=>{timedOut=true;child.kill("SIGTERM");setTimeout(()=>child.kill("SIGKILL"),1000).unref()},settings.timeoutMs);
  let bytes=0;
  const bounded=new Transform({transform(chunk,_encoding,callback){
    bytes+=chunk.length;
    if(bytes>settings.maxBytes){tooLarge=true;child.kill("SIGTERM");return callback(new EndpointUnavailableError("endpoint_frame_size_invalid"));}
    callback(null,chunk);
  }});
  try{
    const exit=new Promise((resolve,reject)=>{
      child.once("error",reject);
      child.once("close",(code,signal)=>code===0?resolve():reject(Object.assign(new Error("ffmpeg_endpoint_extract_failed"),{code,signal})));
    });
    await Promise.all([pipeline(child.stdout,bounded,createWriteStream(outputPath,{flags:"wx"})),exit]);
    if(!bytes)throw new EndpointUnavailableError("endpoint_frame_empty");
    const info=await stat(outputPath);
    const frameBytes=await readFile(outputPath);
    if(info.size!==frameBytes.length)throw new EndpointUnavailableError("endpoint_frame_size_invalid");
    return {framePath:outputPath,frameBytes,...validateEndpointFrame(frameBytes,{maxBytes:settings.maxBytes})};
  }catch(error){
    if(error instanceof EndpointUnavailableError)throw error;
    if(timedOut)throw new EndpointUnavailableError("endpoint_frame_timeout");
    if(tooLarge)throw new EndpointUnavailableError("endpoint_frame_size_invalid");
    const code=error?.code;
    if(code==="ENOENT")throw new EndpointUnavailableError("endpoint_ffmpeg_missing");
    throw new EndpointUnavailableError("endpoint_frame_extraction_failed");
  }finally{clearTimeout(timeout)}
}

/** Extract and screen an outgoing endpoint; moderation outages never reject the already-approved clip. */
export async function extractAndScreenEndpoint({videoPath,prompt,config={},apiKey=process.env.OPENAI_API_KEY,fetchImpl=fetch,spawnImpl=spawn,execFileImpl=execFileAsync}){
  const settings=boundedSettings(config);
  const directory=await mkdtemp(join(settings.tempDir,"sloptogether-endpoint-"));
  try{
    const frame=await extractEndpointFrame({videoPath,outputPath:join(directory,"endpoint.jpg"),config:settings,spawnImpl,execFileImpl});
    const moderation=await moderateEndpointPrompt({prompt,imageBytes:frame.frameBytes,apiKey,fetchImpl});
    const {framePath:_framePath,...publicFrame}=frame;
    return {...moderation,...publicFrame};
  }catch(error){
    if(error instanceof EndpointUnavailableError)return unavailable(error.code);
    return unavailable("endpoint_frame_unavailable");
  }finally{await rm(directory,{recursive:true,force:true}).catch(()=>undefined)}
}
