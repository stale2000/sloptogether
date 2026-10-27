import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {parseTwitchScopes} from "./twitch-subs";

describe("Twitch authorization scopes",()=>{
  it("defaults sign-in to identity and moderated-channel lookup",()=>{
    expect(parseTwitchScopes(null)).toEqual(["openid","user:read:moderated_channels"]);
  });

  it("accepts the broadcaster subscription and chat EventSub grants",()=>{
    expect(parseTwitchScopes("openid user:read:moderated_channels channel:read:subscriptions"))
      .toEqual(["openid","user:read:moderated_channels","channel:read:subscriptions"]);
    expect(parseTwitchScopes("openid user:read:moderated_channels user:read:chat user:bot"))
      .toEqual(["openid","user:read:moderated_channels","user:read:chat","user:bot"]);
  });

  it("deduplicates scopes and rejects permissions outside the app allow-list",()=>{
    expect(parseTwitchScopes("openid,openid channel:read:subscriptions"))
      .toEqual(["openid","channel:read:subscriptions"]);
    expect(()=>parseTwitchScopes("openid user:manage:blocked_terms"))
      .toThrowError(expect.objectContaining({status:400,code:"unsupported_twitch_scope"}));
  });
});
