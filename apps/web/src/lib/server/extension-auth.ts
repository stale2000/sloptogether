import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http";

export interface ExtensionPrincipal {
  channelId: string;
  role: "broadcaster" | "moderator" | "viewer";
  linkedTwitchUserId: string | null;
  opaqueUserId: string;
  linkedTwitchLogin: string | null;
  expiresAt: number;
}

export interface ExtensionBitsReceipt {
  transactionId:string;
  userId:string;
  occurredAt:Date;
  inDevelopment:boolean;
}

function decodePart(value: string) {
  if (!value || value.length > 64_000 || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new HttpError(401,"invalid_extension_token");
  return Buffer.from(value, "base64url");
}

function candidateSecrets() {
  const secret = process.env.TWITCH_EXTENSION_SECRET_CURRENT;
  const previous = process.env.TWITCH_EXTENSION_SECRET_PREVIOUS;
  return [secret, previous].filter((v): v is string => Boolean(v)).map((v) => Buffer.from(v,"base64")).filter((v) => v.length >= 16);
}

function verifySignature(message: string, supplied: Buffer): boolean {
  return candidateSecrets().some((secret) => {
    const expected = createHmac("sha256",secret).update(message).digest();
    return expected.length === supplied.length && timingSafeEqual(expected,supplied);
  });
}

export function verifyExtensionRequest(request: Request): ExtensionPrincipal {
  const token = request.headers.get("x-extension-jwt") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i,"");
  if (!token) throw new HttpError(401,"extension_token_required","Twitch did not authorize this request.");
  if (!process.env.TWITCH_EXTENSION_CLIENT_ID) throw new HttpError(503,"extension_not_configured");

  const [headerPart,payloadPart,signaturePart,...extra] = token.split(".");
  if (!headerPart || !payloadPart || !signaturePart || extra.length) throw new HttpError(401,"invalid_extension_token");
  let header:Record<string,unknown>;
  try{header=JSON.parse(decodePart(headerPart).toString("utf8")) as Record<string,unknown>;}catch{throw new HttpError(401,"invalid_extension_token");}
  if(!header||typeof header!=="object"||Array.isArray(header))throw new HttpError(401,"invalid_extension_token");
  if (header.alg !== "HS256" || header.typ !== "JWT") throw new HttpError(401,"invalid_extension_algorithm");
  if (!verifySignature(`${headerPart}.${payloadPart}`,decodePart(signaturePart))) throw new HttpError(401,"invalid_extension_signature");
  let payload:Record<string,unknown>;
  try{payload=JSON.parse(decodePart(payloadPart).toString("utf8")) as Record<string,unknown>;}catch{throw new HttpError(401,"invalid_extension_token");}
  if(!payload||typeof payload!=="object"||Array.isArray(payload))throw new HttpError(401,"invalid_extension_token");
  const expiresAt = Number(payload.exp);
  const channelId = typeof payload.channel_id === "string" ? payload.channel_id : "";
  const opaqueUserId = typeof payload.opaque_user_id === "string" ? payload.opaque_user_id : "";
  const role = payload.role;
  const isUnlinked=payload.is_unlinked===true||payload.is_unlinked==="true";
  const linkedId = isUnlinked?null:typeof payload.user_id === "string" ? payload.user_id : null;
  const linkedLogin = typeof payload.user_login === "string" ? payload.user_login : null;
  const expectedClient = process.env.TWITCH_EXTENSION_CLIENT_ID;
  if (!/^\d{1,32}$/.test(channelId) || !opaqueUserId || !Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now()/1000) - 15) {
    throw new HttpError(401,"expired_extension_identity");
  }
  if (expiresAt > Math.floor(Date.now()/1000) + 24*60*60) throw new HttpError(401,"invalid_extension_lifetime");
  if (role !== "viewer" && role !== "broadcaster" && role !== "moderator") throw new HttpError(401,"invalid_extension_role");
  if(payload.user_id!==undefined&&(linkedId===null||!/^\d{1,32}$/.test(linkedId)))throw new HttpError(401,"invalid_extension_user_id");
  if (linkedId && !opaqueUserId.startsWith("U")) throw new HttpError(401,"extension_identity_mismatch");
  // An unlinked Extension viewer may read public panel state. Ballots and
  // submissions still require linkedTwitchUserId through their own handlers.
  if (payload.client_id !== undefined && payload.client_id !== expectedClient) throw new HttpError(401,"extension_client_mismatch");

  const origin = request.headers.get("origin");
  const allowedOrigin = `https://${expectedClient}.ext-twitch.tv`;
  const localDemoOrigin=process.env.NODE_ENV==="development"&&process.env.NEXT_PUBLIC_LOCAL_DEMO_ENABLED==="true"&&origin==="http://localhost:3000";
  if (origin && origin !== allowedOrigin && origin !== "https://www.twitch.tv" && !localDemoOrigin) {
    throw new HttpError(403,"extension_origin_not_allowed");
  }

  return {channelId,role,linkedTwitchUserId:linkedId,linkedTwitchLogin:linkedLogin,opaqueUserId,expiresAt};
}

