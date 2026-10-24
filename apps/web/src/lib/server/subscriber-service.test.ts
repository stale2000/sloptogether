import { createHmac } from "node:crypto";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";

const mocks=vi.hoisted(()=>({query:vi.fn(),transaction:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./db",()=>({query:mocks.query,transaction:mocks.transaction}));
vi.mock("./channels",()=>({findChannel:vi.fn(),isBanned:vi.fn(),requireChannelModerator:vi.fn()}));
vi.mock("./extension-auth",()=>({verifyExtensionRequest:vi.fn()}));
vi.mock("./timeline",()=>({getActiveElections:vi.fn()}));
vi.mock("./session",()=>({currentSession:vi.fn()}));
vi.mock("./voting-service",()=>({castBallot:vi.fn()}));

import { handleEventSubWebhook } from "./subscriber-service";

const secret="local-eventsub-test-secret";
const event={broadcaster_user_id:"123",user_id:"456",user_login:"viewer_456",user_name:"Viewer",is_anonymous:false,is_gift:false};

function signedEvent(messageId:string){
  const body=Buffer.from(JSON.stringify({subscription:{id:"sub-1",type:"channel.subscribe",version:"1",condition:{broadcaster_user_id:"123"},transport:{method:"webhook"}},event}));
  const timestamp=new Date().toISOString();
  const signature=createHmac("sha256",secret).update(Buffer.concat([Buffer.from(messageId+timestamp),body])).digest("hex");
  return new Request("https://clips.gg/sloptogether/api/v1/webhooks/eventsub",{method:"POST",headers:{
    "Content-Type":"application/json","Twitch-Eventsub-Message-Id":messageId,"Twitch-Eventsub-Message-Timestamp":timestamp,
    "Twitch-Eventsub-Message-Signature":`sha256=${signature}`,"Twitch-Eventsub-Message-Type":"notification",
  },body});
}

function configureAdmission({duplicate=false,hourlySpendCapUsd=1,lastCreatedAt=null}:{duplicate?:boolean;hourlySpendCapUsd?:number;lastCreatedAt?:Date|null}={}){
  const calls:string[]=[];
  const settings={enabled:true,newSubscriptions:true,resubscriptionMessages:false,giftMode:"off",minimumGapSeconds:60,eventMaxAgeSeconds:180,hourlySpendCapUsd,fallback:"skip"};
  const client={query:vi.fn(async(sql:string,_values?:unknown[])=>{
    void _values;
    calls.push(sql);
    if(sql.includes("SELECT owner_twitch_user_id,subscriber_interrupt_policy"))return {rows:[{owner_twitch_user_id:"789",subscriber_interrupt_policy:settings,owner_budget_cap_usd:"10",policy_revision:3,is_enabled:true}],rowCount:1};
    if(sql.includes("INSERT INTO sloptogether.subscription_events"))return duplicate?{rows:[],rowCount:0}:{rows:[{id:"event-1"}],rowCount:1};
    if(sql.includes("FROM sloptogether.sessions WHERE twitch_user_id"))return {rows:[],rowCount:1};
    if(sql.includes("FROM sloptogether.bans"))return {rows:[],rowCount:0};
    if(sql.includes("SELECT count(*) FILTER"))return {rows:[{pending_count:"0",last_created_at:lastCreatedAt}],rowCount:1};
    if(sql.includes("AS hourly"))return {rows:[{hourly:"0",total:"0"}],rowCount:1};
    if(sql.includes("INSERT INTO sloptogether.funding_authorizations"))return {rows:[{id:"funding-1"}],rowCount:1};
    if(sql.includes("UPDATE sloptogether.interrupt_requests")&&sql.includes("RETURNING"))return {rows:[],rowCount:0};
    return {rows:[],rowCount:1};
  })};
  mocks.query.mockResolvedValue({rows:[{id:"123"}],rowCount:1});
  mocks.transaction.mockImplementation(async(work:(db:typeof client)=>Promise<unknown>)=>work(client));
  return {calls,client};
}

beforeEach(()=>{
  vi.resetAllMocks();
  vi.stubEnv("TWITCH_EVENTSUB_SECRET",secret);
  vi.stubEnv("SLOPTOGETHER_SUBSCRIBER_ATTEMPT_RESERVATION_USD","0.25");
});
afterEach(()=>vi.unstubAllEnvs());

describe("subscriber EventSub admission",()=>{
  it("queues one funded interrupt for a signed, eligible subscription",async()=>{
    const {client}=configureAdmission();
    await expect(handleEventSubWebhook(signedEvent("event-delivery-1"))).resolves.toMatchObject({status:204});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO sloptogether.funding_authorizations"))).toBe(true);
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO sloptogether.interrupt_requests"))).toBe(true);
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("subscriber_interrupt.plan"))).toBe(true);
  });

  it("acknowledges a duplicate delivery without creating a second reservation",async()=>{
    const {client}=configureAdmission({duplicate:true});
    await expect(handleEventSubWebhook(signedEvent("event-delivery-duplicate"))).resolves.toMatchObject({status:204});
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO sloptogether.funding_authorizations"))).toBe(false);
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO sloptogether.interrupt_requests"))).toBe(false);
  });

  it("does not reserve money when the hourly cap or minimum gap is reached",async()=>{
    for(const options of [{hourlySpendCapUsd:0},{lastCreatedAt:new Date()}]){
      const {client}=configureAdmission(options);
      await expect(handleEventSubWebhook(signedEvent(`event-delivery-${options.hourlySpendCapUsd??"gap"}`))).resolves.toMatchObject({status:204});
      expect(client.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO sloptogether.funding_authorizations"))).toBe(false);
      const audit=client.query.mock.calls.find(([sql])=>String(sql).includes("'subscriber_interrupt.not_queued'"));
      expect(audit?.[1]?.[2]).toBe(options.hourlySpendCapUsd===0?"hourly_spend_cap":"minimum_gap");
      mocks.query.mockReset();
      mocks.transaction.mockReset();
    }
  });
});
