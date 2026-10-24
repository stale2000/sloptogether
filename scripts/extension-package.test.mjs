import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("packages exactly the Twitch Extension assets with CDN-safe paths", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sloptogether-extension-"));
  const output = path.join(directory, "extension.zip");
  try {
    const result = execFileSync("python3.12", [
      "scripts/package-twitch-extension.py", "--output", output,
    ], { encoding: "utf8" });
    assert.match(result, /Extension ZIP ready:/);
    assert.match(result, /\(\d+ bytes\)/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("refuses to overwrite a source asset", () => {
  const entry = "apps/web/public/extension/index.html";
  const before = readFileSync(entry);
  assert.throws(() => execFileSync("python3.12", [
    "scripts/package-twitch-extension.py", "--output", entry,
  ], { encoding: "utf8" }), error => error.status !== 0);
  assert.deepEqual(readFileSync(entry), before);
});
