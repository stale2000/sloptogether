import { createHash } from "node:crypto";
import { PoolClient } from "pg";
import { ApiError } from "./http";
import { query } from "./db";

export type InputDecision = "clear" | "held" | "pending";

export interface InputPreflightInput {
  channelId: string;
  prompt: string;
  images: Array<{ bytes: Buffer; contentType: string }>;
}

export interface InputPreflightResult {
  decision: InputDecision;
  digest: string;
  promptDigest: string;
  imageDigests: string[];
  moderationId?: string;
  categories?: Record<string, boolean>;
  appliedInputTypes?: Record<string, string[]>;
  model: string;
}

export async function inputAsset(channelId:string,assetId:string,actor:string):Promise<{assetId:string;bytes:Buffer;contentType:string}> {
  const result=await query<{id:string;storage_key:string;content_type:string|null;status:string;uploaded_by_twitch_user_id:string|null}>(
    `SELECT id,storage_key,content_type,status,uploaded_by_twitch_user_id FROM sloptogether.assets
      WHERE id=$1 AND twitch_channel_id=$2 AND media_kind='image' AND status IN ('quarantine','validated','approved')`,
    [assetId,channelId],
  );
  const asset=result.rows[0];
  if(!asset)throw new ApiError(404,"image_asset_not_found");
  if(asset.uploaded_by_twitch_user_id!==actor)throw new ApiError(403,"image_asset_owner_required");
  if(!asset.content_type)throw new ApiError(415,"image_type_not_supported");
  const {signedPrivateReadUrl}=await import("./storage");
  const response=await fetch(await signedPrivateReadUrl(asset.storage_key,60),{cache:"no-store",signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new ApiError(503,"image_asset_unavailable");
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length>16*1024*1024)throw new ApiError(413,"image_too_large");
  return {assetId:asset.id,bytes,contentType:asset.content_type};
}

function sha(data: Buffer|string) { return createHash("sha256").update(data).digest(); }
function categoriesRecord(value: unknown): Record<string,boolean> {
  if(!value || typeof value!=="object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([,v])=>typeof v==="boolean")) as Record<string,boolean>;
}
function appliedRecord(value: unknown): Record<string,string[]> {
  if(!value || typeof value!=="object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([,v])=>Array.isArray(v)).map(([k,v])=>[k,(v as unknown[]).filter((x):x is string=>typeof x==="string")])) as Record<string,string[]>;
}

export async function screenPromptAndImages(input:InputPreflightInput):Promise<InputPreflightResult>{
  const prompt=input.prompt.trim();
  if(!prompt || prompt.length>12_000) throw new ApiError(400,"prompt_length_invalid");
  if(input.images.length>8) throw new ApiError(413,"too_many_reference_images");
  const imageDigests=input.images.map(({bytes,contentType})=>{
    if(!["image/png","image/jpeg","image/webp"].includes(contentType)) throw new ApiError(415,"image_type_not_supported");
    if(bytes.length>16*1024*1024) throw new ApiError(413,"image_too_large");
    return sha(bytes);
  });
  const promptDigest=sha(prompt);
  const model="omni-moderation-latest";
  const policyRevision=1;
  const digest=sha(Buffer.concat([promptDigest,...imageDigests]));
  const cached=await query<{automated_state:string;category_flags:Record<string,boolean>;applied_input_types:Record<string,string[]>;provider_result_id:string|null}>(
    `SELECT automated_state,category_flags,applied_input_types,provider_result_id
       FROM sloptogether.input_screens WHERE twitch_channel_id=$1 AND input_sha256=$2
        AND moderation_model=$3 AND moderation_policy_revision=$4
        AND expires_at>now() ORDER BY created_at DESC LIMIT 1`,
    [input.channelId,digest,model,policyRevision],
  );
  const existing=cached.rows[0];
  if(existing && existing.automated_state==="clear") return {
    decision:"clear",digest:digest.toString("hex"),promptDigest:promptDigest.toString("hex"),
    imageDigests:imageDigests.map(x=>x.toString("hex")),categories:existing.category_flags,
    appliedInputTypes:existing.applied_input_types,moderationId:existing.provider_result_id??undefined,model,
  };

  const apiKey=process.env.SLOPTOGETHER_OPENAI_MODERATION_KEY;
  if(!apiKey) throw new ApiError(503,"input_moderation_not_configured","Automated input screening is not configured.");
  const groups=input.images.length?input.images.map(({bytes,contentType})=>[
    {type:"text",text:prompt},
    {type:"image_url",image_url:{url:`data:${contentType};base64,${bytes.toString("base64")}`}},
  ]):[[{type:"text",text:prompt}]];
  const results:Array<{id?:string;flagged:boolean;categories?:unknown;category_applied_input_types?:unknown}>=[];
  try{
    for(const inputParts of groups){
      const response=await fetch("https://api.openai.com/v1/moderations",{
        method:"POST",signal:AbortSignal.timeout(4_000),cache:"no-store",
        headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},
        body:JSON.stringify({model,input:inputParts}),
      });
      if(!response.ok) throw new ApiError(503,"input_moderation_unavailable","Input screening is temporarily unavailable.");
      const payload=await response.json() as {id?:string;results?:Array<{flagged?:boolean;categories?:unknown;category_applied_input_types?:unknown}>};
      const result=payload.results?.[0];
      if(!result||typeof result.flagged!=="boolean")throw new ApiError(503,"input_moderation_invalid_response","Input screening returned no usable result.");
      results.push({id:payload.id,flagged:result.flagged,categories:result.categories,category_applied_input_types:result.category_applied_input_types});
    }
  }catch(error){
    if(error instanceof ApiError)throw error;
    throw new ApiError(503,"input_moderation_pending","Input screening did not finish; try again before dispatch.");
  }
  const state:InputDecision=results.some(result=>result.flagged)?"held":"clear";
  const categoryRecords=results.map(result=>categoriesRecord(result.categories));
  const categories=Object.fromEntries([...new Set(categoryRecords.flatMap(record=>Object.keys(record)))].map(key=>[key,categoryRecords.some(record=>record[key])]));
  const appliedRecords=results.map(result=>appliedRecord(result.category_applied_input_types));
  const appliedInputTypes=Object.fromEntries([...new Set(appliedRecords.flatMap(record=>Object.keys(record)))].map(key=>[key,[...new Set(appliedRecords.flatMap(record=>record[key]??[]))]]));
  const moderationId=results.map(result=>result.id).filter((id):id is string=>Boolean(id)).join(",")||undefined;
  await query(
    `INSERT INTO sloptogether.input_screens
      (twitch_channel_id,input_sha256,prompt_sha256,image_sha256s,moderation_model,moderation_policy_revision,
       provider_result_id,category_flags,applied_input_types,automated_state,effective_state,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,now()+interval '1 day')`,
    [input.channelId,digest,promptDigest,imageDigests.map(x=>x.toString("hex")),model,policyRevision,moderationId??null,
      JSON.stringify(categories),JSON.stringify(appliedInputTypes),state],
  );
  return {decision:state,digest:digest.toString("hex"),promptDigest:promptDigest.toString("hex"),
    imageDigests:imageDigests.map(x=>x.toString("hex")),moderationId,categories,appliedInputTypes,model};
}

export async function authorizeManualInputResolution(
  client:PoolClient,
  inputScreenId:string,
  actor:string,
  reason:string,
  decision:"clear"|"reject",
){
  const result=await client.query(
    `UPDATE sloptogether.input_screens SET effective_state=$3,manual_resolution_by=$2,manual_resolution_reason=$4
     WHERE id=$1 AND automated_state IN ('held','pending','error') RETURNING id`,
    [inputScreenId,actor,decision==="clear"?"clear":"held",reason.slice(0,500)],
  );
  if(!result.rowCount)throw new ApiError(409,"input_screen_not_resolvable");
  await client.query(`INSERT INTO sloptogether.audit_log(action,target_kind,target_id,actor_twitch_user_id,reason,after_state)
    VALUES($1,'input_screen',$2,$3,$4,$5::jsonb)`,[
      decision==="clear"?"input.screen_manual_clear":"input.screen_reject",inputScreenId,actor,reason.slice(0,500),JSON.stringify({effectiveState:decision}),
    ]);
}
