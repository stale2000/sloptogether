import "server-only";

import { cookies } from "next/headers";
import type { PoolClient } from "pg";
import { hash, randomSecret } from "./crypto";
import { pool } from "./database";
import { HttpError, publicAppUrl } from "./http";
import { decryptTwitchAccess, encryptTwitchTokens, refreshToken, validateAccessToken } from "./twitch";

const SESSION_COOKIE = "slop_sid";
const SESSION_PATH = "/sloptogether";

export interface UserSession {
  id: string;
  twitchUserId: string;
  twitchLogin: string;
  displayName: string;
  accessToken: string;
  scopes: string[];
  expiresAt: Date;
}

export function sessionCookieOptions(expiresAt?: Date) {
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    secure: publicAppUrl().protocol === "https:",
    sameSite: "lax" as const,
    path: SESSION_PATH,
    expires: expiresAt,
    maxAge: expiresAt ? Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)) : undefined,
  };
}

export async function issueUserSession(
  client: PoolClient,
  user: { id: string; login: string; displayName: string },
  tokens: Parameters<typeof encryptTwitchTokens>[0],
): Promise<{ token: string; expiresAt: Date; scopes: string[] }> {
  const encrypted = encryptTwitchTokens(tokens);
  const token = randomSecret(32);
  const maxAge = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await client.query(
    `INSERT INTO sloptogether.sessions
      (token_hash, twitch_user_id, twitch_login, display_name, access_token_encrypted,
       refresh_token_encrypted, granted_scopes, token_expires_at, token_validated_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9)`,
    [hash(token), user.id, user.login, user.displayName, encrypted.access, encrypted.refresh, encrypted.scopes, encrypted.expiresAt, maxAge],
  );
  return { token, expiresAt: maxAge, scopes: encrypted.scopes };
}

export async function revokeRequestSession(request: Request): Promise<void> {
  const token = readCookie(request.headers.get("cookie") ?? "", SESSION_COOKIE);
  if (token) await pool().query("UPDATE sloptogether.sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL", [hash(token)]);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
}

export async function currentSession(request?: Request): Promise<UserSession | null> {
  let rawToken: string | undefined;
  if (request) rawToken = readCookie(request.headers.get("cookie") ?? "", SESSION_COOKIE);
  else rawToken = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!rawToken) return null;

  const { rows } = await pool().query<{
    id: string; twitch_user_id: string; twitch_login: string; display_name: string;
    access_token_encrypted: Buffer; refresh_token_encrypted: Buffer | null;
    token_expires_at: Date; token_validated_at: Date | null; expires_at: Date; revoked_at: Date | null; granted_scopes: string[];
  }>(
    `SELECT id,twitch_user_id,twitch_login,display_name,access_token_encrypted,
            refresh_token_encrypted,token_expires_at,token_validated_at,expires_at,revoked_at,granted_scopes
       FROM sloptogether.sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()`,
    [hash(rawToken)],
  );
  const row = rows[0];
  if (!row) return null;
  let accessToken = decryptTwitchAccess(row.access_token_encrypted);
  let validatedScopes = row.granted_scopes ?? [];
  const mustValidate = !row.token_validated_at || Date.now() - row.token_validated_at.getTime() >= 60 * 60 * 1000;
  const nearExpiry = row.token_expires_at.getTime() < Date.now() + 90_000;
  try {
    if (nearExpiry && row.refresh_token_encrypted) {
      const updated = encryptTwitchTokens(await refreshToken(decryptTwitchAccess(row.refresh_token_encrypted)));
      await pool().query(
        `UPDATE sloptogether.sessions SET access_token_encrypted=$2,refresh_token_encrypted=$3,
         token_expires_at=$4,token_validated_at=now(),granted_scopes=$5,last_seen_at=now() WHERE id=$1`,
        [row.id, updated.access, updated.refresh, updated.expiresAt, updated.scopes],
      );
      accessToken = decryptTwitchAccess(updated.access);
      validatedScopes = updated.scopes;
    } else if (mustValidate) {
      const validation = await validateAccessToken(accessToken);
      if (validation.user_id !== row.twitch_user_id) throw new HttpError(401, "twitch_identity_changed", "Reconnect your Twitch account.");
      validatedScopes = validation.scopes;
      await pool().query("UPDATE sloptogether.sessions SET token_validated_at=now(),granted_scopes=$2,last_seen_at=now() WHERE id=$1", [row.id, validatedScopes]);
    }
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      await pool().query("UPDATE sloptogether.sessions SET revoked_at=now() WHERE id=$1", [row.id]);
      return null;
    }
    throw error;
  }
  return { id: row.id, twitchUserId: row.twitch_user_id, twitchLogin: row.twitch_login, displayName: row.display_name, accessToken, scopes: validatedScopes, expiresAt: row.expires_at };
}

export function readCookie(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name && rawValue.length > 0) {
      try { return decodeURIComponent(rawValue.join("=")); } catch { return undefined; }
    }
  }
  return undefined;
}
