import "server-only";

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { hasScopedClipsDatabaseUser,isClipsDatabase } from "./database-target";

declare global {
   
  var __sloptogetherPool: Pool | undefined;
  var __sloptogetherLifecyclePool: Pool | undefined;
}

export class DatabaseUnavailable extends Error {
  readonly code = "database_unavailable";

  constructor() {
    super("SlopTogether is not connected to its dedicated database.");
  }
}

function createPool(max=3,applicationName="sloptogether-web"): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new DatabaseUnavailable();

  const url = new URL(connectionString);
  if (!url.protocol.startsWith("postgres")) {
    throw new Error("DATABASE_URL must use PostgreSQL");
  }
  const isSharedClipsDb=isClipsDatabase(url);
  const explicitlyAllowsClipsDatabase = process.env.SLOPTOGETHER_USE_CLIPSGG_DATABASE === "true";
  if (isSharedClipsDb && (!explicitlyAllowsClipsDatabase || !hasScopedClipsDatabaseUser(url))) {
    throw new Error("The Clips.gg database requires SLOPTOGETHER_USE_CLIPSGG_DATABASE=true and the schema-scoped sloptogether_app login.");
  }
  const databaseCa=process.env.SLOPTOGETHER_DATABASE_SSL_CA?.replace(/\\n/g,"\n").trim();
  if(isSharedClipsDb&&process.env.NODE_ENV==="production"&&!databaseCa){
    throw new Error("SLOPTOGETHER_DATABASE_SSL_CA is required for verified Clips.gg database TLS.");
  }
  if(databaseCa&&!databaseCa.includes("-----BEGIN CERTIFICATE-----"))throw new Error("SLOPTOGETHER_DATABASE_SSL_CA must contain the Supabase CA certificate.");
  const connectionUrl=new URL(connectionString);
  if(databaseCa)connectionUrl.searchParams.delete("sslmode");

  return new Pool({
    connectionString:databaseCa?connectionUrl.toString():connectionString,
    ...(databaseCa?{ssl:{ca:databaseCa,rejectUnauthorized:true}}:{}),
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 8_000,
    application_name: applicationName,
  });
}

export function pool(): Pool {
  if (!globalThis.__sloptogetherPool) {
    globalThis.__sloptogetherPool = createPool();
  }
  return globalThis.__sloptogetherPool;
}

export function lifecyclePool():Pool{
  if(!globalThis.__sloptogetherLifecyclePool)globalThis.__sloptogetherLifecyclePool=createPool(8,"sloptogether-eventsub-lifecycle");
  return globalThis.__sloptogetherLifecyclePool;
}

export function query<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<Row>> {
  return pool().query<Row>(text, [...values]);
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  let destroyed = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '8s'");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Keep the original error; the client is discarded if PostgreSQL is gone.
      client.release(true);
      destroyed = true;
      throw error;
    }
    throw error;
  } finally {
    if (!destroyed) client.release();
  }
}

export async function transactionOnClient<T>(client:PoolClient,work:(client:PoolClient)=>Promise<T>):Promise<T>{
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout = '8s'");
  try{
    const result=await work(client);
    await client.query("COMMIT");
    return result;
  }catch(error){
    try{await client.query("ROLLBACK")}catch{throw new TransactionCleanupError(error)}
    throw error;
  }
}

export class TransactionCleanupError extends Error{
  constructor(readonly original:unknown){super("The database transaction could not be rolled back safely.");this.name="TransactionCleanupError";}
}

export function publicAppUrl(): URL {
  const configured = process.env.PUBLIC_APP_URL;
  if (!configured) throw new Error("PUBLIC_APP_URL is not configured");
  const url = new URL(configured);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("PUBLIC_APP_URL must use HTTPS outside localhost");
  }
  if (!url.pathname.endsWith("/sloptogether") && url.hostname !== "localhost") {
    throw new Error("PUBLIC_APP_URL must use the /sloptogether base path");
  }
  return url;
}
