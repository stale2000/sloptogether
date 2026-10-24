import { describe,expect,it,vi } from "vitest";
import { abandonStoryProducerPlans } from "./worker-revocation";

function clientFor({expiresAt,enabled=true,ownerAuthorized=true,fundingState="reserved"}:{expiresAt:Date;enabled?:boolean;ownerAuthorized?:boolean;fundingState?:string}){
  const client={query:vi.fn(async(sql:string,values?:unknown[])=>{
    void values;
    if(sql.includes("SELECT id,input_payload->>'interruptId'"))return {rows:[{id:"plan",interrupt_id:"interrupt",owner_reservation_id:null}],rowCount:1};
    if(sql.includes("SELECT ir.id,ir.funding_id"))return {rows:[{id:"interrupt",funding_id:"funding",trigger_event_id:"event",expires_at:expiresAt,enabled,funding_state:fundingState,owner_authorized:ownerAuthorized}],rowCount:1};
    return {rows:[],rowCount:1};
  })};
  return client;
}

describe("story producer revocation cleanup",()=>{
  it("requeues a still-live subscriber interrupt with its reserved funding",async()=>{
    const client=clientFor({expiresAt:new Date(Date.now()+60_000)});
    await expect(abandonStoryProducerPlans(client as never,["producer"])).resolves.toEqual({planIds:["plan"],interruptIds:["interrupt"]});
    expect(client.query.mock.calls.some(([sql,values])=>String(sql).includes("UPDATE sloptogether.interrupt_requests SET program_state=$2")&&values?.[1]==="queued")).toBe(true);
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("UPDATE sloptogether.funding_authorizations"))).toBe(false);
  });

  it("expires stale subscriber alerts and releases their unclaimed reservation",async()=>{
    const client=clientFor({expiresAt:new Date(Date.now()-60_000)});
    await abandonStoryProducerPlans(client as never,["producer"]);
    expect(client.query.mock.calls.some(([sql,values])=>String(sql).includes("UPDATE sloptogether.interrupt_requests SET program_state=$2")&&values?.[1]==="expired")).toBe(true);
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes("UPDATE sloptogether.funding_authorizations"))).toBe(true);
  });
});
