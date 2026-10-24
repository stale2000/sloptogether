import { createHash } from "node:crypto";
import { query } from "./db";
import { hashWorkerSecret, constantTimeEqual } from "./crypto";
import { currentSession, readCookie, type UserSession } from "./session";
import { ApiError } from "./http";
import { verifyExtensionRequest, type ExtensionPrincipal } from "./extension-auth";

export type WorkerGrant = {
  keyId: string;
  issuingTwitchUserId: string;
  channelId: string;
  scopes: string[];
  roles: string[];
  recipes: string[];
  paired: boolean;
  platform: "windows" | "wsl" | "linux" | "fal" | null;
};

export type RequestPrincipal =
  | { kind:"session";session:UserSession }
  | { kind:"extension";extension:ExtensionPrincipal }
  | { kind:"chat";channelId:string;twitchUserId:string }
  | { kind:"worker-key";worker:WorkerGrant }
  | { kind:"worker-device";deviceId:string;twitchUserId:string;roles:string[] };

function extensionToken(request:Request){
  const explicit=request.headers.get("x-extension-jwt");
  if(explicit)return explicit;
  const bearer=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"");
  return bearer&&bearer.split(".").length===3?bearer:undefined;
}

async function workerKeyPrincipal(request:Request):Promise<WorkerGrant|null>{
  const authorization=request.headers.get("authorization")??"";
  const raw=authorization.startsWith("SlopWorker ")
    ? authorization.slice("SlopWorker ".length).trim()
    : authorization.replace(/^Bearer\s+/i,"").trim();
  if(!raw.startsWith("slw_"))return null;
  const match=/^slw_([0-9a-f-]{36})\.([A-Za-z0-9_-]{32,})$/.exec(raw);
  if(!match)throw new ApiError(401,"worker_credential_invalid");
  const result=await query<{key_id:string;secret_hash:Buffer;issuing_twitch_user_id:string;twitch_channel_id:string;scopes:string[];worker_roles:string[];recipe_ids:string[];expires_at:Date|null;revoked_at:Date|null;paired:boolean;platform:"windows"|"wsl"|"linux"|"fal"|null}>(
    `SELECT k.key_id,k.secret_hash,k.issuing_twitch_user_id,k.twitch_channel_id,k.scopes,k.worker_roles,k.recipe_ids,k.expires_at,k.revoked_at,
       (wp.id IS NOT NULL) AS paired,wp.requested_device->>'platform' AS platform
     FROM sloptogether.application_keys k
     LEFT JOIN sloptogether.worker_pairings wp ON wp.id=k.key_id AND wp.approved_at IS NOT NULL
     WHERE k.key_id=$1`,[match[1]],
  );
  const row=result.rows[0];
  if(!row || row.revoked_at || (row.expires_at && row.expires_at.getTime()<=Date.now()))throw new ApiError(401,"worker_credential_revoked");
  const actual=hashWorkerSecret(raw);
  if(!constantTimeEqual(actual,row.secret_hash))throw new ApiError(401,"worker_credential_invalid");
  await query("UPDATE sloptogether.application_keys SET last_used_at=now() WHERE key_id=$1",[row.key_id]);
  return {keyId:row.key_id,issuingTwitchUserId:row.issuing_twitch_user_id,channelId:row.twitch_channel_id,scopes:row.scopes,roles:row.worker_roles,recipes:row.recipe_ids,paired:row.paired,platform:row.platform};
}

export async function requestPrincipal(request:Request):Promise<RequestPrincipal|null>{
  if(extensionToken(request))return {kind:"extension",extension:verifyExtensionRequest(request)};
  const worker=await workerKeyPrincipal(request);
  if(worker)return {kind:"worker-key",worker};
  const device=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"");
  if(device?.startsWith("sld_")){
    const tokenHash=createHash("sha256").update(device).digest();
    const result=await query<{id:string;twitch_user_id:string;roles:string[];status:string}>(
      `SELECT id,twitch_user_id,roles,status FROM sloptogether.worker_devices
       WHERE credential_hash=$1 AND revoked_at IS NULL`,[tokenHash],
    );
    const row=result.rows[0];
    if(!row||row.status!=="paired")throw new ApiError(401,"worker_device_revoked");
    return {kind:"worker-device",deviceId:row.id,twitchUserId:row.twitch_user_id,roles:row.roles};
  }
  const session=await currentSession(request);
  return session?{kind:"session",session}:null;
}

export function requireKeyScope(grant:WorkerGrant,scope:string){
  if(!grant.scopes.includes(scope))throw new ApiError(403,"worker_key_scope_denied");
}

export function readSessionCookie(request:Request){
  return readCookie(request.headers.get("cookie")??"","slop_sid");
}
