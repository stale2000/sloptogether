import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";
import { queueSnapshot } from "../src/queue-health.mjs";

const testUrl=process.env.SLOPTOGETHER_PUBLISHER_HEALTH_TEST_URL;
const marker=process.env.SLOPTOGETHER_PUBLISHER_HEALTH_TEST_MARKER;
let pool;
after(async()=>{if(pool)await pool.end();});

test("queue health excludes scheduled and delivered work and detects retries",{skip:!testUrl},async()=>{
  const url=new URL(testUrl);
  if(url.protocol!=="postgresql:"||url.hostname!=="127.0.0.1"||url.port!=="56432"||url.username!=="postgres"||url.password||url.search||url.hash
    ||!/^\/sloptogether_publisher_health_[a-f0-9]{16}$/.test(url.pathname)||!marker||!/^[a-f0-9]{48}$/.test(marker))
    throw new Error("publisher_health_requires_guarded_scratch_database");
  pool=new pg.Pool({connectionString:testUrl,max:1,connectionTimeoutMillis:3000});
  const identity=await pool.query(`SELECT current_database() AS name,current_setting('data_directory') AS path,
    host(inet_server_addr()) AS host,inet_server_port() AS port,
    (SELECT marker FROM public.sloptogether_publisher_health_test_guard LIMIT 1) AS marker`);
  assert.deepEqual(identity.rows[0],{name:url.pathname.slice(1),path:"/tmp/sloptogether-pg",host:"127.0.0.1",port:56432,marker});
  await pool.query(`INSERT INTO sloptogether.outbox(event_kind,available_at,leased_until,attempts,delivered_at) VALUES
    ('media.validate',now()-interval '1000 seconds',NULL,0,NULL),
    ('media.publish_requested',now()-interval '2 seconds',now()+interval '5 minutes',1,NULL),
    ('media.validate',now()+interval '1 day',NULL,0,NULL),
    ('media.validate',now()+interval '10 minutes',NULL,6,NULL),
    ('media.validate',now()-interval '1 day',NULL,0,now()),
    ('paid.turbo.dispatch',now()-interval '1 day',NULL,0,NULL)`);
  const first=await queueSnapshot(pool,true,900,5);
  assert.equal(first.due,2);
  assert.equal(first.leased,1);
  assert.equal(first.retryingAtLimit,1);
  assert.ok(first.oldestDueSeconds>=1000);
  assert.equal(first.healthy,false);
  await pool.query("UPDATE sloptogether.outbox SET delivered_at=now() WHERE attempts>=5 OR available_at<now()-interval '900 seconds'");
  const recovered=await queueSnapshot(pool,true,900,5);
  assert.equal(recovered.due,1);
  assert.equal(recovered.retryingAtLimit,0);
  assert.equal(recovered.healthy,true);
});
