import { randomSecret, hash } from "./crypto";
import { transaction } from "./db";
import { HttpError } from "./http";
import { publicAppUrl } from "./database";
import { currentTwitchUser, exchangeCode, twitchCallbackUrl, validateAccessToken, buildAuthorizeUrl } from "./twitch";
import { issueUserSession, sessionCookieOptions, readCookie } from "./session";
import { parseTwitchScopes } from "./twitch-subs";
import { NextResponse } from "next/server";

const STATE_COOKIE="slop_oauth_state";
const STATE_COOKIE_PATH="/sloptogether/api/v1/auth/twitch";
const DEFAULT_RETURN="/sloptogether/control";

function safeReturnPath(raw:string|null){
  if(!raw)return DEFAULT_RETURN;
  if(!raw.startsWith("/sloptogether/")||raw.startsWith("//")||raw.includes("\\"))return DEFAULT_RETURN;
  try {
    const parsed=new URL(raw,publicAppUrl());
    if(parsed.origin!==publicAppUrl().origin||!parsed.pathname.startsWith("/sloptogether/"))return DEFAULT_RETURN;
    return parsed.pathname+parsed.search;
  }catch{return DEFAULT_RETURN;}
}

export async function startTwitchOAuth(request:Request):Promise<Response>{
  const url=new URL(request.url);
  const state=randomSecret(32);
  const browserNonce=randomSecret(32);
  const scopes=parseTwitchScopes(url.searchParams.get("scope"));
  const returnPath=safeReturnPath(url.searchParams.get("return_to"));
  const expiration=new Date(Date.now()+10*60*1000);
  await transaction(async client=>{
    await client.query("DELETE FROM sloptogether.oauth_states WHERE expires_at<now() OR consumed_at IS NOT NULL");
    await client.query(
      `INSERT INTO sloptogether.oauth_states(state_hash,browser_nonce_hash,return_path,expires_at)
       VALUES($1,$2,$3,$4)`,[hash(state),hash(browserNonce),returnPath,expiration],
    );
  });
  const destination=buildAuthorizeUrl(state,twitchCallbackUrl(),scopes);
  const response=NextResponse.redirect(destination);
  response.cookies.set(STATE_COOKIE,`${state}.${browserNonce}`,{
    httpOnly:true,secure:publicAppUrl().protocol==="https:",sameSite:"lax",path:STATE_COOKIE_PATH,
    maxAge:10*60,
  });
  return response;
}

export async function completeTwitchOAuth(request:Request):Promise<Response>{
  const url=new URL(request.url);
  const cookie=readCookie(request.headers.get("cookie")??"",STATE_COOKIE);
  const providedState=url.searchParams.get("state")??"";
  const code=url.searchParams.get("code");
  if(url.searchParams.has("error"))throw new HttpError(400,"twitch_login_denied","Twitch sign-in was cancelled.");
  const pieces=cookie?.split(".")??[];
  if(!code||!providedState||pieces.length!==2)throw new HttpError(400,"oauth_state_missing","Sign-in expired. Please try again.");
  const [cookieState,nonce]=pieces as [string,string];
  const left=Buffer.from(providedState,"utf8");const right=Buffer.from(cookieState,"utf8");
  const {constantTimeEqual}=await import("./crypto");
  if(!constantTimeEqual(left,right))throw new HttpError(400,"oauth_state_invalid","Sign-in verification failed.");

  const consumed=await transaction(async client=>{
    const result=await client.query<{browser_nonce_hash:Buffer;return_path:string}>(
      `UPDATE sloptogether.oauth_states SET consumed_at=now()
       WHERE state_hash=$1 AND browser_nonce_hash=$2 AND consumed_at IS NULL AND expires_at>now()
       RETURNING browser_nonce_hash,return_path`,[hash(providedState),hash(nonce)],
    );
    return result.rows[0]??null;
  });
  if(!consumed)throw new HttpError(400,"oauth_state_expired","Sign-in expired. Please try again.");

  const tokens=await exchangeCode(code,twitchCallbackUrl());
  const validated=await validateAccessToken(tokens.access_token);
  const twitchUser=await currentTwitchUser(tokens.access_token);
  if(validated.user_id!==twitchUser.id||tokens.scope.some(scope=>!validated.scopes.includes(scope)))throw new HttpError(401,"twitch_identity_mismatch");
  const issued=await transaction(async client=>{
    const result=await issueUserSession(client,{id:twitchUser.id,login:twitchUser.login,displayName:twitchUser.display_name},tokens);
    await client.query(
      `INSERT INTO sloptogether.memberships(twitch_user_id,twitch_channel_id,role,status)
       SELECT $1,$1,'broadcaster','active' WHERE EXISTS(SELECT 1 FROM sloptogether.channels WHERE twitch_channel_id=$1)
       ON CONFLICT(twitch_user_id,twitch_channel_id) DO UPDATE SET role='broadcaster',status='active',checked_at=now()`,[twitchUser.id],
    );
    return result;
  });
  const destination=new URL(consumed.return_path,publicAppUrl());
  destination.searchParams.set("connected","1");
  const response=NextResponse.redirect(destination);
  response.cookies.set(STATE_COOKIE,"",{httpOnly:true,secure:publicAppUrl().protocol==="https:",sameSite:"lax",path:STATE_COOKIE_PATH,maxAge:0});
  response.cookies.set("slop_sid",issued.token,sessionCookieOptions(issued.expiresAt));
  return response;
}
