import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

const MAX_HEADER_AGE_MS=2*60_000;

export function trustedProxyClientIp(request:Request,secret=process.env.SLOPTOGETHER_PROXY_CLIENT_IP_SECRET):string|null{
  if(!secret||secret.length<32)return null;
  const ip=request.headers.get("x-sloptogether-client-ip")??"";
  const timestamp=request.headers.get("x-sloptogether-client-ip-timestamp")??"";
  const signature=request.headers.get("x-sloptogether-client-ip-signature")??"";
  if(!isIP(ip)||!/^\d{13}$/.test(timestamp)||!/^[-_A-Za-z0-9]{43}$/.test(signature))return null;
  const issuedAt=Number(timestamp);
  if(!Number.isSafeInteger(issuedAt)||Math.abs(Date.now()-issuedAt)>MAX_HEADER_AGE_MS)return null;
  const expected=createHmac("sha256",secret).update(`${timestamp}\n${ip}`).digest();
  const supplied=Buffer.from(signature,"base64url");
  return expected.length===supplied.length&&timingSafeEqual(expected,supplied)?ip:null;
}
