import { createHmac } from "node:crypto";
import { afterEach,describe,expect,it,vi } from "vitest";
import { trustedProxyClientIp } from "./proxy-client-ip";

const secret="test-secret-value-that-is-at-least-32-bytes-long";
const signedHeaders=(ip:string,timestamp=String(Date.now()))=>({
  "x-sloptogether-client-ip":ip,
  "x-sloptogether-client-ip-timestamp":timestamp,
  "x-sloptogether-client-ip-signature":createHmac("sha256",secret).update(`${timestamp}\n${ip}`).digest("base64url"),
});

afterEach(()=>vi.unstubAllEnvs());

describe("trusted proxy client address",()=>{
  it("accepts a recent correctly signed address",()=>{
    expect(trustedProxyClientIp(new Request("https://clips.gg",{headers:signedHeaders("2001:db8::1")}),secret)).toBe("2001:db8::1");
  });

  it("rejects direct spoofed IP headers and invalid signatures",()=>{
    const request=new Request("https://clips.gg",{headers:{"x-real-ip":"192.0.2.1","cf-connecting-ip":"192.0.2.2",...signedHeaders("192.0.2.3"),"x-sloptogether-client-ip-signature":"A".repeat(43)}});
    expect(trustedProxyClientIp(request,secret)).toBeNull();
  });

  it("rejects stale, malformed and unsigned proxy metadata",()=>{
    const stale=String(Date.now()-3*60_000);
    expect(trustedProxyClientIp(new Request("https://clips.gg",{headers:signedHeaders("192.0.2.4",stale)}),secret)).toBeNull();
    expect(trustedProxyClientIp(new Request("https://clips.gg",{headers:signedHeaders("not-an-ip")}),secret)).toBeNull();
    vi.stubEnv("SLOPTOGETHER_PROXY_CLIENT_IP_SECRET","");
    expect(trustedProxyClientIp(new Request("https://clips.gg",{headers:signedHeaders("192.0.2.5")}))).toBeNull();
  });
});
