import { createHash,randomBytes,randomUUID } from "node:crypto";
import { chmod,readFile,stat,unlink,writeFile } from "node:fs/promises";
import pg from "pg";
import { assertLocalDemoDatabase,assertLocalDemoEnvironment } from "./local-demo-guard.mjs";

const {Pool}=pg;
const channelId="900000001";
const login="localdemo";
const workerEnvPath="/tmp/sloptogether-story-worker.env";
const databaseUrl=process.env.DATABASE_URL;
const storageUrl=process.env.SLOPTOGETHER_LOCAL_S3_ENDPOINT;
const publicUrl=process.env.PUBLIC_APP_URL;
assertLocalDemoEnvironment({nodeEnv:process.env.NODE_ENV,databaseUrl,storageUrl,publicUrl});
const pepper=process.env.SLOPTOGETHER_KEY_HASH_PEPPER;
if(!pepper||pepper.length<32)throw new Error("local_demo_worker_key_pepper_required");

function parseWorkerKey(value){
  const match=/^slw_([0-9a-f-]{36})\.([A-Za-z0-9_-]{32,})$/.exec(value);
  return match?{id:match[1],hash:createHash("sha256").update(pepper).update("\0").update(value).digest()}:null;
}

const pool=new Pool({connectionString:databaseUrl,max:1,application_name:"sloptogether-local-story-worker-seed"});
try{
  const identity=await pool.query(`SELECT current_database() AS database_name,current_setting('data_directory') AS data_directory,
    host(inet_server_addr()) AS server_address,inet_server_port() AS server_port`);
  assertLocalDemoDatabase(identity.rows[0]??{});
  const channel=await pool.query(`SELECT owner_twitch_user_id,policy_revision FROM sloptogether.channels
    WHERE twitch_channel_id=$1 AND twitch_login=$2 AND is_enabled`,[channelId,login]);
  if(!channel.rowCount||channel.rows[0].owner_twitch_user_id!==channelId)throw new Error("local_demo_channel_fixture_missing");

  let workerKey="";
  try{
    const info=await stat(workerEnvPath);
    if(!info.isFile()||(info.mode&0o077)!==0)throw new Error("local_story_worker_key_file_permissions_invalid");
    const saved=(await readFile(workerEnvPath,"utf8")).split(/\r?\n/).find(line=>line.startsWith("SLOPTOGETHER_WORKER_KEY="));
    workerKey=saved?.slice("SLOPTOGETHER_WORKER_KEY=".length)??"";
  }catch(error){if(error?.code!=="ENOENT")throw error;}

  if(workerKey){
    const parsed=parseWorkerKey(workerKey);
    const existing=parsed&&await pool.query(`SELECT 1 FROM sloptogether.application_keys k
      JOIN sloptogether.trusted_executions te ON te.key_id=k.key_id
      WHERE k.key_id=$1 AND k.twitch_channel_id=$2 AND k.issuing_twitch_user_id=$2 AND k.secret_hash=$3
        AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())
        AND k.scopes @> ARRAY['story:write_future']::text[] AND te.execution_role='story_producer'
        AND te.revoked_at IS NULL`,[parsed.id,channelId,parsed.hash]);
    if(!existing?.rowCount)throw new Error("local_story_worker_key_file_is_stale");
    console.log(JSON.stringify({channel:login,workerEnvPath,role:"story-producer",keyStatus:"already_issued",localOnly:true}));
  }else{
    const active=await pool.query(`SELECT 1 FROM sloptogether.application_keys
      WHERE twitch_channel_id=$1 AND display_name='Local demo story producer' AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at>now()) LIMIT 1`,[channelId]);
    if(active.rowCount)throw new Error("local_story_worker_key_file_missing");
    const id=randomUUID();
    workerKey=`slw_${id}.${randomBytes(32).toString("base64url")}`;
    const secretHash=createHash("sha256").update(pepper).update("\0").update(workerKey).digest();
    const client=await pool.connect();
    let keyCreated=false;
    try{
      await client.query("BEGIN");
      const current=await client.query("SELECT owner_twitch_user_id,policy_revision FROM sloptogether.channels WHERE twitch_channel_id=$1 AND twitch_login=$2 AND is_enabled FOR UPDATE",[channelId,login]);
      if(!current.rowCount||current.rows[0].owner_twitch_user_id!==channelId)throw new Error("local_demo_channel_fixture_missing");
      await client.query(`INSERT INTO sloptogether.application_keys
        (key_id,secret_hash,key_prefix,issuing_twitch_user_id,twitch_channel_id,display_name,scopes,worker_roles,recipe_ids,expires_at)
        VALUES($1,$2,$3,$4,$4,'Local demo story producer',ARRAY['story:write_future'],ARRAY[]::text[],ARRAY[]::text[],now()+interval '8 hours')`,
      [id,secretHash,`slw_${id}`,channelId]);
      await client.query(`INSERT INTO sloptogether.trusted_executions
        (twitch_channel_id,key_id,issuer_twitch_user_id,execution_role,recipe_ids,policy_revision)
        VALUES($1,$2,$3,'story_producer',ARRAY[]::text[],$4)`,
      [channelId,id,channelId,current.rows[0].policy_revision]);
      await client.query(`INSERT INTO sloptogether.audit_log
        (twitch_channel_id,actor_twitch_user_id,actor_key_id,action,target_kind,target_id,after_state)
        VALUES($1,$2,$3,'local_demo.story_producer_key','application_key',$4,$5::jsonb)`,
      [channelId,channelId,id,id,JSON.stringify({localOnly:true,scopes:["story:write_future"],expiresInHours:8})]);
      await client.query("COMMIT");
      keyCreated=true;
    }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}

    const envFile=[
      `SLOPTOGETHER_WORKER_KEY=${workerKey}`,
      "SLOPTOGETHER_API_BASE_URL=http://localhost:3000/sloptogether/api/v1",
      "SLOPTOGETHER_WORKER_ROLE=story-producer",
      "SLOPTOGETHER_WORKER_PLATFORM=linux",
      `SLOPTOGETHER_CHANNEL_ID=${channelId}`,
      "SLOPTOGETHER_WORKER_HOME=/tmp/sloptogether-local-story-worker",
      "",
    ].join("\n");
    try{
      await writeFile(workerEnvPath,envFile,{mode:0o600,flag:"wx"});
      await chmod(workerEnvPath,0o600);
    }catch(error){
      if(keyCreated)await pool.query("UPDATE sloptogether.application_keys SET revoked_at=now(),key_revision=key_revision+1 WHERE key_id=$1 AND revoked_at IS NULL",[id]).catch(()=>undefined);
      await pool.query("UPDATE sloptogether.trusted_executions SET revoked_at=now() WHERE key_id=$1 AND revoked_at IS NULL",[id]).catch(()=>undefined);
      throw error;
    }
    console.log(JSON.stringify({channel:login,workerEnvPath,role:"story-producer",keyStatus:"issued",expiresInHours:8,planner:"template unless OPENAI_API_KEY is explicitly supplied",localOnly:true}));
  }
}finally{await pool.end();}
