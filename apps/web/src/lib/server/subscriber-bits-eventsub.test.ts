import { beforeEach,describe,expect,it,vi } from "vitest";
import { createHmac } from "node:crypto";

const mocks=vi.hoisted(()=>({clientQuery:vi.fn(),fetch:vi.fn(),findChannel:vi.fn(),currentSession:vi.fn(),query:vi.fn(),recordBits:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./db",()=>({
  lifecyclePool:()=>({connect:async()=>({query:mocks.clientQuery,release:vi.fn()})}),
  query:mocks.query,transactionOnClient:vi.fn(),TransactionCleanupError:class extends Error{},
}));
vi.mock("./channels",()=>({findChannel:mocks.findChannel,isBanned:vi.fn(),requireChannelModerator:vi.fn()}));
vi.mock("./session",()=>({currentSession:mocks.currentSession}));
vi.mock("./paid-bits-service",()=>({recordVerifiedExtensionBitsEvent:mocks.recordBits}));
vi.mock("./twitch",()=>({
  appAccessToken:vi.fn(),twitchCredentials:vi.fn(),extensionAppAccessToken:vi.fn(async()=>"extension-app-token"),
  twitchExtensionClientId:vi.fn(()=>"extension-client-id"),
}));

import { handleEventSubWebhook,registerExtensionBitsEventSub } from "./subscriber-service";

describe("registerExtensionBitsEventSub",()=>{
  beforeEach(()=>{
    vi.resetAllMocks();
    vi.stubEnv("PUBLIC_APP_URL","https://www.clips.gg/sloptogether");
    vi.stubEnv("TWITCH_EVENTSUB_CALLBACK_URL","https://www.clips.gg/sloptogether/api/v1/webhooks/eventsub");
    vi.stubEnv("TWITCH_EVENTSUB_SECRET","a-long-enough-eventsub-test-secret");
    vi.stubEnv("TWITCH_EXTENSION_CLIENT_ID","extension-client-id");
    mocks.findChannel.mockResolvedValue({twitch_channel_id:"123",owner_twitch_user_id:"42"});
    mocks.currentSession.mockResolvedValue({twitchUserId:"42"});
    mocks.query.mockResolvedValue({rows:[],rowCount:1});
    mocks.clientQuery.mockImplementation(async(sql:string)=>{
      if(sql.includes("pg_try_advisory_lock"))return {rows:[{acquired:true}],rowCount:1};
      if(sql.includes("pg_advisory_unlock"))return {rows:[{pg_advisory_unlock:true}],rowCount:1};
      if(sql.includes("SELECT subscription_id,config_fingerprint,state"))return {rows:[],rowCount:0};
      return {rows:[],rowCount:1};
    });
    vi.stubGlobal("fetch",mocks.fetch);
  });

  it("registers the extension-scoped transaction webhook and leaves it pending until Twitch verifies the challenge",async()=>{
    mocks.fetch.mockImplementation(async(_url:string,init?:RequestInit)=>{
      if(init?.method==="POST")return new Response(JSON.stringify({data:[{id:"bits-subscription",type:"extension.bits_transaction.create",version:"1",status:"webhook_callback_verification_pending"}]}),{status:202});
      return new Response(JSON.stringify({data:[]}),{status:200});
    });
    const request=new Request("https://www.clips.gg/sloptogether/api/v1/channels/stale2000/bits-eventsub",{
      method:"POST",headers:{origin:"https://www.clips.gg"},
    });
    await expect(registerExtensionBitsEventSub("stale2000",request)).resolves.toMatchObject({registered:false,subscription:{state:"pending",subscriptionId:"bits-subscription"}});
    const post=mocks.fetch.mock.calls.find(([,init])=>init?.method==="POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({type:"extension.bits_transaction.create",version:"1",condition:{extension_client_id:"extension-client-id"}});
    expect(mocks.clientQuery.mock.calls.some(([sql,values])=>String(sql).includes("config_fingerprint")&&values?.[1]==="bits-subscription"&&values?.[2]==="pending")).toBe(true);
  });

  it("rejects non-broadcasters before calling Twitch",async()=>{
    mocks.currentSession.mockResolvedValue({twitchUserId:"99"});
    const request=new Request("https://www.clips.gg/sloptogether/api/v1/channels/stale2000/bits-eventsub",{
      method:"POST",headers:{origin:"https://www.clips.gg"},
    });
    await expect(registerExtensionBitsEventSub("stale2000",request)).rejects.toMatchObject({status:403,code:"broadcaster_session_required"});
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("answers Twitch's signed Bits EventSub challenge and marks that subscription enabled",async()=>{
    const messageId="bits-challenge-message",timestamp=new Date().toISOString(),challenge="twitch-challenge-value";
    const body=Buffer.from(JSON.stringify({subscription:{id:"bits-subscription",type:"extension.bits_transaction.create",version:"1",
      condition:{extension_client_id:"extension-client-id"},transport:{method:"webhook",callback:"https://www.clips.gg/sloptogether/api/v1/webhooks/eventsub"}},challenge}));
    const signature=createHmac("sha256","a-long-enough-eventsub-test-secret").update(Buffer.concat([Buffer.from(messageId+timestamp),body])).digest("hex");
    const request=new Request("https://www.clips.gg/sloptogether/api/v1/webhooks/eventsub",{method:"POST",body,headers:{
      "content-type":"application/json","twitch-eventsub-message-id":messageId,"twitch-eventsub-message-timestamp":timestamp,
      "twitch-eventsub-message-signature":`sha256=${signature}`,"twitch-eventsub-message-type":"webhook_callback_verification",
    }});
    const response=await handleEventSubWebhook(request);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(challenge);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO sloptogether.extension_bits_eventsub_subscriptions"),["extension-client-id","bits-subscription"]);
  });

  it("forwards a signed Bits transaction notification into authoritative receipt verification",async()=>{
    const messageId="bits-notification-message",timestamp=new Date().toISOString();
    const event={extension_client_id:"extension-client-id",id:"transaction-1",broadcaster_user_id:"123",user_id:"45",
      product:{sku:"prompt-lock-test-100",bits:100,in_development:true}};
    const body=Buffer.from(JSON.stringify({subscription:{id:"bits-subscription",type:"extension.bits_transaction.create",version:"1",
      condition:{extension_client_id:"extension-client-id"},transport:{method:"webhook",callback:"https://www.clips.gg/sloptogether/api/v1/webhooks/eventsub"}},event}));
    const signature=createHmac("sha256","a-long-enough-eventsub-test-secret").update(Buffer.concat([Buffer.from(messageId+timestamp),body])).digest("hex");
    const request=new Request("https://www.clips.gg/sloptogether/api/v1/webhooks/eventsub",{method:"POST",body,headers:{
      "content-type":"application/json","twitch-eventsub-message-id":messageId,"twitch-eventsub-message-timestamp":timestamp,
      "twitch-eventsub-message-signature":`sha256=${signature}`,"twitch-eventsub-message-type":"notification",
    }});
    const response=await handleEventSubWebhook(request);
    expect(response.status).toBe(204);
    expect(mocks.recordBits).toHaveBeenCalledWith(messageId,event);
  });
});
