import { describe,expect,it,vi } from "vitest";
import type { ChannelRow } from "./channels";

const mocks=vi.hoisted(()=>({query:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./db",()=>({query:mocks.query}));
vi.mock("./channels",()=>({principalTwitchId:()=>null}));

import { getPublicTimeline } from "./timeline";

describe("public timeline media",()=>{
  it("shows the committed derivative and keeps an unpublished base out of the public timeline",async()=>{
    mocks.query.mockImplementation(async(sql:string)=>{
      if(sql.includes("FROM sloptogether.streams WHERE twitch_channel_id=$1 AND id=$2"))return {rows:[{id:"stream-1",slug:"preview",display_name:"Preview stream",is_default:false}],rowCount:1};
      if(sql.includes("SELECT s.id,s.ordinal"))return {rows:[
        {id:"scene-1",ordinal:"0",state:"ready",prompt:"First",duration_seconds:"15",asset_id:"upscaled",program_item_id:"item-1",upscale_asset_id:null,item_kind:null,vote_count:"0",my_choice_id:null},
        {id:"scene-2",ordinal:"1",state:"locked",prompt:"Waiting",duration_seconds:null,asset_id:null,program_item_id:null,upscale_asset_id:null,item_kind:null,vote_count:"0",my_choice_id:null},
      ]};
      return {rows:[]};
    });
    const channel={twitch_channel_id:"123",twitch_login:"channel",display_name:"Channel",visibility:"public",layout_revision:1} as ChannelRow;
    const result=await getPublicTimeline(channel,null,"stream-1");
    expect(result.streamId).toBe("stream-1");
    expect(result.segments[0]).toMatchObject({state:"ready",mediaUrl:"/sloptogether/api/v1/media/upscaled",programItemId:"item-1"});
    expect(result.segments[1]).toMatchObject({state:"locked",mediaUrl:undefined,programItemId:null});
    const sql=String(mocks.query.mock.calls.find(([query])=>String(query).includes("SELECT s.id,s.ordinal"))?.[0]);
    expect(sql).toContain("public_asset.id AS asset_id");
    expect(sql).toContain("public_asset.program_item_id IS NULL THEN 'locked'");
    expect(sql).toContain("stream_branch.stream_id=$3");
    expect(sql).toContain("pi.stream_id=$3");
    expect(sql).not.toContain("coalesce(base_asset.id");
  });
});
