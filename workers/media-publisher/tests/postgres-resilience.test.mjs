import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { databaseRetryDelayMs, observePoolErrors } from "../src/index.mjs";

test("handles transient errors from idle PostgreSQL clients without an unhandled error", () => {
  const pool = new EventEmitter();
  const entries = [];
  observePoolErrors(pool, { error: (entry) => entries.push(JSON.parse(entry)) });

  assert.doesNotThrow(() => {
    pool.emit("error", Object.assign(new Error("TLS read failed with private connection details"), { code: "EADDRNOTAVAIL" }));
  });
  assert.deepEqual(entries, [{
    event: "media_validator_database_connection_error",
    code: "EADDRNOTAVAIL",
  }]);
});

test("database retry delay backs off and remains capped", () => {
  assert.equal(databaseRetryDelayMs(1), 1_000);
  assert.equal(databaseRetryDelayMs(2), 2_000);
  assert.equal(databaseRetryDelayMs(3), 4_000);
  assert.equal(databaseRetryDelayMs(20), 30_000);
  assert.equal(databaseRetryDelayMs(0), 1_000);
});