export function verifyExtensionBitsReceipt(token:string,now=Date.now()):ExtensionBitsReceipt{
  if(typeof token!=="string"||token.length>64_000)throw new HttpError(401,"bits_receipt_invalid");
  const [headerPart,payloadPart,signaturePart,...extra]=token.split(".");
  if(!headerPart||!payloadPart||!signaturePart||extra.length)throw new HttpError(401,"bits_receipt_invalid");
  let header:Record<string,unknown>,payload:Record<string,unknown>;
  try{
    header=JSON.parse(decodePart(headerPart).toString("utf8")) as Record<string,unknown>;
    payload=JSON.parse(decodePart(payloadPart).toString("utf8")) as Record<string,unknown>;
  }catch{throw new HttpError(401,"bits_receipt_invalid");}
  if(header.alg!=="HS256"||header.typ!=="JWT"||!verifySignature(`${headerPart}.${payloadPart}`,decodePart(signaturePart)))
    throw new HttpError(401,"bits_receipt_signature_invalid");
  const expiresAt=Number(payload.exp),data=payload.data;
  if(payload.topic!=="bits_transaction_receipt"||!Number.isFinite(expiresAt)||expiresAt<=Math.floor(now/1000)
    ||!data||typeof data!=="object"||Array.isArray(data))throw new HttpError(401,"bits_receipt_expired_or_invalid");
  const receipt=data as Record<string,unknown>,transactionId=receipt.transactionId,userId=receipt.userId;
  const occurredAt=Date.parse(String(receipt.time??"")),clientId=process.env.TWITCH_EXTENSION_CLIENT_ID;
  if(!clientId||payload.domainID!==`twitch.ext${clientId}`||typeof transactionId!=="string"||transactionId.length<1||transactionId.length>256
    ||typeof userId!=="string"||!/^[0-9]{1,32}$/.test(userId)||!Number.isFinite(occurredAt)||occurredAt>now+30_000)
    throw new HttpError(401,"bits_receipt_payload_invalid");
  return {transactionId,userId,occurredAt:new Date(occurredAt),inDevelopment:payload.product==="inDevelopment"||receipt.product==="inDevelopment"};
}

export function extensionCorsHeaders(origin: string | null): Headers {
  const headers = new Headers({"Vary":"Origin","Cache-Control":"no-store"});
  const clientId = process.env.TWITCH_EXTENSION_CLIENT_ID;
  const valid = clientId ? `https://${clientId}.ext-twitch.tv` : "";
  if (origin && (origin === valid || origin === "https://www.twitch.tv")) {
    headers.set("Access-Control-Allow-Origin",origin);
    headers.set("Access-Control-Allow-Methods","GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers","Content-Type, Authorization, X-Extension-Jwt, Twitch-Eventsub-Message-Id, Twitch-Eventsub-Message-Timestamp, Twitch-Eventsub-Message-Signature, Twitch-Eventsub-Message-Type");
    headers.set("Access-Control-Max-Age","600");
  }
  return headers;
}
