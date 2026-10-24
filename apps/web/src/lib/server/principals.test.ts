import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks=vi.hoisted(()=>({query:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./db",()=>({query:mocks.query}));
vi.mock("./session",()=>({currentSession:vi.fn(),readCookie:vi.fn()}));
vi.mock("./extension-auth",()=>({verifyExtensionRequest:vi.fn()}));

import { requestPrincipal } from "./principals";

const keyId="123e4567-e89b-42d3-a456-426614174000";
const key=`slw_${keyId}.${"a".repeat(32)}`;
const pepper="test-key-hash-pepper-that-is-long-enough";
const hash=createHash("sha256").update(pepper).update("\0").update(key).digest();

beforeEach(()=>{
  vi.resetAllMocks();
  vi.stubEnv("SLOPTOGETHER_KEY_HASH_PEPPER",pepper);
  mocks.query.mockImplementation(async(sql:string)=>sql.includes("SELECT k.key_id")
    ?{rows:[{key_id:keyId,secret_hash:hash,issuing_twitch_user_id:"42",twitch_channel_id:"123",scopes:["worker:upscale"],worker_roles:["upscale"],recipe_ids:[],expires_at:null,revoked_at:null,paired:true,platform:"windows"}],rowCount:1}
    :{rows:[],rowCount:1});
});
afterEach(()=>vi.unstubAllEnvs());

describe("paired worker platform identity",()=>{
  it("returns the platform recorded at pairing with the verified worker grant",async()=>{
    await expect(requestPrincipal(new Request("https://clips.gg/sloptogether/api/v1/workers/leases",{
      headers:{Authorization:`SlopWorker ${key}`},
    }))).resolves.toMatchObject({kind:"worker-key",worker:{paired:true,platform:"windows",channelId:"123"}});
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain("wp.requested_device->>'platform'");
  });

  it("keeps owner-issued headless grants platform-neutral",async()=>{
    mocks.query.mockImplementation(async(sql:string)=>sql.includes("SELECT k.key_id")
      ?{rows:[{key_id:keyId,secret_hash:hash,issuing_twitch_user_id:"1",twitch_channel_id:"123",scopes:["worker:upscale"],worker_roles:["upscale"],recipe_ids:[],expires_at:null,revoked_at:null,paired:false,platform:null}],rowCount:1}
      :{rows:[],rowCount:1});
    await expect(requestPrincipal(new Request("https://clips.gg/sloptogether/api/v1/workers/leases",{
      headers:{Authorization:`SlopWorker ${key}`},
    }))).resolves.toMatchObject({kind:"worker-key",worker:{paired:false,platform:null}});
  });
});
