import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { requiredSecret } from "./env";
import { ApiError } from "./http";

export function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest();
}

export function digestHex(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

export const hash = sha256;

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export const randomSecret = randomToken;

export function hashWorkerSecret(value: string) {
  const pepper = process.env.SLOPTOGETHER_KEY_HASH_PEPPER;
  if (!pepper || pepper.length < 32) throw new Error("SLOPTOGETHER_KEY_HASH_PEPPER is not configured");
  return createHash("sha256").update(pepper).update("\0").update(value).digest();
}

export function constantTimeEqual(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function hmacKeySecret(value:string){
  const secret=process.env.SLOPTOGETHER_KEY_HASH_PEPPER;
  if(!secret||secret.length<32)throw new Error("SLOPTOGETHER_KEY_HASH_PEPPER is not configured");
  return createHash("sha256").update(secret).update("\0").update(value).digest();
}

export function signUploadTicket(payload:Record<string,unknown>):string{
  const secret=process.env.SLOPTOGETHER_UPLOAD_TICKET_KEY;
  if(!secret||secret.length<32)throw new ApiError(503,"upload_gateway_not_configured","Direct worker uploads are not configured.");
  const encoded=Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature=createHmac("sha256",secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function encryptionKey() {
  const encoded = requiredSecret("SLOPTOGETHER_TOKEN_ENCRYPTION_KEY");
  const value = Buffer.from(encoded, "base64");
  if (value.length !== 32) throw new Error("SLOPTOGETHER_TOKEN_ENCRYPTION_KEY must be base64 for 32 bytes");
  return value;
}

export function encryptSecret(plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(encrypted: Buffer): string {
  if (encrypted.byteLength < 30 || encrypted[0] !== 1) throw new Error("Encrypted secret format unsupported");
  const iv = encrypted.subarray(1, 13);
  const tag = encrypted.subarray(13, 29);
  const ciphertext = encrypted.subarray(29);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
