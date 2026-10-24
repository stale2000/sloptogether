import { afterEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { validateAccessToken } from "./twitch";

describe("Twitch access-token validation",()=>{
  afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals()});

  it("does not treat transient Twitch failures as revoked sessions",async()=>{
    vi.stubEnv("TWITCH_CLIENT_ID","client-id");
    vi.stubEnv("TWITCH_CLIENT_SECRET","client-secret");
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("unavailable",{status:503})));
    await expect(validateAccessToken("access-token")).rejects.toMatchObject({status:503,code:"twitch_validation_unavailable"});
  });

  it("keeps Twitch's invalid-token response as a revocation signal",async()=>{
    vi.stubEnv("TWITCH_CLIENT_ID","client-id");
    vi.stubEnv("TWITCH_CLIENT_SECRET","client-secret");
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("invalid",{status:401})));
    await expect(validateAccessToken("access-token")).rejects.toMatchObject({status:401,code:"twitch_session_revoked"});
  });
});
