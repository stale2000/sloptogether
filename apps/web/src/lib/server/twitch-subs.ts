import { ApiError } from "./http";
import { twitchCredentials } from "./twitch";

export type TwitchScope = "openid" | "user:read:email" | "user:read:moderated_channels" | "moderation:read" | "channel:read:subscriptions" | "channel:manage:polls" | "channel:manage:redemptions" | "user:read:chat" | "user:write:chat" | "user:bot" | "channel:bot";

const approvedScopes=new Set<TwitchScope>([
  "openid","user:read:email","user:read:moderated_channels","moderation:read",
  "channel:read:subscriptions","channel:manage:polls","channel:manage:redemptions",
  "user:read:chat","user:write:chat","user:bot","channel:bot",
]);

export function parseTwitchScopes(raw:string|null):TwitchScope[]{
  const values=[...(raw??"openid user:read:moderated_channels").split(/[,+\s]+/)].filter(Boolean);
  for(const value of values)if(!approvedScopes.has(value as TwitchScope))throw new ApiError(400,"unsupported_twitch_scope");
  return [...new Set(values as TwitchScope[])];
}

export async function getModeratedChannelIds(accessToken:string,userId:string):Promise<Set<string>>{
  const credentials=twitchCredentials();
  const ids=new Set<string>();
  let cursor:string|undefined;
  for(let page=0;page<5;page++){
    const url=new URL("https://api.twitch.tv/helix/moderation/channels");
    url.searchParams.set("user_id",userId);url.searchParams.set("first","100");if(cursor)url.searchParams.set("after",cursor);
    const response=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(8000),headers:{"Client-Id":credentials.clientId,Authorization:`Bearer ${accessToken}`} });
    if(!response.ok)throw new ApiError(response.status===401?401:502,"moderator_lookup_failed","Twitch moderator status could not be refreshed.");
    const value=await response.json() as {data?:Array<{broadcaster_id?:string}>;pagination?:{cursor?:string}};
    for(const row of value.data??[])if(row.broadcaster_id)ids.add(row.broadcaster_id);
    cursor=value.pagination?.cursor;if(!cursor)break;
  }
  return ids;
}
