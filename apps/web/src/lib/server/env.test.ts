import { afterEach, describe, expect, it, vi } from "vitest";
import { publicRuntimeStatus } from "./env";

afterEach(()=>vi.unstubAllEnvs());

describe("publicRuntimeStatus", () => {
  it("reports Twitch OAuth ready only when callback, database and token encryption are configured",()=>{
    vi.stubEnv("TWITCH_CLIENT_ID","client-id");
    vi.stubEnv("TWITCH_CLIENT_SECRET","client-secret");
    vi.stubEnv("DATABASE_URL","postgresql://postgres@127.0.0.1:56432/sloptogether");
    vi.stubEnv("PUBLIC_APP_URL","https://clips.gg/sloptogether");
    vi.stubEnv("SLOPTOGETHER_TOKEN_ENCRYPTION_KEY",Buffer.alloc(32,7).toString("base64"));
    expect(publicRuntimeStatus()).toMatchObject({twitchOAuth:true});
    vi.stubEnv("SLOPTOGETHER_TOKEN_ENCRYPTION_KEY","too-short");
    expect(publicRuntimeStatus()).toMatchObject({twitchOAuth:false});
    vi.stubEnv("SLOPTOGETHER_TOKEN_ENCRYPTION_KEY",Buffer.alloc(32,7).toString("base64"));
    vi.stubEnv("PUBLIC_APP_URL","https://clips.gg/");
    expect(publicRuntimeStatus()).toMatchObject({twitchOAuth:false});
    vi.stubEnv("PUBLIC_APP_URL","https://clips.gg/sloptogether");
    vi.stubEnv("DATABASE_URL","postgresql://postgres@db.lkyaaokrpbqucjrnhrps.supabase.co/clips");
    vi.stubEnv("SLOPTOGETHER_USE_CLIPSGG_DATABASE","false");
    expect(publicRuntimeStatus()).toMatchObject({twitchOAuth:false});
    vi.stubEnv("DATABASE_URL","postgresql://sloptogether_app@db.lkyaaokrpbqucjrnhrps.supabase.co/postgres?sslmode=require");
    vi.stubEnv("SLOPTOGETHER_USE_CLIPSGG_DATABASE","true");
    expect(publicRuntimeStatus()).toMatchObject({twitchOAuth:true});
    vi.stubEnv("DATABASE_URL","postgresql://postgres@db.lkyaaokrpbqucjrnhrps.supabase.co/postgres?sslmode=require");
    expect(publicRuntimeStatus()).toMatchObject({twitchOAuth:false});
  });

  it("does not expose provider-worker readiness in web health", () => {
    const original = process.env.FAL_KEY;
    try {
      process.env.FAL_KEY = "test-provider-key";
      expect(publicRuntimeStatus()).not.toHaveProperty("fal");
    } finally {
      if (original === undefined) delete process.env.FAL_KEY;
      else process.env.FAL_KEY = original;
    }
  });

  it("reports moderation readiness without exposing the dedicated key",()=>{
    vi.stubEnv("SLOPTOGETHER_OPENAI_MODERATION_KEY","test-moderation-key");
    vi.stubEnv("OPENAI_API_KEY","paid-story-key-is-not-moderation");
    expect(publicRuntimeStatus()).toMatchObject({openaiPreflight:true});
    expect(publicRuntimeStatus()).not.toHaveProperty("openaiModerationKey");
    vi.stubEnv("SLOPTOGETHER_OPENAI_MODERATION_KEY","");
    expect(publicRuntimeStatus()).toMatchObject({openaiPreflight:false});
  });

  it("distinguishes the loopback preview store from production Cloudflare R2",()=>{
    vi.stubEnv("R2_ACCOUNT_ID","local-account");
    vi.stubEnv("R2_ACCESS_KEY_ID","local-key");
    vi.stubEnv("R2_SECRET_ACCESS_KEY","local-secret");
    vi.stubEnv("R2_BUCKET_NAME","local-bucket");
    vi.stubEnv("SLOPTOGETHER_LOCAL_S3_ENDPOINT","http://127.0.0.1:9000");
    expect(publicRuntimeStatus()).toMatchObject({objectStorage:true,objectStorageMode:"local_emulator"});
    vi.stubEnv("SLOPTOGETHER_LOCAL_S3_ENDPOINT","");
    expect(publicRuntimeStatus()).toMatchObject({objectStorage:true,objectStorageMode:"cloudflare_r2"});
    vi.stubEnv("R2_ACCESS_KEY_ID","");
    expect(publicRuntimeStatus()).toMatchObject({objectStorage:false,objectStorageMode:"unconfigured"});
  });

  it("enables Comfy generation only behind its explicit gates and server key",()=>{
    vi.stubEnv("SLOPTOGETHER_COMFY_FRAME_GENERATION_ENABLED","true");
    vi.stubEnv("SLOPTOGETHER_COMFY_PROMPT_GENERATION_ENABLED","true");
    vi.stubEnv("SLOPTOGETHER_COMFY_API_KEY","test-comfy-key-long-enough");
    vi.stubEnv("SLOPTOGETHER_COMFY_FRAME_GENERATION_CHANNEL_IDS","123");
    vi.stubEnv("SLOPTOGETHER_OPENAI_MODERATION_KEY","test-moderation-key");
    expect(publicRuntimeStatus()).toMatchObject({comfyFrameGeneration:true,comfyPromptGeneration:true});
    expect(publicRuntimeStatus()).not.toHaveProperty("comfyApiKey");
    vi.stubEnv("SLOPTOGETHER_OPENAI_MODERATION_KEY","");
    vi.stubEnv("OPENAI_API_KEY","");
    expect(publicRuntimeStatus()).toMatchObject({comfyFrameGeneration:false,comfyPromptGeneration:false});
    vi.stubEnv("SLOPTOGETHER_OPENAI_MODERATION_KEY","test-moderation-key");
    vi.stubEnv("SLOPTOGETHER_COMFY_FRAME_GENERATION_CHANNEL_IDS","");
    expect(publicRuntimeStatus()).toMatchObject({comfyFrameGeneration:false,comfyPromptGeneration:false});
    vi.stubEnv("SLOPTOGETHER_COMFY_FRAME_GENERATION_CHANNEL_IDS","123");
    vi.stubEnv("SLOPTOGETHER_COMFY_FRAME_GENERATION_ENABLED","false");
    expect(publicRuntimeStatus()).toMatchObject({comfyFrameGeneration:false,comfyPromptGeneration:true});
  });

  it("only uses the Comfy CLI key as a development fallback",()=>{
    vi.stubEnv("SLOPTOGETHER_COMFY_FRAME_GENERATION_ENABLED","true");
    vi.stubEnv("SLOPTOGETHER_COMFY_PROMPT_GENERATION_ENABLED","true");
    vi.stubEnv("SLOPTOGETHER_COMFY_API_KEY","");
    vi.stubEnv("COMFY_API_KEY","test-cli-key");
    vi.stubEnv("SLOPTOGETHER_COMFY_FRAME_GENERATION_CHANNEL_IDS","123");
    vi.stubEnv("SLOPTOGETHER_OPENAI_MODERATION_KEY","test-moderation-key");
    vi.stubEnv("NODE_ENV","development");
    expect(publicRuntimeStatus()).toMatchObject({comfyFrameGeneration:true});
    vi.stubEnv("NODE_ENV","production");
    expect(publicRuntimeStatus()).toMatchObject({comfyFrameGeneration:false,comfyPromptGeneration:false});
  });
});

