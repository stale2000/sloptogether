import { describe,expect,it,vi } from "vitest";

const mocks=vi.hoisted(()=>({query:vi.fn(),transaction:vi.fn(),findChannel:vi.fn(),requestPrincipal:vi.fn(),requireStreamerController:vi.fn(),assertSameOrigin:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./db",()=>({query:mocks.query,transaction:mocks.transaction}));
vi.mock("./channels",()=>({findChannel:mocks.findChannel,requireStreamerController:mocks.requireStreamerController}));
vi.mock("./principals",()=>({requestPrincipal:mocks.requestPrincipal}));
vi.mock("./http",async importOriginal=>{
  const actual=await importOriginal<typeof import("./http")>();
  return {...actual,assertSameOrigin:mocks.assertSameOrigin};
});

import { createStream,listStreams } from "./stream-service";

const channel={twitch_channel_id:"123",twitch_login:"owner",display_name:"Owner",owner_twitch_user_id:"42",is_enabled:true,visibility:"public",policy_revision:1};
const main={id:"main-id",twitch_channel_id:"123",slug:"main",display_name:"Main stream",is_default:true};
const second={id:"stream-id",twitch_channel_id:"123",slug:"space-arcade",display_name:"Space Arcade",is_default:false,created_at:new Date("2026-10-27T00:00:00Z")};

describe("channel streams",()=>{
  it("lists the default and sibling streams independently",async()=>{
    mocks.findChannel.mockResolvedValue(channel);
    mocks.query.mockResolvedValue({rows:[main,second],rowCount:2});
    await expect(listStreams("owner")).resolves.toMatchObject({streams:[
      {id:"main-id",slug:"main",isDefault:true},{id:"stream-id",slug:"space-arcade",displayName:"Space Arcade",isDefault:false},
    ]});
    expect(mocks.query.mock.calls[0]?.[1]).toEqual(["123"]);
  });

  it("creates a separate stream branch and playhead under the shared channel",async()=>{
    mocks.findChannel.mockResolvedValue(channel);
    mocks.requestPrincipal.mockResolvedValue({kind:"session"});
    mocks.requireStreamerController.mockResolvedValue("42");
    mocks.transaction.mockImplementation(async work=>work(client));
    const calls:Array<{sql:string;values?:unknown[]}>=[];
    const client={query:vi.fn(async(sql:string,values?:unknown[])=>{
      calls.push({sql,values});
      if(sql.includes("SELECT 1 FROM sloptogether.streams"))return {rows:[],rowCount:0};
      if(sql.includes("INSERT INTO sloptogether.streams"))return {rows:[second],rowCount:1};
      if(sql.includes("INSERT INTO sloptogether.branches"))return {rows:[{id:"branch-id"}],rowCount:1};
      return {rows:[],rowCount:1};
    })};
    const request=new Request("https://www.clips.gg/sloptogether/api/v1/channels/owner/streams",{
      method:"POST",headers:{origin:"https://www.clips.gg","content-type":"application/json"},body:JSON.stringify({slug:"space-arcade",displayName:"Space Arcade"}),
    });
    await expect(createStream("owner",request)).resolves.toMatchObject({id:"stream-id",slug:"space-arcade",displayName:"Space Arcade",isDefault:false});
    expect(calls.find(call=>call.sql.includes("INSERT INTO sloptogether.branches"))?.values).toEqual(["123","stream-id","Space Arcade","42"]);
    expect(calls.some(call=>call.sql.includes("INSERT INTO sloptogether.playback_sessions(twitch_channel_id,stream_id)"))).toBe(true);
    expect(calls.some(call=>call.sql.includes("INSERT INTO sloptogether.program_manifests(twitch_channel_id,stream_id"))).toBe(true);
  });

  it("rejects duplicate stream slugs without adding another branch",async()=>{
    mocks.findChannel.mockResolvedValue(channel);
    mocks.requestPrincipal.mockResolvedValue({kind:"session"});
    mocks.requireStreamerController.mockResolvedValue("42");
    mocks.transaction.mockImplementation(async work=>work({query:vi.fn(async(sql:string)=>sql.includes("SELECT 1 FROM sloptogether.streams")?{rows:[{}],rowCount:1}:{rows:[],rowCount:1})}));
    const request=new Request("https://www.clips.gg/sloptogether/api/v1/channels/owner/streams",{
      method:"POST",headers:{origin:"https://www.clips.gg","content-type":"application/json"},body:JSON.stringify({slug:"main",displayName:"Duplicate"}),
    });
    await expect(createStream("owner",request)).rejects.toMatchObject({status:409,code:"stream_slug_taken"});
  });
});
