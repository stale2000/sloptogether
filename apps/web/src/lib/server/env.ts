import { hasScopedClipsDatabaseUser,isClipsDatabase } from "./database-target";

export function requiredSecret(name: string): string {
  const value = process.env[name];
  if (!value || value.length < 32) throw new Error(`${name} is not configured or too short`);
  return value;
}

function twitchOAuthConfigured():boolean{
  const clientId=process.env.TWITCH_CLIENT_ID?.trim(),clientSecret=process.env.TWITCH_CLIENT_SECRET?.trim();
  const databaseUrl=process.env.DATABASE_URL,appUrl=process.env.PUBLIC_APP_URL,encryptionKey=process.env.SLOPTOGETHER_TOKEN_ENCRYPTION_KEY;
  if(!clientId||!clientSecret||!databaseUrl||!appUrl||!encryptionKey||encryptionKey.length<32)return false;
  try{
    const db=new URL(databaseUrl),site=new URL(appUrl),key=Buffer.from(encryptionKey,"base64");
    const sharedClipsDb=isClipsDatabase(db);
    const sharedDbAllowed=!sharedClipsDb||(process.env.SLOPTOGETHER_USE_CLIPSGG_DATABASE==="true"&&hasScopedClipsDatabaseUser(db));
    return db.protocol.startsWith("postgres")&&sharedDbAllowed
      &&(site.protocol==="https:"||site.hostname==="localhost")&&site.pathname.endsWith("/sloptogether")
      &&!site.username&&!site.password&&!site.search&&!site.hash&&key.length===32;
  }catch{return false;}
}

export function publicRuntimeStatus() {
  const objectStorage=Boolean(process.env.R2_ACCOUNT_ID&&process.env.R2_ACCESS_KEY_ID
    &&process.env.R2_SECRET_ACCESS_KEY&&process.env.R2_BUCKET_NAME);
  return {
    database: Boolean(process.env.DATABASE_URL),
    twitchOAuth: twitchOAuthConfigured(),
    openaiPreflight: Boolean(process.env.SLOPTOGETHER_OPENAI_MODERATION_KEY),
    comfyFrameGeneration: process.env.SLOPTOGETHER_COMFY_FRAME_GENERATION_ENABLED === "true"
      && Boolean(process.env.SLOPTOGETHER_COMFY_API_KEY || (process.env.NODE_ENV === "development" && process.env.COMFY_API_KEY))
      && Boolean(process.env.SLOPTOGETHER_OPENAI_MODERATION_KEY)
      && Boolean(process.env.SLOPTOGETHER_COMFY_FRAME_GENERATION_CHANNEL_IDS?.split(",").some(id=>id.trim())),
    comfyPromptGeneration: process.env.SLOPTOGETHER_COMFY_PROMPT_GENERATION_ENABLED === "true"
      && Boolean(process.env.SLOPTOGETHER_COMFY_API_KEY || (process.env.NODE_ENV === "development" && process.env.COMFY_API_KEY))
      && Boolean(process.env.SLOPTOGETHER_OPENAI_MODERATION_KEY)
      && Boolean(process.env.SLOPTOGETHER_COMFY_FRAME_GENERATION_CHANNEL_IDS?.split(",").some(id=>id.trim())),
    objectStorage,
    objectStorageMode:!objectStorage?"unconfigured":process.env.SLOPTOGETHER_LOCAL_S3_ENDPOINT?"local_emulator":"cloudflare_r2",
  };
}
