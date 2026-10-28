import "server-only";

import { HttpError } from "./http";
import { decryptSecret, encryptSecret } from "./crypto";

const twitchClientId = () => process.env.TWITCH_CLIENT_ID;
const twitchClientSecret = () => process.env.TWITCH_CLIENT_SECRET;
let extensionAppToken:{value:string;expiresAt:number}|null=null;

export function twitchCallbackUrl(): string {
  const base = process.env.PUBLIC_APP_URL;
  if (!base) throw new HttpError(503, "twitch_not_configured", "Twitch sign-in is not configured.");
  return `${base.replace(/\/$/, "")}/api/v1/auth/twitch/callback`;
}

export function twitchCredentials(): { clientId: string; clientSecret: string } {
  const clientId = twitchClientId();
  const clientSecret = twitchClientSecret();
  if (!clientId || !clientSecret) throw new HttpError(503, "twitch_not_configured", "Twitch sign-in is not configured.");
  return { clientId, clientSecret };
}

export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
  profile_image_url?: string;
}

async function twitchJson<T>(url: string, accessToken?: string, init?: RequestInit): Promise<T> {
  const credentials = twitchCredentials();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "Client-Id": credentials.clientId,
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new HttpError(response.status === 401 ? 401 : 502, "twitch_api_failed", "Twitch could not confirm the request.");
    }
    return await response.json() as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "twitch_unavailable", "Twitch is temporarily unavailable.");
  } finally {
    clearTimeout(timeout);
  }
}

export interface TwitchTokenSet {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string[];
  token_type: string;
}

export async function exchangeCode(code: string, redirectUri: string): Promise<TwitchTokenSet> {
  const credentials = twitchCredentials();
  return twitchJson<TwitchTokenSet>("https://id.twitch.tv/oauth2/token", undefined, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
}

export async function refreshToken(token: string): Promise<TwitchTokenSet> {
  const credentials = twitchCredentials();
  return twitchJson<TwitchTokenSet>("https://id.twitch.tv/oauth2/token", undefined, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: "refresh_token",
      refresh_token: token,
    }),
  });
}

export async function appAccessToken():Promise<string>{
  const {clientId,clientSecret}=twitchCredentials();
  const response=await fetch("https://id.twitch.tv/oauth2/token",{
    method:"POST",cache:"no-store",signal:AbortSignal.timeout(8000),
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,grant_type:"client_credentials"}),
  });
  if(!response.ok)throw new HttpError(502,"twitch_app_token_failed","Twitch authorization is temporarily unavailable.");
  const value=await response.json() as {access_token?:string;token_type?:string};
  if(typeof value.access_token!=="string"||value.token_type?.toLowerCase()!=="bearer")throw new HttpError(502,"twitch_app_token_invalid");
  return value.access_token;
}

export function twitchExtensionClientId(){
  const id=process.env.TWITCH_EXTENSION_CLIENT_ID;
  if(!id)throw new HttpError(503,"extension_not_configured","TWITCH_EXTENSION_CLIENT_ID is not configured.");
  return id;
}

export async function extensionAppAccessToken():Promise<string>{
  if(extensionAppToken&&extensionAppToken.expiresAt>Date.now()+30_000)return extensionAppToken.value;
  const clientId=twitchExtensionClientId(),clientSecret=process.env.TWITCH_EXTENSION_CLIENT_SECRET;
  if(!clientSecret)throw new HttpError(503,"extension_bits_not_configured","TWITCH_EXTENSION_CLIENT_SECRET is not configured.");
  const response=await fetch("https://id.twitch.tv/oauth2/token",{
    method:"POST",cache:"no-store",signal:AbortSignal.timeout(8000),
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,grant_type:"client_credentials"}),
  });
  if(!response.ok)throw new HttpError(502,"extension_app_token_failed","Twitch transaction verification is temporarily unavailable.");
  const value=await response.json() as {access_token?:string;token_type?:string;expires_in?:number};
  if(typeof value.access_token!=="string"||value.token_type?.toLowerCase()!=="bearer"||!Number.isFinite(value.expires_in))
    throw new HttpError(502,"extension_app_token_invalid");
  extensionAppToken={value:value.access_token,expiresAt:Date.now()+Number(value.expires_in)*1000};
  return value.access_token;
}

export interface VerifiedExtensionTransaction {
  id:string;timestamp:Date;broadcasterId:string;userId:string;sku:string;amountBits:number;inDevelopment:boolean;
}

interface ExtensionTransactionApiRow {
  id?:string;timestamp?:string;broadcaster_id?:string;user_id?:string;product_type?:string;
  product_data?:{sku?:string;cost?:{amount?:number;type?:string};inDevelopment?:boolean};
}

export interface ExtensionBitsProduct {sku:string;amountBits:number;inDevelopment:boolean;displayName:string}

