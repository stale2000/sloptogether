import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { assertLocalDemoDatabase } from "./local-demo-guard.mjs";

/** Validate the dedicated local test server before creating or dropping a DB. */
export function assertBitsLocalServer(identity) {
  assertLocalDemoDatabase(identity);
}

/** Validate the scratch database and a per-run marker before writing fixtures. */
export function assertBitsScratchDatabase(identity, expectedName, expectedMarker) {
  if (!/^sloptogether_bits_test_[a-f0-9]{16}$/.test(expectedName)
    || !/^[a-f0-9]{48}$/.test(expectedMarker)
    || identity?.databaseName !== expectedName || identity?.guardMarker !== expectedMarker) {
    throw new Error("bits_scratch_database_identity_not_allowed");
  }
  assertLocalDemoDatabase({ ...identity, databaseName: "sloptogether" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const identity = JSON.parse(readFileSync(0, "utf8"));
  if (process.argv[2] === "scratch") assertBitsScratchDatabase(identity, process.argv[3], process.argv[4]);
  else if (process.argv[2] === undefined) assertBitsLocalServer(identity);
  else throw new Error("bits_database_guard_mode_invalid");
}