export async function listExtensionBitsProducts():Promise<ExtensionBitsProduct[]>{
  const extensionId=twitchExtensionClientId(),token=await extensionAppAccessToken();
  const response=await fetch("https://api.twitch.tv/helix/bits/extensions",{
    headers:{"Client-Id":extensionId,Authorization:`Bearer ${token}`},cache:"no-store",signal:AbortSignal.timeout(8000),
  });
  if(!response.ok)throw new HttpError(response.status===401?401:502,"extension_bits_catalog_failed");
  const result=await response.json() as {data?:Array<{sku?:string;cost?:{amount?:number;type?:string};in_development?:boolean;display_name?:string}>};
  return (result.data??[]).filter(row=>typeof row.sku==="string"&&/^[A-Za-z0-9._-]{1,255}$/.test(row.sku)
    &&Number.isSafeInteger(row.cost?.amount)&&row.cost!.amount!>0&&row.cost?.type==="bits"&&typeof row.in_development==="boolean"
    &&typeof row.display_name==="string").map(row=>({sku:row.sku!,amountBits:row.cost!.amount!,inDevelopment:row.in_development!,displayName:row.display_name!}));
}

export async function getExtensionTransaction(transactionId:string):Promise<VerifiedExtensionTransaction>{
  const extensionId=twitchExtensionClientId(),token=await extensionAppAccessToken();
  const url=new URL("https://api.twitch.tv/helix/extensions/transactions");
  url.searchParams.set("extension_id",extensionId);url.searchParams.append("id",transactionId);
  const response=await fetch(url,{headers:{"Client-Id":extensionId,Authorization:`Bearer ${token}`},cache:"no-store",signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new HttpError(response.status===404?404:502,"extension_transaction_lookup_failed");
  const result=await response.json() as {data?:ExtensionTransactionApiRow[]};
  const row=result.data?.find(item=>item.id===transactionId);
  const timestamp=Date.parse(row?.timestamp??"");
  if(!row||row.product_type!=="BITS_IN_EXTENSION"||!Number.isFinite(timestamp)||typeof row.broadcaster_id!=="string"||!/^[0-9]{1,32}$/.test(row.broadcaster_id)
    ||typeof row.user_id!=="string"||!/^[0-9]{1,32}$/.test(row.user_id)||typeof row.product_data?.sku!=="string"
    ||!Number.isSafeInteger(row.product_data.cost?.amount)||row.product_data.cost?.type!=="bits"||typeof row.product_data.inDevelopment!=="boolean")
    throw new HttpError(502,"extension_transaction_invalid");
  return {id:row.id!,timestamp:new Date(timestamp),broadcasterId:row.broadcaster_id,userId:row.user_id,sku:row.product_data.sku,
    amountBits:row.product_data.cost!.amount!,inDevelopment:row.product_data.inDevelopment};
}

export async function validateAccessToken(accessToken: string): Promise<{ user_id: string; login: string; client_id: string; scopes: string[]; expires_in: number }> {
  const credentials = twitchCredentials();
  const response = await fetch("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: `OAuth ${accessToken}`, "Client-Id": credentials.clientId },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    if(response.status===401)throw new HttpError(401,"twitch_session_revoked","Reconnect your Twitch account.");
    if(response.status===429||response.status>=500)throw new HttpError(503,"twitch_validation_unavailable","Twitch validation is temporarily unavailable.");
    throw new HttpError(502,"twitch_validation_failed","Twitch could not validate this session.");
  }
  const result = await response.json() as { user_id: string; login: string; client_id: string; scopes: string[]; expires_in: number };
  if (result.client_id !== credentials.clientId) throw new HttpError(401, "twitch_client_mismatch", "Reconnect your Twitch account.");
  return result;
}

export async function currentTwitchUser(accessToken: string): Promise<TwitchUser> {
  const result = await twitchJson<{ data: TwitchUser[] }>("https://api.twitch.tv/helix/users", accessToken);
  const user = result.data?.[0];
  if (!user?.id || !user.login) throw new HttpError(401, "twitch_user_missing", "Reconnect your Twitch account.");
  return user;
}

export function encryptTwitchTokens(tokens: TwitchTokenSet): { access: Buffer; refresh: Buffer; expiresAt: Date; scopes: string[] } {
  return {
    access: encryptSecret(tokens.access_token),
    refresh: encryptSecret(tokens.refresh_token),
    expiresAt: new Date(Date.now() + Math.max(0, tokens.expires_in - 60) * 1000),
    scopes: tokens.scope,
  };
}

export function decryptTwitchAccess(encrypted: Buffer): string {
  return decryptSecret(encrypted);
}

export function buildAuthorizeUrl(state: string, redirectUri: string, scopes: string[]): URL {
  const { clientId } = twitchCredentials();
  const target = new URL("https://id.twitch.tv/oauth2/authorize");
  target.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [...new Set(scopes)].join(" "),
    state,
    force_verify: "true",
  }).toString();
  return target;
}
